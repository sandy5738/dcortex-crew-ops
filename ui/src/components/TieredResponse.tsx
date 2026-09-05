import type { ChatTurn, ReasoningTrailItem } from "../api";

type TierId = 1 | 2 | 3 | 0;

type TierBucket = {
  id: TierId;
  title: string;
  subtitle: string;
  calls: ReasoningTrailItem[];
};

function classifyTier(toolName: string): TierId {
  if (toolName.startsWith("get_")) return 1;
  if (toolName.startsWith("check_")) return 2;
  if (toolName === "simulate_impact") return 3;
  return 0;
}

function safePretty(value: unknown): string {
  if (value === null || value === undefined) return "no result captured";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
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

function buildBuckets(items: ReasoningTrailItem[]): TierBucket[] {
  const buckets: Record<TierId, TierBucket> = {
    1: {
      id: 1,
      title: "Tier 1 · Lookup",
      subtitle: "Raw retrieval from crew, roster, reserve, and flight datasets.",
      calls: [],
    },
    2: {
      id: 2,
      title: "Tier 2 · Rule Checks",
      subtitle: "Deterministic legality checks against FDP, duty, cert, and related constraints.",
      calls: [],
    },
    3: {
      id: 3,
      title: "Tier 3 · Decision Impact",
      subtitle: "What-if and downstream operational impact simulation.",
      calls: [],
    },
    0: {
      id: 0,
      title: "Other Tooling",
      subtitle: "Calls that do not map to the standard three tiers.",
      calls: [],
    },
  };

  for (const item of items) {
    buckets[classifyTier(item.tool_called)].calls.push(item);
  }

  return [buckets[1], buckets[2], buckets[3], buckets[0]].filter(
    (b) => b.calls.length > 0,
  );
}

function suggestedFollowUps(turn: ChatTurn): string[] {
  const usedTiers = new Set(turn.reasoningTrail.map((c) => classifyTier(c.tool_called)));
  const prompts: string[] = [];

  if (usedTiers.has(1)) {
    prompts.push("Can you run the same lookup for the next duty date at BLR?");
  }
  if (usedTiers.has(2)) {
    prompts.push("Which rule is the tightest constraint here, and by how much?");
  }
  if (usedTiers.has(3)) {
    prompts.push("If this candidate is unavailable too, what is the next best legal option?");
  }

  prompts.push("Give me the concise decision recommendation and one fallback option.");
  return prompts.slice(0, 4);
}

export function TieredResponse({
  turn,
  loading,
  onFollowUp,
}: {
  turn: ChatTurn | null;
  loading: boolean;
  onFollowUp: (prompt: string) => void;
}) {
  if (loading) {
    return (
      <section>
        <div className="mono text-13" style={{ color: "var(--ink-2)" }}>
          Processing query and orchestrating tools...
        </div>
      </section>
    );
  }

  if (!turn) {
    return (
      <section style={{ maxWidth: "72ch", color: "var(--ink-2)" }}>
        Ask from the left panel. The right panel will show:
        <div className="mt-2">1. final answer</div>
        <div>2. Tier 1 lookup trail</div>
        <div>3. Tier 2 legality trail</div>
        <div>4. Tier 3 impact trail</div>
        <div>5. follow-up suggestions</div>
      </section>
    );
  }

  const buckets = buildBuckets(turn.reasoningTrail);
  const followUps = suggestedFollowUps(turn);

  return (
    <section className="space-y-4" style={{ maxWidth: "100ch" }}>
      <header className="certificate p-4">
        <div className="text-13" style={{ color: "var(--ink-2)" }}>
          Question
        </div>
        <div className="text-15">{turn.question}</div>
        <div className="mt-3 text-13" style={{ color: "var(--ink-2)" }}>
          Answer
        </div>
        <div className="whitespace-pre-wrap text-14">{turn.answer || "No answer returned."}</div>
      </header>

      {buckets.length > 0 && (
        <div className="space-y-3">
          {buckets.map((bucket) => (
            <article key={bucket.id} className="certificate p-3">
              <div className="text-14 font-medium">{bucket.title}</div>
              <div className="text-13" style={{ color: "var(--ink-2)" }}>
                {bucket.subtitle}
              </div>

              <div className="mt-2 space-y-2">
                {bucket.calls.map((call, idx) => (
                  <details key={`${call.tool_called}-${idx}`}>
                    <summary className="cursor-pointer mono text-13">
                      {call.tool_called}
                    </summary>
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      <div>
                        <div className="text-12" style={{ color: "var(--ink-2)" }}>
                          arguments
                        </div>
                        <pre className="tier-pre">{safePretty(call.arguments)}</pre>
                      </div>
                      <div>
                        <div className="text-12" style={{ color: "var(--ink-2)" }}>
                          result
                        </div>
                        <pre className="tier-pre">{safePretty(call.raw_result)}</pre>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      <section className="certificate p-3">
        <div className="text-14 font-medium">Follow-up Questions</div>
        <div className="text-13" style={{ color: "var(--ink-2)" }}>
          Keep the same context. These prompts reuse the conversation history.
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {followUps.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="chip px-2 py-1"
              onClick={() => onFollowUp(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}