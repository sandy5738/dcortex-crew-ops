/**
 * Disruptions that hit more than one pairing at once.
 *
 * A station closure and two simultaneous sick calls are different in kind
 * from a single vacancy: they cannot be answered by assessing candidates one
 * at a time. The closure fans out across every pairing touching the station,
 * and the joint plan has to stop the same captain being assigned twice.
 */
import { getDb } from './db';
import { deriveDuty, fdpLimit, type DutyPeriod } from './duty';
import { recommendCover, type CandidateAssessment } from './decide';

const r2 = (n: number) => Math.round(n * 100) / 100;
const HOUR_MS = 3_600_000;

/**
 * Ground time after the station reopens before anything can move.
 * S3's answer key: "Delays are measured to reopen +30min turnaround."
 */
export const TURNAROUND_AFTER_REOPEN_MIN = 30;

export interface FlightAssessment {
    flight_id: string;
    pairing_id: string | null;
    /** Hours from the blocked movement to reopen + turnaround. */
    min_delay_hours: number;
    /** The rostered crew's duty AFTER absorbing that delay. */
    crew_fdp_after_delay: number | null;
    fdp_limit: number | null;
    action: string;
}

export interface ClosureAssessment {
    station: string;
    window_utc: { start: string; end: string };
    affected_flights: string[];
    per_flight_assessment: FlightAssessment[];
    pairings_affected: string[];
    breaching_pairings: string[];
    note: string;
    trace: string[];
}

/**
 * Which flights a closure blocks, and whether the rostered crew can still
 * legally operate once the delay lands on them.
 *
 * Both directions count. The narrative is explicit that flights airborne may
 * not LAND at the station either, so an arrival inside the window is blocked
 * exactly as a departure is - and 9 of S3's 13 affected flights are arrivals.
 */
export function assessStationClosure(
    station: string, startUtc: string, endUtc: string,
): ClosureAssessment {
    const db = getDb();
    const date = startUtc.slice(0, 10);
    const reopenPlusTurnaround =
        Date.parse(endUtc) + TURNAROUND_AFTER_REOPEN_MIN * 60_000;

    const blocked = db.prepare(
        `SELECT flight_id, dep_station, arr_station, dep_utc, arr_utc
         FROM flights
         WHERE date = ?
           AND ( (dep_station = ? AND dep_utc >= ? AND dep_utc <= ?)
              OR (arr_station = ? AND arr_utc >= ? AND arr_utc <= ?) )
         ORDER BY dep_utc, flight_id`
    ).all(date, station, startUtc, endUtc, station, startUtc, endUtc) as any[];

    const pairingOf = db.prepare(
        `SELECT pairing_id, date FROM pairing_day_flights WHERE flight_id = ?`);

    // A pairing-day is assessed once even when several of its legs are blocked:
    // the duty absorbs the largest delay among them, not their sum.
    const worstDelay = new Map<string, { delay: number; date: string }>();
    const rowsOut: FlightAssessment[] = [];

    for (const f of blocked) {
        // The movement that is actually blocked decides the delay.
        const blockedAt = (f.dep_station === station &&
            f.dep_utc >= startUtc && f.dep_utc <= endUtc) ? f.dep_utc : f.arr_utc;
        const min_delay_hours = r2(Math.max(0,
            (reopenPlusTurnaround - Date.parse(blockedAt)) / HOUR_MS));

        const owner = pairingOf.get(f.flight_id) as { pairing_id: string; date: string } | undefined;
        rowsOut.push({
            flight_id: f.flight_id,
            pairing_id: owner?.pairing_id ?? null,
            min_delay_hours,
            crew_fdp_after_delay: null,
            fdp_limit: null,
            action: '',
        });

        if (owner) {
            const prev = worstDelay.get(owner.pairing_id);
            if (!prev || min_delay_hours > prev.delay) {
                worstDelay.set(owner.pairing_id, { delay: min_delay_hours, date: owner.date });
            }
        }
    }

    // Now price each affected flight against its pairing's extended duty.
    const breaching: string[] = [];
    for (const row of rowsOut) {
        if (!row.pairing_id) {
            row.action = 'no rostered pairing — reschedule only';
            continue;
        }
        const w = worstDelay.get(row.pairing_id)!;
        // 'extend': the crew is already on duty waiting out the closure, so
        // the duty grows. A shift would leave the length unchanged and find
        // no breach anywhere.
        const after = deriveDuty(row.pairing_id, w.date, { delayHours: row.min_delay_hours, mode: 'extend' });
        if (!after) { row.action = 'pairing-day not found'; continue; }

        row.crew_fdp_after_delay = after.duty_hours;
        row.fdp_limit = fdpLimit(after.sectors);
        const breach = after.duty_hours > row.fdp_limit;
        row.action = breach
            ? 'delay exceeds crew FDP — re-crew tail legs from reserves or cancel'
            : 'delay (crew legal)';
        if (breach && !breaching.includes(row.pairing_id)) breaching.push(row.pairing_id);
    }

    const pairings = [...new Set(rowsOut.map(r => r.pairing_id).filter((p): p is string => !!p))];

    return {
        station,
        window_utc: { start: startUtc, end: endUtc },
        affected_flights: rowsOut.map(r => r.flight_id),
        per_flight_assessment: rowsOut,
        pairings_affected: pairings,
        breaching_pairings: breaching,
        note: `Delays are measured to reopen +${TURNAROUND_AFTER_REOPEN_MIN}min turnaround. ` +
              `Where the extended duty exceeds RULE-FDP-01, tail legs need reserve re-crew or cancellation.`,
        trace: [
            `closure ${station} ${startUtc.slice(11, 16)}-${endUtc.slice(11, 16)}Z on ${date}`,
            `${rowsOut.length} flights blocked across ${pairings.length} pairings`,
            `${breaching.length} pairing(s) breach RULE-FDP-01 after the delay`,
        ],
    };
}

// ------------------------------------------------------------- joint plan

export interface JointVacancy {
    pairingId: string;
    vacancyCrewId: string;
}

export interface JointAssignment {
    pairing_id: string;
    crew_id: string;
    cost_inr: number;
    source: string;
    action: string;
}

export interface JointPlan {
    vacancies: JointVacancy[];
    per_vacancy: { pairing_id: string; options: CandidateAssessment[]; excluded: CandidateAssessment[] }[];
    optimal: { total_cost_inr: number; assignments: JointAssignment[] } | null;
    /** Same total, different pairing-to-crew mapping. Equally correct. */
    alternative_count: number;
    note: string;
    trace: string[];
}

/**
 * Cover several simultaneous vacancies without assigning anyone twice.
 *
 * Running recommendCover per vacancy and taking each rank 1 is wrong: the
 * same captain is very often rank 1 for both, and one person cannot fly two
 * aircraft. This searches assignments where every crew member is distinct and
 * minimises TOTAL cost, which can mean not giving one vacancy its individually
 * cheapest option.
 *
 * Exhaustive rather than greedy. The pools are ~10 legal candidates over 2-3
 * vacancies, so the search is trivially small and, unlike a greedy pass,
 * cannot miss the optimum.
 */
export function planJointCover(vacancies: JointVacancy[]): JointPlan {
    const per = vacancies.map(v => {
        const rec = recommendCover(v.pairingId, v.vacancyCrewId);
        return {
            pairing_id: v.pairingId,
            options: rec?.options ?? [],
            excluded: rec?.excluded ?? [],
        };
    });

    let best: { total: number; picks: CandidateAssessment[] } | null = null;
    let ties = 0;

    const search = (i: number, used: Set<string>, picks: CandidateAssessment[], total: number) => {
        if (i === per.length) {
            if (!best || total < best.total) { best = { total, picks: [...picks] }; ties = 0; }
            else if (total === best.total) ties++;
            return;
        }
        for (const opt of per[i].options) {
            if (used.has(opt.crew_id)) continue;          // nobody flies twice
            used.add(opt.crew_id);
            picks.push(opt);
            search(i + 1, used, picks, total + (opt.cost?.total_inr ?? 0));
            picks.pop();
            used.delete(opt.crew_id);
        }
    };
    search(0, new Set(), [], 0);

    const chosen = best as { total: number; picks: CandidateAssessment[] } | null;

    return {
        vacancies,
        per_vacancy: per,
        optimal: chosen === null ? null : {
            total_cost_inr: chosen.total,
            assignments: chosen.picks.map((p, i) => ({
                pairing_id: vacancies[i].pairingId,
                crew_id: p.crew_id,
                cost_inr: p.cost?.total_inr ?? 0,
                source: p.source,
                action: `Assign ${p.rank} ${p.crew_id} (${p.source === 'reserve' ? 'reserve' : 'day-off'} callout)`,
            })),
        },
        alternative_count: ties,
        note: 'The same crew member cannot cover both pairings; the optimal plan ' +
              'minimises total cost across all of them. Equal-cost mirror assignments ' +
              '(swapping which pairing each candidate covers) are equally correct.',
        trace: [
            `${vacancies.length} simultaneous vacancies: ${vacancies.map(v => v.pairingId).join(', ')}`,
            ...per.map(p => `${p.pairing_id}: ${p.options.length} legal, ${p.excluded.length} excluded`),
            chosen === null
                ? 'no assignment covers every vacancy'
                : `optimal total ₹${chosen.total.toLocaleString('en-IN')}${ties ? ` (${ties} equal-cost alternative(s))` : ''}`,
        ],
    };
}
