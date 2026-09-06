/**
 * ChatPanel — the conversational core of the deck.
 *
 * Design borrowings, deliberate:
 *  - Flight-strip aesthetics: wide, short rows, hairline separation,
 *    colour-coded left edge. A controller reads strips, not cards.
 *  - The reasoning trail is first-class, not a debug drawer: the hackathon
 *    mandates explainability, so every assistant turn carries its evidence.
 *  - Tier-3 answers come back as JSON options; they render as ranked
 *    option cards with rule chips, cost and coverage.
 */
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  CircleDot,
  Cpu,
  Loader2,
  Plane,
  Search,
  Send,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import { postChat, type HistoryItem } from "../opsApi";
import {
  tierOfTool,
  type ChatMessage,
  type RankedOption,
  type ReasoningTrailItem,
} from "../opsTypes";
import { renderMarkdown } from "../markdown";

/** The six worked disruption scenarios, shipped with the dataset. */
const SCENARIOS: { id: string; title: string; prompt: string }[] = [
  {
    id: "S1",
    title: "ATR captain sick call",
    prompt:
      "Captain C-3231 calls in sick at 01:30Z on 2026-09-16 for pairing P-2224. Which flights are now uncrewed and what should I do?",
  },
  {
    id: "S2",
    title: "Captain C-1042 sick — 2-day pairing",
    prompt:
      "Captain C-1042 calls in sick at 05:00Z on 2026-09-15 for pairing P-2291. Which flights are uncrewed, what downstream duty risks exist, and what are my best replacement options with costs?",
  },
  {
    id: "S3",
    title: "BLR station closure 08:00–14:00Z",
    prompt:
      "Station BLR is closed 08:00–14:00Z on 2026-09-17. What is the crew impact?",
  },
  {
    id: "S4",
    title: "Tech delay cascades into FDP breach",
    prompt:
      "VT-DXA has a 90-minute technical delay before DX401 on 2026-09-16. All four legs shift by 90 minutes. Does anyone breach a duty or FDP limit?",
  },
  {
    id: "S5",
    title: "Certification lapse pre-flight",
    prompt:
      "Compliance flagged at 10:00Z on 2026-09-18 that C-5417's recurrent_training expired on 2026-09-17. Their rostered duty on 2026-09-19 must be covered. What are the options?",
  },
  {
    id: "S6",
    title: "Two captains sick simultaneously",
    prompt:
      "At 00:30Z on 2026-09-18 the captains of VT-DXA (C-3940) and VT-DXB (C-1938) both call in sick. There is only one qualified reserve captain. What should I do?",
  },
];

const EXAMPLES = [
  "Who is on reserve at BLR tomorrow, and what are their on-call windows?",
  "How many duty hours does C-1042 have left this week?",
  "Which flights depart DEL on 2026-09-15?",
  "List crew whose licence or medical expires in the next 30 days.",
];

const TIER_META: Record<
  number,
  { label: string; icon: typeof Search; cls: string }
> = {
  1: { label: "Tier 1 · Lookup", icon: Search, cls: "tier-1" },
  2: { label: "Tier 2 · Legality", icon: ShieldCheck, cls: "tier-2" },
  3: { label: "Tier 3 · Impact", icon: AlertTriangle, cls: "tier-3" },
};

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} rows`;
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.legal === "boolean")
      return r.legal ? "legal ✓" : "breach ✕";
    if (typeof r.rule_id === "string") return String(r.reason ?? r.rule_id).slice(0, 72);
    const keys = Object.keys(r);
    if (keys.length === 0) return "empty";
    return keys
      .slice(0, 3)
      .map((k) => {
        const v = r[k];
        if (Array.isArray(v)) return `${k}: ${v.length}`;
        return `${k}: ${String(v).slice(0, 28)}`;
      })
      .join(" · ");
  }
  return String(value).slice(0, 72);
}

function OptionCard({ opt }: { opt: RankedOption }) {
  const legal = opt.legal !== false;
  return (
    <div
      className={`option-card ${legal ? "opt-legal" : "opt-breach"}`}
      data-rank={opt.rank}
    >
      <div className="opt-rank">{opt.rank}</div>
      <div className="opt-main">
        <div className="opt-action">{opt.action}</div>
        {opt.reasoning && <div className="opt-reasoning">{opt.reasoning}</div>}
        <div className="opt-meta">
          <span className={`opt-legal-chip ${legal ? "chip-legal" : "chip-breach"}`}>
            {legal ? "✓ legal" : "✕ illegal"}
          </span>
          {typeof opt.cost_inr === "number" && (
            <span className="opt-chip num">
              ₹{opt.cost_inr.toLocaleString("en-IN")}
            </span>
          )}
          {opt.coverage && <span className="opt-chip">{opt.coverage}</span>}
          {opt.rules_checked && opt.rules_checked.length > 0 && (
            <span className="opt-chip mono" title={opt.rules_checked.join(" · ")}>
              {opt.rules_checked.length} rules checked
            </span>
          )}
        </div>
        {opt.rules_checked && opt.rules_checked.length > 0 && (
          <div className="opt-rules">
            {opt.rules_checked.map((r) => (
              <span key={r} className="rule-chip mono">
                {r.replace("RULE-", "")}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TrailItemView({ item }: { item: ReasoningTrailItem }) {
  const [open, setOpen] = useState(false);
  const tier = tierOfTool(item.tool_called);
  const meta = TIER_META[tier];
  const Icon = meta.icon;

  return (
    <div className={`trail-item ${meta.cls}`}>
      <button className="trail-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="trail-tier-badge">
          <Icon size={12} aria-hidden />
        </span>
        <span className="trail-name mono">{item.tool_called}</span>
        <span className="trail-summary">{summarize(item.raw_result)}</span>
        <ChevronDown size={14} className={`trail-chevron ${open ? "flip" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="trail-body">
          <div className="trail-label">arguments</div>
          <pre className="trail-pre mono">{pretty(item.arguments)}</pre>
          <div className="trail-label">deterministic result</div>
          <pre className="trail-pre mono">{pretty(item.raw_result)}</pre>
        </div>
      )}
    </div>
  );
}

function AdvisorTurn({ msg }: { msg: ChatMessage }) {
  const [trailOpen, setTrailOpen] = useState(false);
  const trail = msg.trail ?? [];
  const tiersUsed = new Set(trail.map((t) => tierOfTool(t.tool_called)));

  return (
    <div className="msg msg-advisor">
      <div className="msg-role">
        <Cpu size={12} aria-hidden /> Advisor
      </div>
      {msg.error ? (
        <div className="msg-error">{msg.text}</div>
      ) : (
        <div className="msg-answer md">{renderMarkdown(msg.text)}</div>
      )}

      {msg.options && msg.options.length > 0 && (
        <div className="options-rack">
          {msg.options.map((o) => (
            <OptionCard key={`${o.rank}-${o.action}`} opt={o} />
          ))}
        </div>
      )}

      {trail.length > 0 && (
        <div className="trail-section">
          <button className="trail-toggle" onClick={() => setTrailOpen(!trailOpen)}>
            <Terminal size={12} aria-hidden />
            Reasoning trail — {trail.length} tool {trail.length === 1 ? "call" : "calls"}
            {[...tiersUsed]
              .sort()
              .map((t) => TIER_META[t].label.split(" · ")[0])
              .join(" + ")}
            <ChevronDown size={14} className={`trail-chevron ${trailOpen ? "flip" : ""}`} aria-hidden />
          </button>
          {trailOpen && (
            <div className="trail-list">
              {trail.map((t, i) => (
                <TrailItemView key={`${t.tool_called}-${i}`} item={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  injectedPrompt,
  onConsumed,
}: {
  injectedPrompt: string | null;
  onConsumed: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showScenarios, setShowScenarios] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click on the deck (flight strip, risk row…) injects a prompt.
  useEffect(() => {
    if (injectedPrompt && !loading) {
      void send(injectedPrompt);
      onConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectedPrompt]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || loading) return;

    const history: HistoryItem[] = messages
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));

    setMessages((ms) => [...ms, { id: `u${Date.now()}`, role: "user", text: q }]);
    setLoading(true);
    try {
      const data = await postChat(q, history.slice(-20));
      // Strip LLM throat-clearing before rendering ("I now have all the
      // information…"). The controller wants the answer, not the process
      // commentary — the process is visible in the reasoning trail.
      const raw =
        typeof data.answer === "string" && data.answer.trim() !== ""
          ? data.answer
          : "";
      const stripped = raw.replace(
        /^\s*(?:[-–—]{3,}\s*)?(?:I (?:now )?have (?:all|enough|the) (?:information|data|results)[^\n]*\n+|Based on (?:the|my) (?:tool (?:results|outputs)|data|analysis|information)[^\n]*\n+|(?:Here(?:'s| is) (?:the|my) (?:full |complete |comprehensive )?(?:assessment|analysis|answer|breakdown)[:.]?\s*\n+))/i,
        "",
      );
      const answer =
        stripped.trim() !== ""
          ? stripped
          : "(no answer returned — the reasoning trail below shows what the engines found)";
      setMessages((ms) => [
        ...ms,
        {
          id: `a${Date.now()}`,
          role: "advisor",
          text: answer,
          options: data.options,
          trail: data.reasoning_trail ?? [],
        },
      ]);
    } catch (e) {
      setMessages((ms) => [
        ...ms,
        {
          id: `e${Date.now()}`,
          role: "advisor",
          error: true,
          text:
            e instanceof Error
              ? `The advisor could not answer: ${e.message}. Is the API running? Start it with \`npm start\` from the repo root.`
              : "Unknown failure",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
    setInput("");
  }

  return (
    <div className="chat-panel">
      <header className="panel-head">
        <div>
          <div className="panel-title">
            <Plane size={14} aria-hidden /> Crew Ops Advisor
          </div>
          <div className="panel-sub">
            Ask in plain language · every answer carries its reasoning
          </div>
        </div>
        <button
          className={`scenario-btn ${showScenarios ? "on" : ""}`}
          onClick={() => setShowScenarios(!showScenarios)}
        >
          <Wrench size={13} aria-hidden /> Drill scenarios
        </button>
      </header>

      {showScenarios && (
        <div className="scenario-tray">
          <div className="scenario-caption">
            The dataset ships six worked disruptions with answer keys. Launch one
            into the chat and watch the tool calls it triggers.
          </div>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              className="scenario-item"
              onClick={() => {
                void send(s.prompt);
                setShowScenarios(false);
              }}
            >
              <span className="scenario-id mono">{s.id}</span>
              <span className="scenario-title">{s.title}</span>
            </button>
          ))}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !loading && (
          <div className="chat-empty">
            <div className="chat-empty-title">Good morning, Crew Control.</div>
            <p>
              dCortex Air · 147 flights · 150 crew · 8 stations · 14–20 Sep 2026.
              Ask anything about rosters, legality, reserves or disruptions. The
              deterministic engines do the arithmetic; every answer shows its
              evidence.
            </p>
            <div className="chat-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="example-chip" onClick={() => void send(ex)}>
                  <CircleDot size={11} aria-hidden /> {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg msg-user">
              <div className="msg-role">You</div>
              <div className="msg-text">{m.text}</div>
            </div>
          ) : (
            <AdvisorTurn key={m.id} msg={m} />
          ),
        )}

        {loading && (
          <div className="msg msg-advisor">
            <div className="msg-role">
              <Loader2 size={12} className="spin" aria-hidden /> Advisor
            </div>
            <div className="msg-working">
              Routing your question through the query engine, rules engine and
              impact simulator…
            </div>
          </div>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          placeholder="Ask the advisor…  ( / to focus )"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
              setInput("");
            }
          }}
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()} aria-label="Send">
          <Send size={15} aria-hidden />
        </button>
      </form>
    </div>
  );
}
