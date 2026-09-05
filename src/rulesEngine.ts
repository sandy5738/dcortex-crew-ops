import { z } from 'zod';
import { DateTime } from 'luxon';
import { getDb } from './db';

// =================================================================
// TYPES & SCHEMAS
// =================================================================

export interface RuleResult {
    rule_id: string;
    legal: boolean;
    reason: string;
    cost_incurred?: boolean;
    /** Limit from rules.json, so the answer can be challenged. */
    limit?: number;
    actual?: number;
    /** The calendar dates summed, for the window rules. */
    window?: string[];
    /** date -> hours. What the number is actually made of. */
    inputs?: Record<string, number>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real UTC calendar date, not merely something shaped like one.
 *
 * The shape check alone accepts 2026-02-30. Luxon then yields an invalid
 * DateTime whose toISODate() is null, calendarWindow forces those nulls into
 * the window, no history rows match, and the rule reports a confident
 * "Legal. 0h over null..null". Returning a fluent wrong answer for a bad
 * input is the exact failure this engine exists to prevent, so fail closed.
 */
const isoDate = (description: string) =>
    z.string()
        .regex(DATE_RE, 'expected YYYY-MM-DD')
        .refine(s => DateTime.fromISO(s, { zone: 'utc' }).isValid,
                s => ({ message: `${s} is not a real calendar date` }))
        .describe(description);

export const Schemas = {
    FDP01: z.object({
        numSectors: z.number().int().min(1).describe("Number of flight legs"),
        proposedFdpHours: z.number().positive().describe("Proposed total flight duty period in hours")
    }),
    DUTY02: z.object({
        crewId: z.string().describe("Crew ID (e.g., C-1042)"),
        newDutyHours: z.number().positive().describe("Length of new duty in hours"),
        // Required, and deliberately so. The 7-day window is a *calendar*
        // window ending on the duty date, so without this there is no
        // correct answer — only the snapshot-date answer, which is what the
        // previous implementation silently returned.
        dutyDate: isoDate("Date of the new duty, YYYY-MM-DD. The 7-day window ends on this date."),
        priorProposed: z.record(z.string(), z.number()).optional().describe("Earlier days of the SAME multi-day assignment, date -> hours. Needed so day 2 of a pairing counts day 1s proposed duty.")
    }),
    FLT03: z.object({
        crewId: z.string(),
        newFlightHours: z.number().positive(),
        dutyDate: isoDate("Date of the new duty, YYYY-MM-DD. The 28-day window ends on this date."),
        priorProposed: z.record(z.string(), z.number()).optional().describe("Earlier days of the SAME multi-day assignment, date -> hours. Needed so day 2 of a pairing counts day 1s proposed duty.")
    }),
    REST04: z.object({
        crewId: z.string(),
        newReportUtc: z.string().datetime().describe("UTC ISO string of next report time")
    }),
    QUAL05: z.object({
        crewId: z.string(),
        targetAircraftType: z.string().describe("Aircraft type (e.g., A320, ATR72)")
    }),
    CERT06: z.object({
        crewId: z.string(),
        dutyDate: isoDate("Date of duty in YYYY-MM-DD")
    }),
    BASE07: z.object({
        crewId: z.string(),
        requiredDepartureStation: z.string().describe("Station code (e.g., BLR)")
    })
};

// =================================================================
// RULE PARAMETERS — config, not constants
// =================================================================

/**
 * Limits come from the `rules` table, which came from data/rules.json.
 *
 * They are not hardcoded here on purpose: swapping a regulator's limits
 * becomes a data change plus a re-ingest, and the number in the answer can
 * always be traced back to the file it came from. RULE-QUAL-05, CERT-06 and
 * BASE-07 legitimately have no parameters at all.
 */
let paramCache: Record<string, Record<string, number>> | null = null;

export function ruleParams(ruleId: string): Record<string, number> {
    if (!paramCache) {
        paramCache = {};
        const rows = getDb()
            .prepare('SELECT rule_id, param_key, value_num FROM rule_params')
            .all() as { rule_id: string; param_key: string; value_num: number }[];
        for (const r of rows) {
            (paramCache[r.rule_id] ??= {})[r.param_key] = r.value_num;
        }
    }
    return paramCache[ruleId] ?? {};
}

function requireParam(ruleId: string, key: string): number {
    const value = ruleParams(ruleId)[key];
    if (value === undefined) {
        throw new Error(
            `${ruleId} parameter "${key}" is missing from the rules table. ` +
            `Re-run \`npm run ingest\`.`);
    }
    return value;
}

// =================================================================
// CALENDAR-DAY WINDOWS
// =================================================================

/**
 * The N UTC calendar dates ending on `endDate`, inclusive.
 *
 * Note "calendar dates", not a rolling 168 hours — data/rules.json's
 * time_convention is explicit about it, and getting this wrong shifts every
 * window answer by one day's hours.
 */
export function calendarWindow(endDate: string, days: number): string[] {
    const end = DateTime.fromISO(endDate, { zone: 'utc' });
    // Exported, so it is reachable without passing through a Zod schema.
    // Throwing beats the old `toISODate()!`, which asserted away a null and
    // produced a window of nulls that silently matched no history at all.
    if (!end.isValid) {
        throw new Error(
            `calendarWindow: "${endDate}" is not a real calendar date ` +
            `(${end.invalidReason ?? 'invalid'})`);
    }
    const out: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
        out.push(end.minus({ days: i }).toISODate()!);
    }
    return out;
}

/**
 * Per-date hours from duty_daily_history. Absent dates count as zero.
 *
 * `priorProposed` adds earlier days of the SAME proposed assignment, which
 * are not in the database because they have not happened. Without it a
 * multi-day pairing is checked as if each day stood alone: C-3305 is legal
 * for P-2291 day 1 (59.50h) and then reads as legal again on day 2 (58.75h),
 * when in fact day 1's proposed 9.50h lands inside day 2's window and takes
 * the total to 68.25h — a breach. The dataset ships that case deliberately.
 */
function historyOver(
    crewId: string,
    window: string[],
    column: 'duty_hours' | 'flight_hours',
    priorProposed?: Record<string, number>,
): Record<string, number> {
    const rows = getDb().prepare(
        `SELECT date, ${column} AS hours FROM duty_daily_history
         WHERE crew_id = ? AND date BETWEEN ? AND ? ORDER BY date`
    ).all(crewId, window[0], window[window.length - 1]) as
        { date: string; hours: number }[];

    const inputs: Record<string, number> = {};
    for (const d of window) inputs[d] = 0;
    for (const r of rows) inputs[r.date] = r.hours;

    // Additive: a proposed day is extra duty on top of anything already
    // recorded for that date. Dates outside the window are ignored rather
    // than silently widening it.
    for (const [date, hours] of Object.entries(priorProposed ?? {})) {
        if (date in inputs) inputs[date] = round2(inputs[date] + hours);
    }
    return inputs;
}

function crewExists(crewId: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM crew WHERE crew_id = ?').get(crewId);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// =================================================================
// RULES ENGINE (The Deterministic Core)
// =================================================================

export class RulesEngine {

    static checkFdp01(input: z.infer<typeof Schemas.FDP01>): RuleResult {
        const { numSectors, proposedFdpHours } = input;
        const baseFdp = requireParam('RULE-FDP-01', 'base_fdp_hours');
        const reduction = requireParam('RULE-FDP-01', 'reduction_per_extra_sector_hours');
        const freeSectors = requireParam('RULE-FDP-01', 'free_sectors');

        const penaltySectors = Math.max(0, numSectors - freeSectors);
        const maxAllowed = round2(baseFdp - penaltySectors * reduction);
        const legal = proposedFdpHours <= maxAllowed;

        return {
            rule_id: "RULE-FDP-01",
            legal,
            limit: maxAllowed,
            actual: proposedFdpHours,
            reason: legal ? `Legal. ${proposedFdpHours}h <= ${maxAllowed}h`
                          : `Violation. ${proposedFdpHours}h > ${maxAllowed}h limit for ${numSectors} sectors.`
        };
    }

    /**
     * RULE-DUTY-02 — max 60 duty hours in any 7 consecutive calendar days.
     *
     * Sums duty_daily_history over the seven UTC dates ending on the duty
     * date. It does NOT read duty_clocks.duty_hours_7d: that column is a
     * snapshot artifact, correct only for the window ending on the dataset's
     * as_of date (2026-09-14) and wrong for every scenario, which all sit on
     * 2026-09-15 or later.
     */
    static checkDuty02(input: z.infer<typeof Schemas.DUTY02>): RuleResult {
        const { crewId, newDutyHours, dutyDate, priorProposed } = input;
        if (!crewExists(crewId)) {
            return { rule_id: "RULE-DUTY-02", legal: false, reason: "Crew member not found." };
        }

        const limit = requireParam('RULE-DUTY-02', 'max_duty_hours');
        const windowDays = requireParam('RULE-DUTY-02', 'window_days');
        const window = calendarWindow(dutyDate, windowDays);
        const inputs = historyOver(crewId, window, 'duty_hours', priorProposed);

        const prior = round2(Object.values(inputs).reduce((a, b) => a + b, 0));
        const projected = round2(prior + newDutyHours);
        const legal = projected <= limit;

        return {
            rule_id: "RULE-DUTY-02",
            legal,
            limit,
            actual: projected,
            window,
            inputs,
            reason: legal
                ? `Legal. ${prior}h over ${window[0]}..${window[window.length - 1]} + ${newDutyHours}h = ${projected}h (Limit: ${limit}h)`
                : `Violation. ${prior}h + ${newDutyHours}h = ${projected}h exceeds the ${limit}h/${windowDays}d limit by ${round2(projected - limit)}h.`
        };
    }

    /** RULE-FLT-03 — 100 block hours / 28 calendar days. Same shape as DUTY-02. */
    static checkFlt03(input: z.infer<typeof Schemas.FLT03>): RuleResult {
        const { crewId, newFlightHours, dutyDate, priorProposed } = input;
        if (!crewExists(crewId)) {
            return { rule_id: "RULE-FLT-03", legal: false, reason: "Crew member not found." };
        }

        const limit = requireParam('RULE-FLT-03', 'max_flight_hours');
        const windowDays = requireParam('RULE-FLT-03', 'window_days');
        const window = calendarWindow(dutyDate, windowDays);
        const inputs = historyOver(crewId, window, 'flight_hours', priorProposed);

        const prior = round2(Object.values(inputs).reduce((a, b) => a + b, 0));
        const projected = round2(prior + newFlightHours);
        const legal = projected <= limit;

        return {
            rule_id: "RULE-FLT-03",
            legal,
            limit,
            actual: projected,
            window,
            inputs,
            reason: legal
                ? `Legal. ${prior}h over ${window[0]}..${window[window.length - 1]} + ${newFlightHours}h = ${projected}h (Limit: ${limit}h)`
                : `Violation. ${prior}h + ${newFlightHours}h = ${projected}h exceeds the ${limit}h/${windowDays}d limit by ${round2(projected - limit)}h.`
        };
    }

    /**
     * RULE-REST-04 — min 12h rest between release and next report.
     *
     * ⚠ Semantics UNREVIEWED. This is the original implementation, moved onto
     * the shared connection but otherwise untouched: it checks only that the
     * new report is at or after `last_rest_ended`, and never reads
     * min_rest_hours. Whether `last_rest_ended` already has the 12h baked in
     * is exactly the question, and answering it wrong in either direction
     * changes legality, so it is left for whoever owns this rule.
     * min_rest_hours is available via ruleParams('RULE-REST-04').
     */
    static checkRest04(input: z.infer<typeof Schemas.REST04>): RuleResult {
        const { crewId, newReportUtc } = input;
        const row = getDb()
            .prepare("SELECT last_rest_ended FROM duty_clocks WHERE crew_id = ?")
            .get(crewId) as any;
        if (!row || !row.last_rest_ended) {
            return { rule_id: "RULE-REST-04", legal: true, reason: "No previous rest constraint found." };
        }

        const lastRest = DateTime.fromISO(row.last_rest_ended, { zone: 'utc' });
        const newReport = DateTime.fromISO(newReportUtc, { zone: 'utc' });
        const legal = newReport >= lastRest;

        return {
            rule_id: "RULE-REST-04",
            legal,
            reason: legal ? "Legal. Adequate rest achieved." : `Violation. Crew cannot report before ${row.last_rest_ended}.`
        };
    }

    /** RULE-QUAL-05 — reads the crew_ratings table, not a JSON string. */
    static checkQual05(input: z.infer<typeof Schemas.QUAL05>): RuleResult {
        const { crewId, targetAircraftType } = input;
        if (!crewExists(crewId)) {
            return { rule_id: "RULE-QUAL-05", legal: false, reason: "Crew member not found." };
        }

        const ratings = (getDb()
            .prepare('SELECT rating FROM crew_ratings WHERE crew_id = ? ORDER BY seq')
            .all(crewId) as { rating: string }[]).map(r => r.rating);
        const legal = ratings.includes(targetAircraftType);

        return {
            rule_id: "RULE-QUAL-05",
            legal,
            reason: legal ? `Legal. Rated for ${targetAircraftType}.`
                          : `Violation. Crew is rated for ${ratings.join(', ') || 'nothing'}, not ${targetAircraftType}.`
        };
    }

    /**
     * RULE-CERT-06 — all four certifications valid on the duty date.
     *
     * Checks `valid_to` only. `valid_from` in this dataset is generated as
     * valid_to - 730d and never corrected, so some ranges are inverted and a
     * two-sided check grounds the entire roster. Reads the certifications
     * table rather than re-reading certifications.json from disk, so there is
     * one source of truth.
     */
    static checkCert06(input: z.infer<typeof Schemas.CERT06>): RuleResult {
        const { crewId, dutyDate } = input;
        const rows = getDb().prepare(
            `SELECT cert_type, valid_to FROM certifications
             WHERE crew_id = ? AND valid_to < ? ORDER BY valid_to`
        ).all(crewId, dutyDate) as { cert_type: string; valid_to: string }[];

        if (rows.length) {
            const first = rows[0];
            return {
                rule_id: "RULE-CERT-06",
                legal: false,
                reason: `Violation. ${first.cert_type} expired on ${first.valid_to}` +
                        (rows.length > 1 ? ` (and ${rows.length - 1} other lapsed certification(s)).` : '.')
            };
        }
        return { rule_id: "RULE-CERT-06", legal: true, reason: "Legal. All certifications valid." };
    }

    static checkBase07(input: z.infer<typeof Schemas.BASE07>): RuleResult {
        const { crewId, requiredDepartureStation } = input;
        const row = getDb()
            .prepare("SELECT base FROM crew WHERE crew_id = ?")
            .get(crewId) as any;
        if (!row) return { rule_id: "RULE-BASE-07", legal: false, reason: "Crew member not found." };

        if (row.base === requiredDepartureStation) {
            return { rule_id: "RULE-BASE-07", legal: true, cost_incurred: false, reason: `Legal. Crew is at base ${row.base}.` };
        }
        return {
            rule_id: "RULE-BASE-07",
            legal: true,
            cost_incurred: true,
            reason: `Legal but expensive. Deadhead positioning from ${row.base} to ${requiredDepartureStation} required.`
        };
    }
}
