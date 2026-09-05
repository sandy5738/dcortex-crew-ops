/**
 * The rejects — UI_DESIGN.md §3.4, SPEC.md §6.2.
 *
 * Collapsed by default. Grouped by failing rule with a count on each group,
 * because a controller scanning "eleven failed on rest" learns something
 * about the day.
 *
 * This is free — we enumerate the whole rank anyway — and it is the
 * difference between a system a controller trusts and one they double-check.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import type { Candidate, RuleId } from "../types";

function groupByFailingRule(excluded: Candidate[]) {
  const groups = new Map<string, Candidate[]>();
  for (const c of excluded) {
    const failed = c.verdicts.filter((v) => !v.passed).map((v) => v.rule_id);
    // A candidate failing several rules is listed under each, so the counts
    // answer "how many were blocked by rest?" rather than "how many rows".
    const keys: string[] = failed.length ? failed : ["other"];
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(c);
    }
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function reasonFor(c: Candidate, ruleId: string): string {
  const v = c.verdicts.find((x) => x.rule_id === ruleId && !x.passed);
  return v?.detail ?? "";
}

export function ExclusionPanel({ excluded }: { excluded: Candidate[] }) {
  const [open, setOpen] = useState(false);
  if (excluded.length === 0) return null;

  const groups = groupByFailingRule(excluded);

  return (
    <div className="mt-6">
      <button
        className="flex items-center gap-1.5 text-13"
        style={{ color: "var(--ink-2)" }}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        id="exclusion-toggle"
      >
        <ChevronRight
          size={14}
          className={clsx("transition-transform", open && "rotate-90")}
          aria-hidden
        />
        {excluded.length} excluded — click to review
      </button>

      {open && (
        <div className="expand mt-3 space-y-4">
          {groups.map(([ruleId, members]) => (
            <div key={ruleId}>
              <div className="mono mb-1 text-13" style={{ color: "var(--ink-2)" }}>
                {ruleId} · {members.length}
              </div>
              <div style={{ border: "1px solid var(--rule)" }}>
                <table className="w-full text-13">
                  <tbody>
                    {members.map((c, i) => (
                      <tr
                        key={c.crew_id}
                        style={{
                          background: "var(--strip)",
                          borderTop: i ? "1px solid var(--rule)" : undefined,
                        }}
                      >
                        <td className="mono px-3 py-1.5 align-top">
                          {c.crew_id}
                        </td>
                        <td
                          className="px-3 py-1.5 align-top"
                          style={{ color: "var(--ink-2)" }}
                        >
                          {c.rank}
                        </td>
                        <td className="px-3 py-1.5 align-top">
                          {reasonFor(c, ruleId as RuleId)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
