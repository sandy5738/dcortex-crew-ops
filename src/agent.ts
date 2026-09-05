/**
 * ask() — the one entry point. Natural language in, a Verdict out.
 *
 *   PARSE   (Sarvam)  question -> ONE validated tool call
 *   EXECUTE (TypeScript)        the deterministic engine
 *   NARRATE (Sarvam)  verdict  -> prose, numbers injected as slots
 *
 * The model chooses what to compute and describes the result. It never
 * computes: no tool accepts an hours figure, a cost or a total, so there is
 * nothing for it to get wrong arithmetically. Given a tool call, the answer is
 * reproducible and unit-tested — which is the strongest determinism claim
 * available when the API exposes no seed.
 *
 * Both LLM stages degrade to deterministic fallbacks, so a missing key or a
 * dead venue network narrows the experience rather than ending it.
 */
import { TOOLS, executeTool } from './llmTools';
import { chat, llmEnabled, loadConfig, SarvamError, type ChatMessage } from './llm/sarvam';
import { parseDeterministic } from './llm/fallback';
import { narrateTemplate } from './llm/narrate';
import {
    assessmentToVerdict, recommendationToVerdict, rowsToVerdict, type UiVerdict,
} from './verdict';
import type { CandidateAssessment, CoverRecommendation } from './decide';

export interface Refusal {
    refused: true;
    reason: string;
    suggestion: string;
}

export interface Answer {
    result: UiVerdict | Refusal;
    prose: string;
    /** true when the deterministic parser or template narrator was used. */
    degraded: boolean;
    tool: string | null;
    args: unknown;
    elapsed_ms: number;
}

const SYSTEM = `You are the parsing layer of an airline Crew Control decision aid.

Your ONLY job is to choose one tool and its arguments. You never compute,
estimate, or state a number yourself — every figure in the final answer comes
from the tool you call.

The dataset: dCortex Air, hub BLR, the week 2026-09-14 to 2026-09-20. All
times UTC. Crew ids look like C-1042, pairings like P-2291, flights like
DX412-2026-09-15, aircraft like VT-DXA.

Rules for choosing:
- "who is on reserve", "which flights", "what is X's rating" -> a lookup tool.
- "does X breach", "can X cover Y" -> assessCandidate. Never call it with an
  hours figure; it derives duty length itself.
- "what should I do", "ranked options", "cheapest legal way" -> recommendCover.
- Two or more crew sick at once -> planJointCover, never recommendCover twice.
- A station closed for a window -> assessStationClosure.
- An aircraft delayed -> assessDelay.

NEVER invent an identifier. assessCandidate and recommendCover need a pairing
id. If the question names a FLIGHT (DX412) or an AIRCRAFT (VT-DXA) instead,
call getPairing first — with flightId, or with aircraft and date — and use the
pairing id it returns. The same applies to a crew id you were not given.

A guessed id is the worst possible failure here: the rules will evaluate it
perfectly and return confident, correct arithmetic about entirely the wrong
pairing. An extra lookup costs a second; a wrong pairing is an illegal flight.

Resolve relative dates against the snapshot 2026-09-14: "tomorrow" is
2026-09-15. If the question is outside this operational data — weather,
ticket prices, anything not about crew, flights, rosters, duty limits,
certifications, reserves or costs — do NOT call a tool. Reply with a single
short sentence saying you cannot answer it.`;

const NARRATOR = `You are the narration layer of an airline Crew Control decision aid.

You will be given a JSON verdict computed by deterministic code. Write two or
three sentences a crew controller can read in seconds.

Absolute rule: every number you write MUST appear verbatim in the JSON. Never
compute, round, convert or infer a figure. If a number is not in the JSON, do
not write it.

Lead with the decision or the finding. Name the rule id when something
breaches. Be direct and factual — no pleasantries, no restating the question.

Describe only what the JSON contains. Do not report a count that is not there,
and do not say rules passed or nothing breached unless the JSON actually shows
a rule being evaluated — a list of flights or crew is a lookup, not a legality
check.

Never mention the JSON itself: no field names, no "the JSON shows", no
"answer_type". Write as though you already knew the facts.`;

/**
 * Tools whose result IS the answer. When one of these succeeds the loop
 * stops: feeding a 60KB recommendation back to the model invites it to
 * summarise numbers it should only ever pass through.
 */
const DECISION_TOOLS = new Set([
    'recommendCover', 'planJointCover', 'assessCandidate',
    'assessStationClosure', 'assessDelay', 'assessVacancy',
]);

function isRecommendation(x: unknown): x is CoverRecommendation {
    return !!x && typeof x === 'object' && 'options' in x && 'ranking_key' in x;
}
function isAssessment(x: unknown): x is CandidateAssessment {
    return !!x && typeof x === 'object' && 'verdicts' in x && 'crew_id' in x;
}

/** Tool result -> the UI's Verdict shape. */
function shape(tool: string, result: unknown, query: string, at: string): UiVerdict {
    if (isRecommendation(result)) return recommendationToVerdict(result, query, at);
    if (isAssessment(result)) {
        return assessmentToVerdict(result, query, at, (result as any).pairing_id ?? '');
    }
    return rowsToVerdict(result, query, at, tool);
}

export async function ask(question: string): Promise<Answer> {
    const started = Date.now();
    const at = new Date().toISOString();
    const cfg = loadConfig();
    const useLlm = llmEnabled() && cfg !== null;

    let tool: string | null = null;
    let args: unknown = null;
    let degraded = !useLlm;
    let refusalFromModel: string | null = null;

    // ---- PARSE
    //
    // Bounded multi-step. Most questions resolve in one call, but some name
    // an aircraft where the engine needs a crew id ("both captains of VT-DXA
    // and VT-DXB are sick"). Single-shot, the model INVENTED "C-UNKNOWN"
    // rather than looking it up. Letting it call a lookup first and then
    // decide fixes that; the cap stops it looping.
    const MAX_STEPS = 4;
    let lastResult: unknown = null;

    if (useLlm) {
        const messages: ChatMessage[] = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: question },
        ];

        try {
            for (let step = 0; step < MAX_STEPS; step++) {
                const res = await chat(cfg!, messages, TOOLS);
                const call = res.message.tool_calls?.[0];

                if (!call) {
                    // No tool: either out of scope, or it is done and talking.
                    if (!tool) refusalFromModel = (res.message.content ?? '').trim() || null;
                    break;
                }

                const exec = executeTool(call.function.name, call.function.arguments);
                tool = call.function.name;
                args = call.function.arguments;
                lastResult = exec.ok ? exec.result : null;

                // A decision tool ends the loop: its result IS the answer.
                if (exec.ok && DECISION_TOOLS.has(tool)) break;

                // Otherwise feed the result back so it can resolve and decide.
                messages.push({ role: 'assistant', content: null, tool_calls: [call] });
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: exec.ok
                        ? JSON.stringify(exec.result).slice(0, 4000)
                        : `error: ${exec.error}`,
                });
            }
        } catch (e) {
            // A dead key or network drops us to the deterministic parser
            // rather than failing the question.
            degraded = true;
            if (!(e instanceof SarvamError)) throw e;
        }
    }

    if (!tool && !refusalFromModel) {
        const fallback = parseDeterministic(question);
        if (fallback) { tool = fallback.tool; args = fallback.args; degraded = true; }
    }

    if (!tool) {
        const reason = refusalFromModel ??
            "I can't answer that — it's outside the operational data I have.";
        return {
            result: {
                refused: true,
                reason,
                suggestion: 'I can work with rosters, duty clocks, certifications, ' +
                            'reserves, flights and costs for 14–20 September 2026.',
            },
            prose: reason,
            degraded,
            tool: null,
            args: null,
            elapsed_ms: Date.now() - started,
        };
    }

    // ---- EXECUTE (deterministic)
    // Already run inside the parse loop; re-run only if we got here another
    // way (the deterministic fallback parser).
    const exec = lastResult !== null
        ? { ok: true as const, result: lastResult }
        : executeTool(tool, args);
    if (!exec.ok) {
        return {
            result: { refused: true, reason: exec.error, suggestion: 'Try naming the crew id and date explicitly.' },
            prose: exec.error,
            degraded,
            tool, args,
            elapsed_ms: Date.now() - started,
        };
    }

    const verdict = shape(tool, exec.result, question, at);

    // ---- NARRATE
    let prose = narrateTemplate(tool, verdict);
    if (useLlm && !degraded) {
        try {
            // Hard cap as a backstop: a shape I have not special-cased must
            // not be able to exhaust the completion budget and silently
            // degrade the narration.
            const payload = summarise(verdict).slice(0, 8000);
            const res = await chat(cfg!, [
                { role: 'system', content: NARRATOR },
                { role: 'user', content: `Question: ${question}\n\nVerdict JSON:\n${payload}` },
            ] as ChatMessage[]);
            const text = (res.message.content ?? '').trim();
            if (text) prose = text;
        } catch {
            degraded = true;   // template prose already in hand
        }
    }

    return { result: verdict, prose, degraded, tool, args, elapsed_ms: Date.now() - started };
}

/**
 * Trim the verdict before it goes to the narrator. A full recommendation is
 * ~60KB of rule traces; the narrator needs the headline figures, and a smaller
 * prompt is both cheaper and less likely to have a number lifted out of
 * context.
 */
function summarise(v: UiVerdict): string {
    // Shape-specific. Sending candidate counts on a lookup produced
    // "No flights are excluded, and the legal count is 0" — the model
    // faithfully reporting a zero that means nothing here. A field the answer
    // does not have should not be in the prompt at all.
    if (v.rows.length > 0) {
        const first = v.rows[0] as any;

        // A joint plan carries every candidate's full rule trace for both
        // vacancies — 139KB. Sent whole it exhausts the completion budget and
        // the narration comes back empty; sent truncated the model narrates
        // raw internals ("all 6 rules passed with actual values 11.25,
        // 37.25…"). It needs the headline, not the working.
        if (first?.optimal !== undefined && first?.per_vacancy) {
            return JSON.stringify({
                answer_type: 'joint recovery plan',
                total_cost_inr: first.optimal?.total_cost_inr ?? null,
                assignments: first.optimal?.assignments ?? [],
                equal_cost_alternatives: first.alternative_count,
                vacancies: first.per_vacancy.map((p: any) => ({
                    pairing_id: p.pairing_id,
                    legal_candidates: p.options.length,
                    excluded: p.excluded.length,
                })),
            }, null, 1);
        }

        // A closure carries a per-flight assessment; keep it, drop the rest.
        if (first?.per_flight_assessment) {
            return JSON.stringify({
                answer_type: 'station closure',
                station: first.station,
                window: first.window_utc,
                flights_blocked: first.affected_flights?.length ?? 0,
                pairings_affected: first.pairings_affected,
                pairings_breaching_fdp: first.breaching_pairings,
                per_flight: (first.per_flight_assessment ?? []).slice(0, 8),
            }, null, 1);
        }

        return JSON.stringify({
            answer_type: v.intent_kind,
            record_count: v.rows.length,
            records: v.rows.slice(0, 15),
        }, null, 1);
    }

    if (v.options.length === 0 && v.excluded.length === 1) {
        const c = v.excluded[0];
        return JSON.stringify({
            answer_type: 'legality check',
            crew_id: c.crew_id, name: c.name, rank: c.rank,
            legal: false,
            failed_rules: c.verdicts.filter(x => !x.passed)
                .map(x => ({ rule_id: x.rule_id, detail: x.detail })),
        }, null, 1);
    }

    return JSON.stringify({
        answer_type: 'ranked recovery options',
        impact: v.impact ? {
            pairing_id: v.impact.pairing_id,
            uncovered_today: v.impact.uncovered_flights_day1,
            at_risk_later: v.impact.uncovered_flights_later,
            passengers_at_risk_today: v.impact.passengers_at_risk_day1,
        } : null,
        candidates_considered: v.pool_size,
        legal: v.options.length,
        excluded: v.excluded.length,
        ranking_key: v.ranking_key,
        options: v.options.slice(0, 5).map(o => ({
            rank: o.rank_position, crew_id: o.crew_id, name: o.name,
            source: o.source, cost_inr: (o.cost as any)?.total_inr,
            coverage: o.coverage,
        })),
        // Skip the vacancy itself: it is excluded by definition and reads
        // oddly as "the notable rejection".
        notable_exclusions: v.excluded
            .filter(e => !/crew member being replaced/i.test(e.reasoning))
            .slice(0, 3)
            .map(e => ({ crew_id: e.crew_id, reason: e.reasoning })),
    }, null, 1);
}
