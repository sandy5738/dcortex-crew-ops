/**
 * Tier 2 and Tier 3: can this person cover it, and who should?
 *
 * Two entry points, both fully deterministic:
 *
 *   assessCandidate() — all seven rules plus availability, one call. The LLM
 *     never chooses WHICH rules apply; all seven always do. Exposing them
 *     individually let a model omit one, and the answer keys list all seven in
 *     rules_checked[].
 *
 *   recommendCover()  — enumerate the whole rank, assess, price, rank. One
 *     call rather than the ~196 the model would otherwise sequence, which is
 *     what keeps Tier 3 both fast and reproducible.
 */
import { getDb } from './db';
import { RulesEngine, type RuleResult } from './rulesEngine';
import { derivePairing, type DutyPeriod } from './duty';
import {
    checkNotTheVacancy, checkReserveWindow, checkStatus, sourceFor,
    type AvailabilityCheck, type CandidateSource,
} from './availability';
import { cancellationCost, deadheadDelayHours, priceOption, type CostBreakdown } from './costing';

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CandidateAssessment {
    crew_id: string;
    name: string;
    rank: string;
    base: string;
    source: CandidateSource;
    /** ALWAYS all seven, pass or fail. */
    verdicts: RuleResult[];
    availability: AvailabilityCheck[];
    legal: boolean;
    /** Answer-key shaped: rule ids and details, joined. */
    reason: string;
    cost: CostBreakdown | null;
    coverage: string;
    coverage_fraction: number;
    /** Rest before their own next duty. Amber under 2h even when legal. */
    rest_margin_hours: number | null;
    rank_position?: number;
}

/**
 * Evaluate one crew member against a whole pairing.
 *
 * Multi-day matters twice over. Each day is checked against the cumulative
 * limits with the EARLIER proposed days folded in (`priorProposed`), because
 * day 2's 7-day window contains day 1 and day 1 is not in the database yet.
 * And rest is measured across the whole cover, not per day.
 */
export function assessCandidate(
    crewId: string, pairingId: string, vacancyCrewId?: string,
): CandidateAssessment | null {
    const db = getDb();
    const crew = db.prepare(
        `SELECT crew_id, name, rank, base FROM crew WHERE crew_id = ?`).get(crewId) as any;
    if (!crew) return null;

    const days = derivePairing(pairingId);
    if (days.length === 0) return null;

    const first = days[0];
    const last = days[days.length - 1];
    const source = sourceFor(crewId, first.date);

    // Positioning first: it moves the report time the reserve window is
    // tested against, and adds the delay every later cost depends on.
    const needsPositioning = crew.base !== first.dep_station;
    const deadhead = needsPositioning ? deadheadDelayHours(crew.base, first) : null;
    const effectiveReport = deadhead && deadhead.delayHours > 0
        ? new Date(Date.parse(first.report_utc) + deadhead.delayHours * 3_600_000)
            .toISOString().replace('.000Z', 'Z')
        : first.report_utc;

    const availability: AvailabilityCheck[] = [
        checkStatus(crewId),
        checkNotTheVacancy(crewId, vacancyCrewId),
        checkReserveWindow(crewId, first.date, effectiveReport),
    ];

    // ---- the seven rules, worst day wins for the per-duty ones
    const worstDuty = days.reduce((a, d) => (d.duty_hours > a.duty_hours ? d : a), days[0]);
    const fdp = RulesEngine.checkFdp01({
        numSectors: worstDuty.sectors, proposedFdpHours: worstDuty.duty_hours });

    const proposedDuty: Record<string, number> = {};
    const proposedBlock: Record<string, number> = {};
    let duty: RuleResult | null = null;
    let flt: RuleResult | null = null;
    for (const d of days) {
        const thisDuty = RulesEngine.checkDuty02({
            crewId, newDutyHours: d.duty_hours, dutyDate: d.date,
            priorProposed: { ...proposedDuty } });
        const thisFlt = RulesEngine.checkFlt03({
            crewId, newFlightHours: d.block_hours, dutyDate: d.date,
            priorProposed: { ...proposedBlock } });
        // Keep the first failure, else the last evaluated.
        if (!duty || (duty.legal && !thisDuty.legal)) duty = thisDuty;
        if (!flt || (flt.legal && !thisFlt.legal)) flt = thisFlt;
        proposedDuty[d.date] = d.duty_hours;
        proposedBlock[d.date] = d.block_hours;
    }

    const rest = RulesEngine.checkRest04({
        crewId, newReportUtc: effectiveReport, coverReleaseUtc: last.release_utc });
    const qual = RulesEngine.checkQual05({ crewId, targetAircraftType: first.aircraft_type });
    // The strictest date: a certificate valid on day 1 may lapse before day N.
    const cert = RulesEngine.checkCert06({ crewId, dutyDate: last.date });
    const base = RulesEngine.checkBase07({
        crewId, requiredDepartureStation: first.dep_station });

    const verdicts = [fdp, duty!, flt!, rest, qual, cert, base];

    const ruleFailures = verdicts.filter(v => !v.legal);
    const availFailures = availability.filter(a => !a.available);
    const legal = ruleFailures.length === 0 && availFailures.length === 0;

    const reason = [
        ...ruleFailures.map(v => `${v.rule_id}: ${stripPrefix(v.reason)}`),
        ...availFailures.map(a => a.reason),
    ].join('; ');

    const cost = legal
        ? priceOption({ rank: crew.rank, source, deadhead })
        : null;

    return {
        crew_id: crewId,
        name: crew.name,
        rank: crew.rank,
        base: crew.base,
        source,
        verdicts,
        availability,
        legal,
        reason,
        cost,
        coverage: `all ${days.reduce((n, d) => n + d.sectors, 0)} legs`,
        coverage_fraction: 1,
        rest_margin_hours: rest.inputs?.['rest_before_next_own_duty_h'] ?? null,
    };
}

/** "Violation. RULE-X: detail." -> "detail" */
function stripPrefix(reason: string): string {
    return reason.replace(/^Violation\.\s*/, '').replace(/^RULE-[A-Z]+-\d+:\s*/, '');
}

export interface CoverRecommendation {
    pairing_id: string;
    vacancy_crew_id: string | null;
    role: string | null;
    days: DutyPeriod[];
    uncovered_flights: string[];
    passengers_at_risk: number;
    pool_size: number;
    options: CandidateAssessment[];
    excluded: CandidateAssessment[];
    do_nothing: { total_inr: number; legs: number; seats: number };
    ranking_key: string;
    trace: string[];
}

/**
 * The documented lexicographic key. Printed verbatim in the UI, because cost
 * ties are common (every day-off pilot callout is ₹24,000) and without a
 * stated tiebreak the order among them is arbitrary.
 */
export const RANKING_KEY =
    'ranked by coverage, then cost, then rest margin, then crew id';

function rankOptions(a: CandidateAssessment, b: CandidateAssessment): number {
    if (a.coverage_fraction !== b.coverage_fraction) return b.coverage_fraction - a.coverage_fraction;
    const ac = a.cost?.total_inr ?? Infinity, bc = b.cost?.total_inr ?? Infinity;
    if (ac !== bc) return ac - bc;
    const am = a.rest_margin_hours ?? Infinity, bm = b.rest_margin_hours ?? Infinity;
    if (am !== bm) return bm - am;
    return a.crew_id.localeCompare(b.crew_id);
}

/**
 * Everyone of the required rank, assessed, priced and ranked.
 *
 * The pool is the WHOLE rank - all 28 Captains - not a pre-filtered
 * qualified subset. The answer keys list rating failures as exclusions with
 * reasons, so filtering early loses parity and hides the reject table the
 * controller wants.
 */
export function recommendCover(
    pairingId: string, vacancyCrewId?: string,
): CoverRecommendation | null {
    const db = getDb();
    const days = derivePairing(pairingId);
    if (days.length === 0) return null;

    const role = vacancyCrewId
        ? (db.prepare(`SELECT role FROM pairing_crew WHERE pairing_id = ? AND crew_id = ?`)
            .get(pairingId, vacancyCrewId) as any)?.role ?? null
        : null;
    if (!role) return null;

    const pool = db.prepare(`SELECT crew_id FROM crew WHERE rank = ? ORDER BY crew_id`)
        .all(role) as { crew_id: string }[];

    const assessed = pool
        .map(p => assessCandidate(p.crew_id, pairingId, vacancyCrewId))
        .filter((a): a is CandidateAssessment => a !== null);

    const options = assessed.filter(a => a.legal).sort(rankOptions);
    options.forEach((o, i) => { o.rank_position = i + 1; });
    const excluded = assessed.filter(a => !a.legal);

    return {
        pairing_id: pairingId,
        vacancy_crew_id: vacancyCrewId ?? null,
        role,
        days,
        uncovered_flights: days.flatMap(d => d.flights),
        passengers_at_risk: days[0].seats,
        pool_size: assessed.length,
        options,
        excluded,
        do_nothing: cancellationCost(days),
        ranking_key: RANKING_KEY,
        trace: [
            `resolved vacancy: ${pairingId}, role ${role}, ${days.length} pairing-days, ${days.reduce((n, d) => n + d.sectors, 0)} legs`,
            `enumerated ${assessed.length} candidates of rank ${role}`,
            `evaluated 7 rules x ${assessed.length} candidates = ${assessed.length * 7} checks`,
            `${options.length} legal, ${excluded.length} excluded`,
        ],
    };
}
