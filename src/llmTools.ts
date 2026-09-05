/**
 * The tool surface the model is allowed to call, and the dispatcher that
 * executes it.
 *
 * Two rules shaped this file.
 *
 * **The model chooses what to compute; it never computes.** No tool takes an
 * hours figure, a cost, or a total. `assessCandidate` derives the duty length
 * itself rather than being handed one, because a model asked for
 * `newDutyHours` will happily work out `06:00 -> 15:30 = 9.5` and feed its own
 * arithmetic into a deterministic rule.
 *
 * **Tools are tier-shaped, not rule-shaped.** The seven rule checks used to be
 * seven tools. All seven ALWAYS apply to a legality question, so choosing
 * among them was never the model's decision — and exposing them separately let
 * it omit one, while the answer keys list all seven in `rules_checked[]`. They
 * are now one call returning seven verdicts. The same reasoning collapses Tier
 * 3: `recommendCover` is one call instead of the ~196 a model would otherwise
 * sequence, which is what makes it both fast and reproducible.
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getDb } from './db';
import { QueryEngine, QuerySchemas } from './queryEngine';
import { assessCandidate, recommendCover } from './decide';
import { deriveDuty, fdpLimit } from './duty';
import { simulateImpact } from './simulator';

// ---------------------------------------------------------------- schemas

export const DecisionSchemas = {
    AssessCandidate: z.object({
        crewId: z.string().describe("The crew member being considered (e.g., C-2087)"),
        pairingId: z.string().describe("The pairing they would cover (e.g., P-2291)"),
        vacancyCrewId: z.string().optional()
            .describe("Who they would replace, if this is a vacancy"),
    }),
    RecommendCover: z.object({
        pairingId: z.string().describe("The pairing needing cover (e.g., P-2291)"),
        vacancyCrewId: z.string().describe("The crew member who is unavailable (e.g., C-1042)"),
    }),
    AssessDelay: z.object({
        aircraft: z.string().describe("Tail number (e.g., VT-DXA)"),
        date: z.string().describe("Date in YYYY-MM-DD"),
        delayHours: z.number().describe("Delay in hours (e.g., 1.5 for 90 minutes)"),
    }),
    AssessVacancy: z.object({
        crewId: z.string().describe("The crew member who is unavailable"),
        date: z.string().describe("Date in YYYY-MM-DD"),
    }),
};

// ------------------------------------------------------------------ tools

const tool = (name: string, description: string, schema: z.ZodTypeAny) => ({
    type: 'function' as const,
    function: { name, description, parameters: zodToJsonSchema(schema, { target: 'jsonSchema7' }) },
});

export const TOOLS = [
    // ---- Tier 1: retrieval
    tool('getCrew', 'Look up crew details: rank, base, ratings, status. Search by crewId, or list everyone of a rank and/or base.', QuerySchemas.GetCrew),
    tool('getFlights', 'Flight schedules for a date, optionally filtered by departure or arrival station.', QuerySchemas.GetFlights),
    tool('getNetworkStats', 'Network aggregates: how many flights operate, the longest block time and which flights hold it, and which stations are served nonstop from a given station.', QuerySchemas.GetNetworkStats),
    tool('getPairing', 'The full pairing: days, report/release, legs and assigned crew. Identify it by pairingId, or by aircraft plus date.', QuerySchemas.GetPairing),
    tool('getReservePool', 'Which crew are on reserve for a date and base, with their on-call windows.', QuerySchemas.GetReservePool),
    tool('getExpiringCertifications', 'Certifications expiring within a date range.', QuerySchemas.GetExpiringCertifications),
    tool('getDutyHours', "A crew member's accrued duty and flight hours and last rest.", QuerySchemas.GetDutyHours),
    tool('getCrewAboveDutyThreshold', 'Which crew are at or above a duty-hours threshold for the 7 days ending on a date, including any duty rostered that day. Use for "who is close to the limit".', QuerySchemas.GetCrewAboveDutyThreshold),
    tool('getRiskSignals', 'Pre-computed disruption-risk score and its drivers. A given input, never derived.', QuerySchemas.GetRiskSignals),
    tool('getEarliestNextReport', 'Earliest legal report time after a release, applying the minimum rest period.', QuerySchemas.GetEarliestNextReport),

    // ---- Tier 2: consequence
    tool('assessVacancy', 'What breaks if a crew member is unavailable on a date: which legs are uncrewed, which are at risk, and how many passengers are exposed.', DecisionSchemas.AssessVacancy),
    tool('assessCandidate', 'Can this crew member legally cover this pairing? Evaluates ALL SEVEN rules plus availability (status, on-call window, double-booking) and returns a verdict per rule with its arithmetic. Derives duty and block hours itself — never supply them.', DecisionSchemas.AssessCandidate),
    tool('assessDelay', 'Effect of a technical delay on an aircraft line: the extended duty period, the FDP limit for its sector count, and whether it breaches.', DecisionSchemas.AssessDelay),

    // ---- Tier 3: recommendation
    tool('recommendCover', 'Ranked, costed, rule-checked options to cover a pairing whose crew member is unavailable. Enumerates every crew member of the required rank, evaluates all seven rules on each, prices the legal ones and ranks them, and returns the rejected ones with reasons.', DecisionSchemas.RecommendCover),
];

/** Kept for the older OpenAI-shaped callers. */
export const OPENAI_TOOLS = TOOLS;

// ------------------------------------------------------------- dispatcher

type Handler = { schema: z.ZodTypeAny; run: (args: any) => unknown };

const HANDLERS: Record<string, Handler> = {
    getCrew: { schema: QuerySchemas.GetCrew, run: a => QueryEngine.getCrew(a) },
    getFlights: { schema: QuerySchemas.GetFlights, run: a => QueryEngine.getFlights(a) },
    getNetworkStats: { schema: QuerySchemas.GetNetworkStats, run: a => QueryEngine.getNetworkStats(a) },
    getPairing: { schema: QuerySchemas.GetPairing, run: a => QueryEngine.getPairing(a) },
    getReservePool: { schema: QuerySchemas.GetReservePool, run: a => QueryEngine.getReservePool(a) },
    getExpiringCertifications: { schema: QuerySchemas.GetExpiringCertifications, run: a => QueryEngine.getExpiringCertifications(a) },
    getDutyHours: { schema: QuerySchemas.GetDutyHours, run: a => QueryEngine.getDutyHours(a) },
    getCrewAboveDutyThreshold: { schema: QuerySchemas.GetCrewAboveDutyThreshold, run: a => QueryEngine.getCrewAboveDutyThreshold(a) },
    getRiskSignals: { schema: QuerySchemas.GetRiskSignals, run: a => QueryEngine.getRiskSignals(a) },
    getEarliestNextReport: { schema: QuerySchemas.GetEarliestNextReport, run: a => QueryEngine.getEarliestNextReport(a) },

    assessVacancy: {
        schema: DecisionSchemas.AssessVacancy,
        run: a => simulateImpact(a.crewId, a.date),
    },
    assessCandidate: {
        schema: DecisionSchemas.AssessCandidate,
        run: a => assessCandidate(a.crewId, a.pairingId, a.vacancyCrewId)
            ?? { error: `No assessment for ${a.crewId} on ${a.pairingId}` },
    },
    assessDelay: {
        schema: DecisionSchemas.AssessDelay,
        run: a => {
            const pairings = getDb().prepare(
                `SELECT DISTINCT pdf.pairing_id p FROM pairing_day_flights pdf
                 JOIN flights f ON f.flight_id = pdf.flight_id
                 WHERE f.aircraft = ? AND pdf.date = ?`).all(a.aircraft, a.date) as { p: string }[];
            if (pairings.length === 0) return { error: `No pairing for ${a.aircraft} on ${a.date}` };

            return pairings.map(({ p }) => {
                const before = deriveDuty(p, a.date)!;
                // 'extend': the crew reports on schedule and waits, so the duty
                // grows by the delay. A uniform shift would find no breach.
                const after = deriveDuty(p, a.date, { delayHours: a.delayHours, mode: 'extend' })!;
                const limit = fdpLimit(after.sectors);
                return {
                    pairing_id: p,
                    sectors: after.sectors,
                    fdp_before: before.duty_hours,
                    fdp_after_delay: after.duty_hours,
                    fdp_limit: limit,
                    breach: after.duty_hours > limit,
                    detail: `RULE-FDP-01: delayed duty runs ${after.duty_hours}h vs ${limit}h limit (${after.sectors} sectors)`,
                };
            });
        },
    },
    recommendCover: {
        schema: DecisionSchemas.RecommendCover,
        run: a => recommendCover(a.pairingId, a.vacancyCrewId)
            ?? { error: `No recommendation for ${a.pairingId}` },
    },
};

export const TOOL_NAMES = Object.keys(HANDLERS);

/**
 * Execute one tool call.
 *
 * Arguments are zod-validated before anything runs, and a failure returns a
 * refusal rather than a repaired guess. Sarvam returns `function.arguments`
 * as a JSON STRING, not an object, so a string is parsed here — passing it
 * straight through is a silent failure mode.
 */
export function executeTool(name: string, args: unknown):
    { ok: true; result: unknown } | { ok: false; error: string } {
    const handler = HANDLERS[name];
    if (!handler) {
        return { ok: false, error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}` };
    }

    let parsedArgs = args;
    if (typeof args === 'string') {
        try { parsedArgs = JSON.parse(args); }
        catch { return { ok: false, error: `Arguments for "${name}" were not valid JSON.` }; }
    }

    const parsed = handler.schema.safeParse(parsedArgs);
    if (!parsed.success) {
        return {
            ok: false,
            error: `Invalid arguments for "${name}": ` +
                parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; '),
        };
    }

    try {
        return { ok: true, result: handler.run(parsed.data) };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
