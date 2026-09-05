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
breaches. Be direct and factual — no pleasantries, no restating the question.`;

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
    if (useLlm) {
        try {
            const res = await chat(cfg!, [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: question },
            ], TOOLS);

            const call = res.message.tool_calls?.[0];
            if (call) {
                tool = call.function.name;
                args = call.function.arguments;   // JSON string; executeTool parses
            } else {
                // No tool chosen: the model judged it out of scope.
                refusalFromModel = (res.message.content ?? '').trim() || null;
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
    const exec = executeTool(tool, args);
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
            const res = await chat(cfg!, [
                { role: 'system', content: NARRATOR },
                { role: 'user', content: `Question: ${question}\n\nVerdict JSON:\n${summarise(verdict)}` },
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
    return JSON.stringify({
        intent: v.intent_kind,
        impact: v.impact,
        pool_size: v.pool_size,
        legal_count: v.options.length,
        excluded_count: v.excluded.length,
        ranking_key: v.ranking_key,
        options: v.options.slice(0, 5).map(o => ({
            rank: o.rank_position, crew_id: o.crew_id, name: o.name,
            source: o.source, cost: o.cost, coverage: o.coverage,
        })),
        top_exclusions: v.excluded.slice(0, 5).map(e => ({
            crew_id: e.crew_id, reason: e.reasoning,
        })),
        rows: v.rows.slice(0, 12),
        trace: v.trace,
    }, null, 1);
}
