/**
 * Engine output -> the Verdict the UI renders.
 *
 * ui/src/types.ts describes one object for every answer: an impact line, a
 * ranked rack, an exclusion panel, tabular rows for lookups, a trace and
 * caveats. The engine returns a different shape per tool. This is the single
 * place that maps between them, so no component has to know which tool ran.
 *
 * Nothing here computes. Every number is copied from what the deterministic
 * layer already produced.
 */
import type { CandidateAssessment, CoverRecommendation } from './decide';
import type { RuleResult } from './rulesEngine';

export interface UiRuleVerdict {
    rule_id: string;
    passed: boolean;
    detail: string;
    limit: number | null;
    actual: number | null;
    margin: number | null;
    window: string[];
    inputs: Record<string, number>;
    source_files: string[];
}

export interface UiCandidate {
    crew_id: string;
    name: string;
    rank: string;
    base: string;
    source: string;
    verdicts: UiRuleVerdict[];
    legal: boolean;
    coverage: string;
    coverage_fraction: number;
    cost: unknown | null;
    depletion: null;
    fragility_margin_hours: number | null;
    rank_position: number | null;
    action: string;
    reasoning: string;
}

export interface UiVerdict {
    intent_kind: string;
    query: string;
    impact: {
        pairing_id: string | null;
        uncovered_flights_day1: string[];
        uncovered_flights_later: string[];
        passengers_at_risk_day1: number;
        passengers_at_risk_total: number;
        affected_pairings: string[];
        downstream_risks: UiRuleVerdict[];
    } | null;
    options: UiCandidate[];
    excluded: UiCandidate[];
    rows: Record<string, unknown>[];
    ranking_key: string;
    pool_size: number;
    trace: string[];
    computed_at: string | null;
    caveats: string[];
}

const SOURCE_FILES: Record<string, string[]> = {
    'RULE-FDP-01': ['flights.json'],
    'RULE-DUTY-02': ['duty_clocks.json'],
    'RULE-FLT-03': ['duty_clocks.json'],
    'RULE-REST-04': ['rosters.json'],
    'RULE-QUAL-05': ['crew.json'],
    'RULE-CERT-06': ['certifications.json'],
    'RULE-BASE-07': ['crew.json', 'flights.json'],
};

export function toUiVerdict(v: RuleResult): UiRuleVerdict {
    const limit = v.limit ?? null;
    const actual = v.actual ?? null;
    return {
        rule_id: v.rule_id,
        passed: v.legal,
        detail: v.reason,
        limit,
        actual,
        // The UI renders a negative margin as a breach and under 2h as amber.
        margin: limit !== null && actual !== null
            ? Math.round((limit - actual) * 100) / 100 : null,
        window: v.window ?? [],
        inputs: v.inputs ?? {},
        source_files: SOURCE_FILES[v.rule_id] ?? [],
    };
}

const SOURCE_LABEL: Record<string, string> = {
    reserve: 'reserve callout', dayoff: 'day-off callout', rostered: 'swap',
};

export function toUiCandidate(c: CandidateAssessment): UiCandidate {
    return {
        crew_id: c.crew_id,
        name: c.name,
        rank: c.rank,
        base: c.base,
        source: c.source === 'rostered' ? 'swap' : c.source,
        verdicts: c.verdicts.map(toUiVerdict),
        legal: c.legal,
        coverage: c.coverage,
        coverage_fraction: c.coverage_fraction,
        cost: c.cost,
        // Forward-looking depletion scoring is not implemented; the field
        // exists in the contract, so it is explicitly null rather than absent.
        depletion: null,
        fragility_margin_hours: c.rest_margin_hours,
        rank_position: c.rank_position ?? null,
        action: c.legal
            ? `Assign ${c.rank} ${c.crew_id} (${SOURCE_LABEL[c.source] ?? c.source})`
            : `Not available: ${c.crew_id}`,
        reasoning: c.reason,
    };
}

const CAVEATS = [
    'RULE-CERT-06 is evaluated on valid_to only; valid_from in certifications.json ' +
    'is unusable (every licence row is dated in the future).',
    'Reserve on-call windows are tested against the required report time after any ' +
    'positioning, per the dataset generator, not the callout time the prose describes.',
];

/** A Tier 3 recommendation. */
export function recommendationToVerdict(
    rec: CoverRecommendation, query: string, computedAt: string,
): UiVerdict {
    const [first, ...later] = rec.days;
    return {
        intent_kind: 'Vacancy',
        query,
        impact: {
            pairing_id: rec.pairing_id,
            uncovered_flights_day1: first?.flights ?? [],
            uncovered_flights_later: later.flatMap(d => d.flights),
            passengers_at_risk_day1: first?.seats ?? 0,
            passengers_at_risk_total: rec.days.reduce((n, d) => n + d.seats, 0),
            affected_pairings: [rec.pairing_id],
            downstream_risks: [],
        },
        options: rec.options.map(toUiCandidate),
        excluded: rec.excluded.map(toUiCandidate),
        rows: [],
        ranking_key: rec.ranking_key,
        pool_size: rec.pool_size,
        trace: rec.trace,
        computed_at: computedAt,
        caveats: CAVEATS,
    };
}

/** One candidate assessed — Tier 2 "can X cover Y?". */
export function assessmentToVerdict(
    a: CandidateAssessment, query: string, computedAt: string, pairingId: string,
): UiVerdict {
    const ui = toUiCandidate(a);
    return {
        intent_kind: 'LegalityCheck',
        query,
        impact: null,
        options: a.legal ? [{ ...ui, rank_position: 1 }] : [],
        excluded: a.legal ? [] : [ui],
        rows: [],
        ranking_key: '',
        pool_size: 1,
        trace: [`assessed ${a.crew_id} against ${pairingId}`,
                `7 rules evaluated; ${a.verdicts.filter(v => !v.legal).length} failed`],
        computed_at: computedAt,
        caveats: CAVEATS,
    };
}

/**
 * Anything else - a Tier 1 lookup, a delay assessment, a closure - rendered
 * as tabular rows. The UI shows a table when `rows` is populated and there
 * are no options, so every tool has somewhere to land.
 */
/** Tool names are for the model. Controllers get a phrase. */
const TITLES: Record<string, string> = {
    getCrew: 'Crew',
    getFlights: 'Flights',
    getNetworkStats: 'Network',
    getPairing: 'Pairing',
    getReservePool: 'Reserve pool',
    getExpiringCertifications: 'Expiring certifications',
    getDutyHours: 'Duty clock',
    getCrewAboveDutyThreshold: 'Crew near the duty limit',
    getRiskSignals: 'Disruption risk',
    getEarliestNextReport: 'Earliest next report',
    assessVacancy: 'Vacancy impact',
    assessDelay: 'Delay impact',
    assessStationClosure: 'Station closure',
    planJointCover: 'Joint recovery plan',
};

export function rowsToVerdict(
    result: unknown, query: string, computedAt: string, toolName: string,
): UiVerdict {
    const rows: Record<string, unknown>[] = Array.isArray(result)
        ? result as Record<string, unknown>[]
        : (result && typeof result === 'object' ? [result as Record<string, unknown>] : []);

    return {
        intent_kind: TITLES[toolName] ?? toolName,
        query,
        impact: null,
        options: [],
        excluded: [],
        rows,
        ranking_key: '',
        pool_size: rows.length,
        trace: [`${toolName} returned ${rows.length} row(s)`],
        computed_at: computedAt,
        caveats: [],
    };
}
