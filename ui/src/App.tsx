/**
 * App shell — UI_DESIGN.md §2 (layout) and §6 (component tree).
 *
 * Left rail for conversation, main area for the answer. Not three columns:
 * at 1440px three columns gives you three cramped ones, and the certificate
 * needs horizontal room for its date columns.
 */
import { useEffect, useState } from "react";
import { ConversationRail, type Message } from "./components/ConversationRail";
import { ExclusionPanel } from "./components/ExclusionPanel";
import { Header } from "./components/Header";
import { Rack } from "./components/Rack";
import { fixtureMode, recordChoice, useAsk } from "./api";
import { isRefusal, type Candidate, type Verdict } from "./types";

function Refused({ reason, suggestion }: { reason: string; suggestion: string }) {
  // Firm, specific, no apology, and it names what would work.
  return (
    <div style={{ maxWidth: "60ch" }}>
      <div className="text-16">{reason}</div>
      {suggestion && (
        <div className="mt-2 text-14" style={{ color: "var(--ink-2)" }}>
          {suggestion}
        </div>
      )}
    </div>
  );
}

/** The pipeline IS the trust argument, so show it. The one place numbered
 *  steps are honest, because it is a real sequence. */
function Thinking({ trace }: { trace: string[] }) {
  return (
    <div className="mono text-13" style={{ color: "var(--ink-2)" }}>
      {trace.map((t, i) => (
        <div key={i} className="py-0.5">
          <span className="num mr-3">{i + 1}</span>
          {t}
        </div>
      ))}
      <div className="py-0.5">
        <span className="num mr-3">{trace.length + 1}</span>
        <span className="v-caution">running…</span>
      </div>
    </div>
  );
}

function Answer({
  verdict,
  degraded,
  onChoose,
}: {
  verdict: Verdict;
  degraded: boolean;
  onChoose: (c: Candidate) => void;
}) {
  return (
    <>
      <Header verdict={verdict} degraded={degraded} />
      <Rack
        options={verdict.options}
        rankingKey={verdict.ranking_key}
        onChoose={onChoose}
      />
      <ExclusionPanel excluded={verdict.excluded} />

      {verdict.caveats.length > 0 && (
        <div
          className="mt-6 pt-3 text-13"
          style={{ borderTop: "1px solid var(--rule)", color: "var(--ink-2)" }}
        >
          {verdict.caveats.map((c, i) => (
            <div key={i} className="mb-1">
              — {c}
            </div>
          ))}
        </div>
      )}

      {verdict.trace.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-13" style={{ color: "var(--ink-2)" }}>
            engine trace
          </summary>
          <div className="mono mt-2 text-13" style={{ color: "var(--ink-2)" }}>
            {verdict.trace.map((t, i) => (
              <div key={i}>
                {i + 1}. {t}
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

export default function App() {
  const { result, decisionId, loading, error, degraded, ask } = useAsk();
  const [messages, setMessages] = useState<Message[]>([]);

  // In fixture mode, seed the rail so the screen is never empty on a projector.
  useEffect(() => {
    if (fixtureMode() && result && !isRefusal(result)) {
      setMessages([{ role: "you", text: result.query }]);
    }
  }, [result]);

  function handleAsk(q: string) {
    setMessages((m) => [...m, { role: "you", text: q }]);
    void ask(q);
  }

  function handleChoose(c: Candidate) {
    if (!decisionId) return;
    // Fire and forget: a ledger write must never block the controller.
    void recordChoice(decisionId, c.crew_id).catch(() => {});
  }

  return (
    <div className="flex h-full">
      <ConversationRail
        messages={messages}
        loading={loading}
        onAsk={handleAsk}
      />

      <main className="flex-1 overflow-y-auto px-8 py-6">
        {error && (
          <div style={{ color: "var(--breach)", maxWidth: "70ch" }}>
            <div className="font-medium">The request did not complete.</div>
            <div className="mt-1 text-14">{error}</div>
            <div className="mt-2 text-13" style={{ color: "var(--ink-2)" }}>
              You can also append <code>?fixture=1</code> to the URL to work
              against the S2 fixture with no backend at all.
            </div>
          </div>
        )}

        {loading && (
          <Thinking
            trace={[
              "understanding the question",
              "resolving the vacancy",
              "evaluating 7 rules across the rank",
            ]}
          />
        )}

        {!loading && !error && result && isRefusal(result) && (
          <Refused reason={result.reason} suggestion={result.suggestion} />
        )}

        {!loading && !error && result && !isRefusal(result) && (
          <Answer
            verdict={result}
            degraded={degraded}
            onChoose={handleChoose}
          />
        )}

        {!loading && !error && !result && (
          <div style={{ color: "var(--ink-2)", maxWidth: "60ch" }}>
            Ask a question on the left. This desk works with rosters, duty
            clocks, certifications, reserves and costs for 14–20 September
            2026.
          </div>
        )}
      </main>
    </div>
  );
}
