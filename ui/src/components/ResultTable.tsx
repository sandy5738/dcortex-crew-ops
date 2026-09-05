/**
 * Tier 1 answers — a lookup returns rows, not ranked options.
 *
 * Same conventions as the rack: hairline separation, no radius, numbers
 * right-aligned with tabular figures, and the table scrolls inside its own
 * container so the page never scrolls sideways.
 */
const HIDE = new Set(["seq"]);

function header(key: string): string {
  return key.replace(/_/g, " ").replace(/\butc\b/i, "UTC");
}

function render(v: unknown): { text: string; numeric: boolean } {
  if (v === null || v === undefined) return { text: "—", numeric: false };
  if (typeof v === "number") return { text: String(v), numeric: true };
  if (typeof v === "boolean") return { text: v ? "yes" : "no", numeric: false };
  if (Array.isArray(v)) return { text: v.join(", ") || "—", numeric: false };
  if (typeof v === "object") return { text: JSON.stringify(v), numeric: false };
  return { text: String(v), numeric: false };
}

export function ResultTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;

  // A single object with nested arrays reads better as a definition list than
  // as a one-row table — getNetworkStats and getRiskSignals are that shape.
  const single = rows.length === 1;
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
    (k) => !HIDE.has(k),
  );

  if (single) {
    const row = rows[0];
    return (
      <dl
        className="text-14"
        style={{ border: "1px solid var(--rule)", background: "var(--strip)" }}
      >
        {keys.map((k, i) => {
          const { text, numeric } = render(row[k]);
          return (
            <div
              key={k}
              className="flex gap-4 px-3 py-1.5"
              style={{ borderTop: i ? "1px solid var(--rule)" : undefined }}
            >
              <dt className="w-56 shrink-0 text-13" style={{ color: "var(--ink-2)" }}>
                {header(k)}
              </dt>
              <dd className={numeric ? "num mono" : ""}>{text}</dd>
            </div>
          );
        })}
      </dl>
    );
  }

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--rule)" }}>
      <table className="w-full text-13" style={{ background: "var(--strip)" }}>
        <thead>
          <tr>
            {keys.map((k) => (
              <th
                key={k}
                className="whitespace-nowrap px-3 py-2 text-left font-medium"
                style={{ color: "var(--ink-2)", borderBottom: "1px solid var(--rule)" }}
              >
                {header(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: i ? "1px solid var(--rule)" : undefined }}>
              {keys.map((k) => {
                const { text, numeric } = render(r[k]);
                return (
                  <td
                    key={k}
                    className={`px-3 py-1.5 align-top ${numeric ? "num text-right mono" : ""}`}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
