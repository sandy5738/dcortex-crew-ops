/**
 * Answer header — UI_DESIGN.md §3.1.
 *
 * One line of situation, one line of arithmetic-of-the-search. That second
 * line does more work than it looks: it tells the controller the search was
 * exhaustive, which is the whole basis for trusting the first strip.
 */
import type { Verdict } from "../types";

export function Header({
  verdict,
  degraded,
}: {
  verdict: Verdict;
  degraded: boolean;
}) {
  const im = verdict.impact;
  const legal = verdict.options.length;
  const excluded = verdict.excluded.length;
  const evaluated = legal + excluded;
  // pool_size can exceed what we evaluated (crew on leave, the sick person).
  // Say so rather than letting the header quietly fail to add up.
  const skipped = Math.max(0, verdict.pool_size - evaluated);

  const legs =
    (im?.uncovered_flights_day1.length ?? 0) +
    (im?.uncovered_flights_later.length ?? 0);

  return (
    <header className="mb-4">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-20 font-medium">
          {im?.pairing_id ? (
            <>
              {im.pairing_id}
              {legs > 0 && (
                <span style={{ color: "var(--ink-2)" }}>
                  {" · "}
                  {legs} legs
                </span>
              )}
              {im.passengers_at_risk_day1 > 0 && (
                <span className="num" style={{ color: "var(--ink-2)" }}>
                  {" · "}
                  {im.passengers_at_risk_day1} passengers at risk
                </span>
              )}
            </>
          ) : (
            verdict.intent_kind
          )}
        </h1>

        {degraded && (
          // Not an error. The system still answers everything; only the
          // phrasing tolerance narrows. Saying so plainly is a trust feature.
          <span
            className="shrink-0 px-2 py-1 text-13"
            style={{
              border: "1px solid var(--caution)",
              color: "var(--caution)",
            }}
          >
            ! structured input mode
          </span>
        )}
      </div>

      <div className="num mt-1 text-14" style={{ color: "var(--ink-2)" }}>
        {verdict.pool_size} candidates considered · {legal} legal ·{" "}
        {excluded} excluded
        {skipped > 0 && <> · {skipped} not evaluated</>}
      </div>

      {im && im.uncovered_flights_day1.length > 0 && (
        <div className="mono mt-2 text-13">
          <span className="v-breach">uncrewed now</span>{" "}
          <span style={{ color: "var(--ink-2)" }}>
            {im.uncovered_flights_day1.join("  ")}
          </span>
        </div>
      )}
      {im && im.uncovered_flights_later.length > 0 && (
        <div className="mono text-13">
          <span className="v-caution">at risk</span>{" "}
          <span style={{ color: "var(--ink-2)" }}>
            {im.uncovered_flights_later.join("  ")}
          </span>
        </div>
      )}
    </header>
  );
}
