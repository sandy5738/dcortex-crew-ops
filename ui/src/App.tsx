/**
 * App shell — dCortex Air Crew Control deck.
 *
 * Left: the ops deck (deterministic situation wall, GET /ops/snapshot).
 * Right: the advisor chat (POST /chat) with reasoning trail.
 *
 * Clicking any deck row injects a grounded prompt into the chat — the deck
 * and the advisor are one workflow, not two screens.
 */
import { useCallback, useEffect, useState } from "react";
import { OpsDeck } from "./components/OpsDeck";
import { ChatPanel } from "./components/ChatPanel";
import { getSnapshot } from "./opsApi";
import type { OpsSnapshot } from "./opsTypes";

export default function App() {
  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [snapLoading, setSnapLoading] = useState(true);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [injectedPrompt, setInjectedPrompt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSnapLoading(true);
    setSnapError(null);
    try {
      setSnapshot(await getSnapshot());
    } catch (e) {
      setSnapError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSnapLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Deck rows dispatch "ops:ask"; the shell routes it into the chat.
  useEffect(() => {
    const h = (e: Event) =>
      setInjectedPrompt((e as CustomEvent<string>).detail);
    window.addEventListener("ops:ask", h);
    return () => window.removeEventListener("ops:ask", h);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark mono">dC</span>
          <span className="brand-name">Crew Ops Advisor</span>
          <span className="brand-sub">dCortex Air · Crew Control</span>
        </div>
        <div className="topbar-right mono">
          {snapError ? (
            <span className="v-breach">snapshot offline — {snapError}</span>
          ) : (
            <span>
              operational window {snapshot?.dates[0] ?? "—"} →{" "}
              {snapshot?.dates[6] ?? "—"} UTC
            </span>
          )}
        </div>
      </header>

      <div className="columns">
        <OpsDeck
          snapshot={snapshot}
          loading={snapLoading}
          onRefresh={() => void load()}
        />
        <ChatPanel
          injectedPrompt={injectedPrompt}
          onConsumed={() => setInjectedPrompt(null)}
        />
      </div>
    </div>
  );
}
