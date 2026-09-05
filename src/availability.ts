/**
 * Availability — the checks that decide whether someone can be USED, as
 * distinct from whether the assignment would be legal.
 *
 * The answer keys treat these as exclusions alongside the seven rules, but
 * they are not rules: they carry no rule id in the key's reason strings
 * (RULE-QUAL-05 does, "reserve on-call window ..." does not), and they have
 * no row in rule_params. Keeping them separate means `rules_checked[]` stays
 * exactly the seven the regulator defined.
 *
 * Three things make a candidate unusable:
 *   1. they are not active (leave / training)
 *   2. they ARE the vacancy
 *   3. they are a reserve whose on-call window does not cover the report time
 */
import { getDb } from './db';

export interface AvailabilityCheck {
    check: 'status' | 'is_vacancy' | 'reserve_window';
    available: boolean;
    reason: string;
}

/** reserve | dayoff | rostered — also what picks the callout rate. */
export type CandidateSource = 'reserve' | 'dayoff' | 'rostered';

export function sourceFor(crewId: string, date: string): CandidateSource {
    const db = getDb();
    const onReserve = db.prepare(
        `SELECT 1 FROM reserve_dates WHERE crew_id = ? AND date = ?`).get(crewId, date);
    if (onReserve) return 'reserve';

    const rostered = db.prepare(
        `SELECT 1 FROM pairing_crew pc
         JOIN pairing_days pd ON pd.pairing_id = pc.pairing_id
         WHERE pc.crew_id = ? AND pd.date = ?`).get(crewId, date);
    return rostered ? 'rostered' : 'dayoff';
}

/**
 * A reserve may only be called out if the REQUIRED REPORT TIME falls inside
 * their on-call window.
 *
 * ⚠ Two traps, both of which the answer keys settle against the prose:
 *
 * 1. `reserves.note` and rules.json say the *callout* time must fall in the
 *    window. generate.py and every answer key use the *required report* time.
 *    Follow the implementation - S2 excludes C-3305 with "on-call window
 *    00:00-05:30Z does not cover required report 06:00Z", which is the report,
 *    not the 05:00Z callout.
 *
 * 2. The report time is the one AFTER any deadhead positioning, so this must
 *    be evaluated after RULE-BASE-07 has moved it. Pass the adjusted time.
 *
 * Non-reserves are unaffected: a day-off callout has no window.
 */
export function checkReserveWindow(
    crewId: string, date: string, requiredReportUtc: string,
): AvailabilityCheck {
    const db = getDb();
    const reserve = db.prepare(
        `SELECT oncall_start, oncall_end FROM reserves WHERE crew_id = ?`
    ).get(crewId) as { oncall_start: string; oncall_end: string } | undefined;

    if (!reserve) {
        return { check: 'reserve_window', available: true, reason: 'Not a reserve; no on-call window applies.' };
    }

    const onToday = db.prepare(
        `SELECT 1 FROM reserve_dates WHERE crew_id = ? AND date = ?`).get(crewId, date);
    if (!onToday) {
        return {
            check: 'reserve_window', available: false,
            reason: `reserve ${crewId} is not on call on ${date}`,
        };
    }

    // Compare clock times, not instants: the window is a daily 00:00-05:30
    // pattern, not a date range.
    const hhmm = requiredReportUtc.slice(11, 16);
    const { oncall_start: start, oncall_end: end } = reserve;
    // A window that wraps midnight (e.g. 22:00-06:00) covers either side.
    const covers = start <= end
        ? hhmm >= start && hhmm <= end
        : hhmm >= start || hhmm <= end;

    return covers
        ? { check: 'reserve_window', available: true, reason: `on-call ${start}-${end}Z covers report ${hhmm}Z.` }
        : {
            check: 'reserve_window', available: false,
            reason: `reserve on-call window ${start}-${end}Z does not cover required report ${hhmm}Z`,
        };
}

/** active / leave / training. Only active crew are assignable. */
export function checkStatus(crewId: string): AvailabilityCheck {
    const row = getDb().prepare(
        `SELECT status FROM crew WHERE crew_id = ?`).get(crewId) as { status: string } | undefined;
    if (!row) return { check: 'status', available: false, reason: `${crewId} not found.` };
    return row.status === 'active'
        ? { check: 'status', available: true, reason: 'active.' }
        : { check: 'status', available: false, reason: `status ${row.status}` };
}

/** The person being replaced cannot replace themselves. */
export function checkNotTheVacancy(crewId: string, vacancyCrewId?: string): AvailabilityCheck {
    return crewId === vacancyCrewId
        ? { check: 'is_vacancy', available: false, reason: 'is the crew member being replaced' }
        : { check: 'is_vacancy', available: true, reason: 'not the vacancy.' };
}
