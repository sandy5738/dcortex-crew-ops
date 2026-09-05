/**
 * The one place the frontend talks to the backend.
 *
 * One useAsk() hook owns the API call; no component fetches for itself.
 * Everything below is that hook plus the small ledger/rules calls.
 *
 * Vite proxies /api/* to http://localhost:3000 (vite.config.ts), so there is
 * no CORS configuration anywhere.
 *
 * ⚠ The backend does not serve POST /ask yet — src/api.ts exposes per-tool
 * routes and a stub /chat. Until an endpoint returns a Verdict, run the UI
 * with ?fixture=1. See ui/README.md.
 */
import { useCallback, useEffect, useState } from "react";
import type { Result, Verdict } from "./types";
import fixtureS2 from "@fixtures/verdict_s2.json";

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
