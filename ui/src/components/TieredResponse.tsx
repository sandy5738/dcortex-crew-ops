import type { ChatTurn, ReasoningTrailItem } from "../api";

type TierId = 1 | 2 | 3 | 0;

type AnswerBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

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

function humanizeToolName(name: string): string {
  return name
    .replace(/^get_/, "")
    .replace(/^check_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function splitPipeRow(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
}

function isTableDivider(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function parseAnswer(answer: string): AnswerBlock[] {
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""));

  const blocks: AnswerBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line) {
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = splitPipeRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(splitPipeRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^-\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^-\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^-\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index] &&
      !/^\-\s+/.test(lines[index]) &&
      !(lines[index].includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1]))
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function summarizeResult(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} row${value.length === 1 ? "" : "s"}`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "empty object";
    return entries
      .slice(0, 3)
      .map(([key, entryValue]) => {
        if (Array.isArray(entryValue)) return `${key}: ${entryValue.length}`;
        if (entryValue && typeof entryValue === "object") return `${key}: object`;
        return `${key}: ${String(entryValue)}`;
      })
      .join(" · ");
  }

  return String(value);
}

function bucketTone(bucketId: TierId): "lookup" | "checks" | "impact" | "other" {
  if (bucketId === 1) return "lookup";
  if (bucketId === 2) return "checks";
  if (bucketId === 3) return "impact";
  return "other";
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
      subtitle: "Deterministic legality checks against FDP, duty, certification, and related constraints.",
      calls: [],
    },
    3: {
      id: 3,
      title: "Tier 3 · Decision Impact",
      subtitle: "What-if analysis and downstream operational impact simulation.",
      calls: [],
    },
    0: {
      id: 0,
      title: "Other Tooling",
      subtitle: "Calls that do not map to the standard three-tier flow.",
      calls: [],
    },
  };

  for (const item of items) {
    buckets[classifyTier(item.tool_called)].calls.push(item);
  }

  return [buckets[1], buckets[2], buckets[3], buckets[0]].filter(
    (bucket) => bucket.calls.length > 0,
  );
}

function suggestedFollowUps(turn: ChatTurn): string[] {
  const usedTiers = new Set(turn.reasoningTrail.map((call) => classifyTier(call.tool_called)));
  const prompts: string[] = [];

  if (usedTiers.has(1)) {
    prompts.push("Run the same lookup for the next operating day at BLR.");
  }
  if (usedTiers.has(2)) {
    prompts.push("Which rule is the tightest constraint here, and by how much?");
  }
  if (usedTiers.has(3)) {
    prompts.push("If this first option is unavailable too, what is the next best legal action?");
  }

  prompts.push("Give me the concise recommendation and one fallback option.");
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
      <section className="response-shell">
        <div className="response-hero response-hero-loading">
          <div className="response-eyebrow">Crew Ops Advisor</div>
          <div className="response-title">Processing the request</div>
          <div className="response-subtitle mono">
            orchestrating data lookups, rule checks, and impact evaluation
          </div>
        </div>
      </section>
    );
  }

  if (!turn) {
    return (
      <section className="response-shell">
        <div className="response-hero">
          <div className="response-eyebrow">Decision Workspace</div>
          <div className="response-title">Ask a crew-ops question</div>
          <div className="response-subtitle">
            The API output will be reorganized into a decision summary, evidence by tier,
            and follow-up actions.
          </div>
        </div>

        <div className="response-grid">
          <article className="response-card">
            <div className="response-card-label">Top answer</div>
            <div className="response-card-text">
              Recommendation or lookup result in a cleaner readable layout.
            </div>
          </article>
          <article className="response-card">
            <div className="response-card-label">Tiered evidence</div>
            <div className="response-card-text">
              Lookup, legality, and impact evidence grouped instead of dumped as raw payloads.
            </div>
          </article>
          <article className="response-card">
            <div className="response-card-label">Follow-up actions</div>
            <div className="response-card-text">
              Reuse the current context without rewriting the full scenario.
            </div>
          </article>
        </div>
      </section>
    );
  }

  const buckets = buildBuckets(turn.reasoningTrail);
  const followUps = suggestedFollowUps(turn);
  const answerBlocks = parseAnswer(turn.answer || "");
  const toolCount = turn.reasoningTrail.length;
  const activeTierCount = buckets.length;
  const totalRows = turn.reasoningTrail.reduce((count, call) => {
    return count + (Array.isArray(call.raw_result) ? call.raw_result.length : 0);
  }, 0);

  return (
    <section className="response-shell">
      <header className="response-hero">
        <div className="response-eyebrow">Latest response</div>
        <div className="response-title">{turn.question}</div>
        <div className="response-subtitle">
          Structured from live API output with operational evidence grouped by tier.
        </div>
      </header>

      <div className="response-grid">
        <article className="response-metric-card">
          <div className="response-card-label">Tools used</div>
          <div className="response-metric-value">{toolCount}</div>
          <div className="response-card-text">Calls made to produce the final answer.</div>
        </article>
        <article className="response-metric-card">
          <div className="response-card-label">Tiers active</div>
          <div className="response-metric-value">{activeTierCount}</div>
          <div className="response-card-text">Evidence grouped by lookup, checks, and impact.</div>
        </article>
        <article className="response-metric-card">
          <div className="response-card-label">Rows returned</div>
          <div className="response-metric-value">{totalRows}</div>
          <div className="response-card-text">Structured rows surfaced from tool outputs.</div>
        </article>
      </div>

      <article className="response-answer-card">
        <div className="response-section-head">
          <div>
            <div className="response-card-label">Decision output</div>
            <div className="response-section-title">Answer</div>
          </div>
          <div className="response-time mono">{new Date(turn.createdAt).toLocaleTimeString()}</div>
        </div>

        <div className="response-answer-body">
          {answerBlocks.length === 0 && <p className="response-paragraph">No answer returned.</p>}

          {answerBlocks.map((block, index) => {
            if (block.type === "paragraph") {
              return (
                <p key={index} className="response-paragraph">
                  {block.text}
                </p>
              );
            }

            if (block.type === "list") {
              return (
                <ul key={index} className="response-list">
                  {block.items.map((item) => (
                    <li key={item} className="response-list-item">
                      {item}
                    </li>
                  ))}
                </ul>
              );
            }

            return (
              <div key={index} className="response-table-wrap">
                <table className="response-table">
                  <thead>
                    <tr>
                      {block.headers.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${index}-${rowIndex}`}>
                        {block.headers.map((header, cellIndex) => (
                          <td key={`${header}-${cellIndex}`}>{row[cellIndex] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </article>

      {buckets.length > 0 && (
        <section className="response-tier-stack">
          {buckets.map((bucket) => (
            <article key={bucket.id} className={`response-tier-card tone-${bucketTone(bucket.id)}`}>
              <div className="response-section-head">
                <div>
                  <div className="response-card-label">Evidence tier</div>
                  <div className="response-section-title">{bucket.title}</div>
                </div>
                <div className="response-pill">
                  {bucket.calls.length} call{bucket.calls.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="response-card-text">{bucket.subtitle}</div>

              <div className="response-call-list">
                {bucket.calls.map((call, idx) => (
                  <details key={`${call.tool_called}-${idx}`} className="response-call-item">
                    <summary className="response-call-summary">
                      <div>
                        <div className="response-call-name mono">{humanizeToolName(call.tool_called)}</div>
                        <div className="response-call-meta">{summarizeResult(call.raw_result)}</div>
                      </div>
                      <span className="response-chip mono">{call.tool_called}</span>
                    </summary>

                    <div className="response-call-body">
                      <div>
                        <div className="response-card-label">Arguments</div>
                        <pre className="tier-pre">{safePretty(call.arguments)}</pre>
                      </div>
                      <div>
                        <div className="response-card-label">Result</div>
                        <pre className="tier-pre">{safePretty(call.raw_result)}</pre>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="response-followup-card">
        <div className="response-section-head">
          <div>
            <div className="response-card-label">Next step</div>
            <div className="response-section-title">Follow-up questions</div>
          </div>
        </div>
        <div className="response-card-text">
          Keep the same operational context and push the API one step deeper.
        </div>
        <div className="response-followup-list">
          {followUps.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="response-followup-button"
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
