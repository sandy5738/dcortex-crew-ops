/**
 * Sarvam AI client — the only file that talks to a language model.
 *
 * Native fetch, no SDK. Sarvam's chat completions endpoint is
 * OpenAI-compatible, so an SDK would add a dependency and a zod peer conflict
 * to save about thirty lines.
 *
 *   POST https://api.sarvam.ai/v1/chat/completions
 *   header: api-subscription-key
 *   models: sarvam-105b (128K, tool calling), sarvam-105b-conversations
 *           sarvam-m is DEPRECATED and no longer served
 *
 * ⚠ `function.arguments` arrives as a JSON STRING, not an object. Passing it
 * through unparsed is a silent failure; executeTool() handles both.
 *
 * ⚠ There is no `seed` parameter. temperature 0 is as reproducible as this
 * API gets, which is why the model only ever chooses a tool - everything it
 * chooses is then computed by TypeScript that IS reproducible.
 */

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface SarvamConfig {
    apiKey: string;
    model: string;
    temperature: number;
    baseUrl: string;
}

/**
 * Default to the conversational model, deliberately.
 *
 * `sarvam-105b` is a REASONING model: it returns `content: null`, puts its
 * monologue in `reasoning_content`, and on these prompts spends its whole
 * completion budget thinking without ever emitting an answer —
 * `finish_reason: "length"` at 2048 tokens, 17s, nothing usable. Raising
 * max_tokens to 4096 only bought more reasoning (33s, still nothing), and
 * reasoning_effort:"low" made no difference.
 *
 * `sarvam-105b-conversations` answers the same prompt in 3s with 47 tokens,
 * and calls tools just as accurately. Neither stage here needs deliberation:
 * one picks a tool, the other rewrites a computed verdict as a sentence.
 */
export const DEFAULT_MODEL = 'sarvam-105b-conversations';

export function loadConfig(): SarvamConfig | null {
    const apiKey = process.env.SARVAM_API_KEY?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        model: process.env.SARVAM_MODEL?.trim() || DEFAULT_MODEL,
        temperature: Number(process.env.SARVAM_TEMPERATURE ?? 0),
        baseUrl: process.env.SARVAM_BASE_URL?.trim() || 'https://api.sarvam.ai/v1',
    };
}

export function llmEnabled(): boolean {
    return process.env.CREWOPS_LLM_ENABLED !== 'false' && loadConfig() !== null;
}

export interface ChatResult {
    message: ChatMessage;
    finish_reason: string;
}

export class SarvamError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'SarvamError';
    }
}

/**
 * One round trip. Returns the assistant message, which may carry tool_calls
 * instead of content.
 */
export async function chat(
    cfg: SarvamConfig,
    messages: ChatMessage[],
    tools?: unknown[],
    opts: {
        toolChoice?: 'auto' | 'none' | 'required';
        timeoutMs?: number;
        maxTokens?: number;
    } = {},
): Promise<ChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);

    try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Sarvam's own header. It also accepts `Authorization: Bearer`
                // for OpenAI-compatible tooling; this is the documented one.
                'api-subscription-key': cfg.apiKey,
            },
            body: JSON.stringify({
                model: cfg.model,
                messages,
                temperature: cfg.temperature,
                // Neither stage needs a long answer: one returns a tool call,
                // the other two or three sentences. A cap stops a reasoning
                // model burning minutes if SARVAM_MODEL is pointed at one.
                max_tokens: opts.maxTokens ?? 700,
                ...(tools?.length ? { tools, tool_choice: opts.toolChoice ?? 'auto' } : {}),
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new SarvamError(
                `Sarvam returned ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
                res.status);
        }

        const json = await res.json() as any;
        const choice = json?.choices?.[0];
        if (!choice) throw new SarvamError('Sarvam returned no choices.');

        // A reasoning model can spend its whole budget in `reasoning_content`
        // and return content: null with finish_reason "length". Silently
        // treating that as an empty answer hides a misconfigured model behind
        // the template narrator, which is how you end up wondering why the
        // prose never changes. Name it.
        const msg = choice.message ?? {};
        if (!msg.content && !msg.tool_calls?.length &&
            choice.finish_reason === 'length' && msg.reasoning_content) {
            throw new SarvamError(
                `Model "${cfg.model}" exhausted its completion budget on internal reasoning ` +
                `and returned no answer. Use a non-reasoning model — ${DEFAULT_MODEL} — ` +
                `or raise max_tokens well beyond ${opts.maxTokens ?? 700}.`);
        }

        return { message: msg as ChatMessage, finish_reason: choice.finish_reason };
    } catch (e) {
        if (e instanceof SarvamError) throw e;
        if ((e as Error).name === 'AbortError') {
            throw new SarvamError(`Sarvam did not respond within ${(opts.timeoutMs ?? 45_000) / 1000}s.`);
        }
        throw new SarvamError((e as Error).message);
    } finally {
        clearTimeout(timer);
    }
}
