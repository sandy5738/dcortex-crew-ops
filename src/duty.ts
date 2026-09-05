/**
 * Duty period derivation — the arithmetic the rules engine used to demand as
 * input.
 *
 * RULE-FDP-01, RULE-DUTY-02 and RULE-FLT-03 all take an hours figure. Nothing
 * computed it, so the caller supplied it — and once an LLM is the caller, that
 * means the model computing `06:00 -> 15:30 = 9.5h` and feeding its own answer
 * into a deterministic rule. The rule would then faithfully evaluate a
 * hallucinated number. Everything here exists so that cannot happen.
 *
 * Source of the convention, data/rules.json definitions.duty_period:
 *
 *   "report_utc to release_utc. Report = first departure minus 60 min;
 *    release = last arrival plus 30 min."
 *
 * pairing_days stores report/release for the roster AS PLANNED. Those columns
 * are useless the moment anything moves - a delay, a station closure, a
 * proposed cover - so they are never read here. `npm run verify` proves the
 * derivation reproduces all 42 stored rows exactly, which is what makes it
 * safe to ignore them.
 */
import { getDb } from './db';

/** From rules.json definitions.duty_period. Not in rule_params - the
 *  convention is prose there, so it is asserted against the roster instead. */
export const REPORT_BEFORE_FIRST_DEP_MIN = 60;
export const RELEASE_AFTER_LAST_ARR_MIN = 30;

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

const shift = (iso: string, minutes: number): string =>
    new Date(Date.parse(iso) + minutes * MIN_MS).toISOString().replace('.000Z', 'Z');

export interface DutyPeriod {
    pairing_id: string;
    date: string;
    report_utc: string;
    release_utc: string;
    /** release - report, in hours. What RULE-FDP-01 and RULE-DUTY-02 need. */
    duty_hours: number;
    /** Leg count. Drives the FDP reduction and nothing else. */
    sectors: number;
    /** Engines-on to engines-off. What RULE-FLT-03 needs - NOT duty_hours. */
    block_hours: number;
    flights: string[];
    aircraft: string;
    /** From flights, not from pairings.aircraft, which is a tail number. */
    aircraft_type: string;
    /** First departure station - what RULE-BASE-07 compares the crew base to. */
    dep_station: string;
    arr_station: string;
    /** Passengers exposed if this day is not covered. */
    seats: number;
}

export interface DelayOptions {
    delayHours: number;
    /**
     * How the delay lands on the duty period. The distinction decides whether
     * an FDP breach exists at all, so it is explicit rather than assumed.
     *
     * 'extend' (default) — the crew reports on schedule and waits. Report is
     *   unchanged, the legs and release move later, so the duty grows by the
     *   full delay. This is S4: a 90-minute technical delay takes a 11.25h
     *   duty to 12.75h against a 12.0h limit (4 sectors) — a breach, and
     *   exactly what the answer key states.
     *
     * 'shift' — the whole duty is re-planned later, report included, as when
     *   a station closure pushes departures out of a blocked window. Duty
     *   LENGTH is unchanged; only its position moves, which is what
     *   RULE-REST-04 and the reserve on-call window care about.
     */
    mode?: 'extend' | 'shift';
}

/**
 * The duty period for one pairing-day, derived from its flights.
 *
 * Pass `delay` to model a disruption. A uniform shift does NOT create an FDP
 * breach — the duty is the same length in a different place — so getting the
 * mode wrong silently loses S4's whole point.
 */
export function deriveDuty(
    pairingId: string, date: string, delay?: DelayOptions | number,
): DutyPeriod | null {
    const legs = getDb().prepare(
        `SELECT f.flight_id, f.dep_utc, f.arr_utc, f.block_hours, f.aircraft,
                f.aircraft_type, f.dep_station, f.arr_station, f.seats
         FROM pairing_day_flights pdf
         JOIN flights f ON f.flight_id = pdf.flight_id
         WHERE pdf.pairing_id = ? AND pdf.date = ?
         ORDER BY pdf.seq`
    ).all(pairingId, date) as any[];

    if (legs.length === 0) return null;

    const opts: DelayOptions = typeof delay === 'number'
        ? { delayHours: delay } : (delay ?? { delayHours: 0 });
    const delayMin = (opts.delayHours ?? 0) * 60;
    const mode = opts.mode ?? 'extend';

    const firstDep = legs.reduce((a, l) => (l.dep_utc < a ? l.dep_utc : a), legs[0].dep_utc);
    const lastArr = legs.reduce((a, l) => (l.arr_utc > a ? l.arr_utc : a), legs[0].arr_utc);

    // Both modes move the flying. Only 'shift' moves the report with it.
    const reportOffset = mode === 'shift' ? delayMin : 0;
    const report_utc = shift(firstDep, reportOffset - REPORT_BEFORE_FIRST_DEP_MIN);
    const release_utc = shift(lastArr, delayMin + RELEASE_AFTER_LAST_ARR_MIN);

    return {
        pairing_id: pairingId,
        date,
        report_utc,
        release_utc,
        duty_hours: r2((Date.parse(release_utc) - Date.parse(report_utc)) / HOUR_MS),
        sectors: legs.length,
        block_hours: r2(legs.reduce((n, l) => n + l.block_hours, 0)),
        flights: legs.map(l => l.flight_id),
        aircraft: legs[0].aircraft,
        aircraft_type: legs[0].aircraft_type,
        dep_station: legs[0].dep_station,
        arr_station: legs[legs.length - 1].arr_station,
        seats: legs.reduce((n, l) => n + l.seats, 0),
    };
}

/** Every day of a pairing, in date order. A cover is the whole thing. */
export function derivePairing(
    pairingId: string, delay?: DelayOptions | number,
): DutyPeriod[] {
    const dates = getDb().prepare(
        `SELECT date FROM pairing_days WHERE pairing_id = ? ORDER BY date`
    ).all(pairingId) as { date: string }[];

    return dates
        .map(d => deriveDuty(pairingId, d.date, delay))
        .filter((d): d is DutyPeriod => d !== null);
}

/**
 * Max FDP for a sector count. 13h base, less 0.5h per sector beyond the 2nd.
 * Params from the rules table, so a regulator change is a data change.
 */
export function fdpLimit(sectors: number): number {
    const p = getDb().prepare(
        `SELECT param_key, value_num FROM rule_params WHERE rule_id = 'RULE-FDP-01'`
    ).all() as { param_key: string; value_num: number }[];
    const get = (k: string) => {
        const row = p.find(x => x.param_key === k);
        if (!row) throw new Error(`RULE-FDP-01 parameter "${k}" missing; re-run the ingest.`);
        return row.value_num;
    };
    return r2(get('base_fdp_hours') -
        Math.max(0, sectors - get('free_sectors')) * get('reduction_per_extra_sector_hours'));
}

/** Which pairing-day a crew member is rostered on, if any. */
export function dutyForCrew(crewId: string, date: string): DutyPeriod | null {
    const row = getDb().prepare(
        `SELECT pd.pairing_id FROM pairing_crew pc
         JOIN pairing_days pd ON pd.pairing_id = pc.pairing_id
         WHERE pc.crew_id = ? AND pd.date = ?`
    ).get(crewId, date) as { pairing_id: string } | undefined;
    return row ? deriveDuty(row.pairing_id, date) : null;
}
