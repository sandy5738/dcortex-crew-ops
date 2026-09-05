/**
 * The one place the frontend talks to the backend.
 *
 * The chat UI uses useChat() to call /api/chat. Legacy verdict-mode helpers
 * (useAsk, recordChoice, rules reload) are still kept for fixture workflows.
 *
 * Vite proxies /api/* to http://localhost:3000 (vite.config.ts), so there is
 * no CORS configuration anywhere.
 */
import { useCallback, useEffect, useState } from "react";
import type { Result, Verdict } from "./types";
import fixtureS2 from "@fixtures/verdict_s2.json";
import type { Message } from "./components/ConversationRail";

export const FIXTURE_S2 = fixtureS2 as unknown as Verdict;

/** `?fixture=1` forces fixture data, so the UI demos at any hour regardless
 *  of backend state. */
export function fixtureMode(): boolean {
  return new URLSearchParams(window.location.search).get("fixture") === "1";
}

export interface AskResponse {
  result: Result;
  /** Server says whether the LLM path was live. Drives the degraded badge. */
  degraded: boolean;
  /** Ledger row id, so a strip click can write controller_chose back. */
  decision_id: string | null;
}

export interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface ReasoningTrailItem {
  tool_called: string;
  arguments: unknown;
  raw_result: unknown;
}

export interface ChatResponse {
  answer: string;
  reasoning_trail: ReasoningTrailItem[];
}

export interface ChatTurn {
  id: string;
  question: string;
  answer: string;
  reasoningTrail: ReasoningTrailItem[];
  createdAt: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export type AskState = {
  result: Result | null;
  decisionId: string | null;
  loading: boolean;
  /** State what happened and what to do. Never "Something went wrong." */
  error: string | null;
  degraded: boolean;
};

export type ChatState = {
  messages: Message[];
  turns: ChatTurn[];
  loading: boolean;
  error: string | null;
};

export function useAsk() {
  const [state, setState] = useState<AskState>({
    result: null,
    decisionId: null,
    loading: false,
    error: null,
    degraded: false,
  });

  // In fixture mode, render the flagship answer immediately and never call out.
  useEffect(() => {
    if (fixtureMode()) {
      setState({
        result: FIXTURE_S2,
        decisionId: null,
        loading: false,
        error: null,
        degraded: true,
      });
    }
  }, []);

  const ask = useCallback(async (query: string) => {
    // Fixture mode promises no network calls, and that promise was only kept
    // on mount: submitting through the composer still hit /api/ask, got a 404
    // (there is no such route yet), and replaced the fixture verdict with an
    // error — breaking the one mode that works today. Answer locally instead.
    if (fixtureMode()) {
      setState({
        result: { ...FIXTURE_S2, query },
        decisionId: null,
        loading: false,
        error: null,
        degraded: true,
      });
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await post<AskResponse>("/ask", { query, history: [] });
      setState({
        result: data.result,
        decisionId: data.decision_id,
        loading: false,
        error: null,
        degraded: data.degraded,
      });
    } catch (e) {
      setState({
        result: null,
        decisionId: null,
        loading: false,
        error:
          e instanceof Error
            ? `${e.message}. Is the API running? Start it with \`npm start\`.`
            : "Unknown error",
        degraded: false,
      });
    }
  }, []);

  return { ...state, ask };
}

function toChatHistory(messages: Message[]): ChatHistoryItem[] {
  return messages.map((m) => ({
    role: m.role === "you" ? "user" : "assistant",
    content: m.text,
  }));
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    messages: [],
    turns: [],
    loading: false,
    error: null,
  });

  const ask = useCallback(
    async (query: string) => {
      if (state.loading) return;

      const userMessage: Message = { role: "you", text: query };
      const history = toChatHistory(state.messages);

      if (fixtureMode()) {
        const assistantText =
          `Fixture mode answer from verdict_s2.json. ` +
          `Top legal option: ${FIXTURE_S2.options[0]?.crew_id ?? "n/a"}. ` +
          `${FIXTURE_S2.options.length} legal options and ${FIXTURE_S2.excluded.length} excluded candidates.`;

        const assistantMessage: Message = {
          role: "advisor",
          text: assistantText,
        };

        setState((s) => ({
          ...s,
          messages: [...s.messages, userMessage, assistantMessage],
          turns: [
            ...s.turns,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              question: query,
              answer: assistantText,
              reasoningTrail: [],
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          error: null,
        }));
        return;
      }

      setState((s) => ({
        ...s,
        messages: [...s.messages, userMessage],
        loading: true,
        error: null,
      }));

      try {
        const data = await post<ChatResponse>("/chat", {
          message: query,
          history,
        });

        const assistantMessage: Message = {
          role: "advisor",
          text: data.answer,
        };

        setState((s) => ({
          messages: [...s.messages, assistantMessage],
          turns: [
            ...s.turns,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              question: query,
              answer: data.answer,
              reasoningTrail: data.reasoning_trail ?? [],
              createdAt: new Date().toISOString(),
            },
          ],
          loading: false,
          error: null,
        }));
      } catch (e) {
        setState((s) => ({
          ...s,
          messages:
            s.messages.length > 0 &&
            s.messages[s.messages.length - 1].role === "you" &&
            s.messages[s.messages.length - 1].text === query
              ? s.messages.slice(0, -1)
              : s.messages,
          loading: false,
          error:
            e instanceof Error
              ? `${e.message}. Is the API running? Start it with \`npm start\`.`
              : "Unknown error",
        }));
      }
    },
    [state.loading, state.messages],
  );

  return { ...state, ask };
}

/**
 * Clicking an option writes the controller's actual choice back to the
 * ledger. SPEC.md §6.6 — this is what turns the moat slide from a promise
 * into a live demonstration.
 */
export async function recordChoice(
  decisionId: string,
  crewId: string | null,
): Promise<void> {
  await post(`/ledger/${decisionId}/choice`, { controller_chose: crewId });
}

export interface RuleParam {
  rule_id: string;
  text: string;
  params: Record<string, number>;
}

export async function fetchRules(): Promise<RuleParam[]> {
  const res = await fetch("/api/rules");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** The live rule-swap demo: change a limit, reload, re-ask. SPEC.md §6.3. */
export async function reloadRules(
  overrides?: Record<string, Record<string, number>>,
): Promise<{ reloaded: boolean; rules: number }> {
  return post("/rules/reload", { overrides: overrides ?? {} });
}
