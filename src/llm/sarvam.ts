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

export function loadConfig(): SarvamConfig | null {
    const apiKey = process.env.SARVAM_API_KEY?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        model: process.env.SARVAM_MODEL?.trim() || 'sarvam-105b',
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
    opts: { toolChoice?: 'auto' | 'none' | 'required'; timeoutMs?: number } = {},
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

        return { message: choice.message as ChatMessage, finish_reason: choice.finish_reason };
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
