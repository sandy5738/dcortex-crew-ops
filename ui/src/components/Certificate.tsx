/**
 * The verdict certificate — UI_DESIGN.md §3.3, SPEC.md §6.1.
 *
 * Seven rule rows per candidate, collapsed to chips. Clicking a chip expands
 * the trace: the window dates, the per-date inputs, the arithmetic on one
 * line, the margin, and the source file.
 *
 * Both states are built from the SAME RuleVerdict object. If the chip and the
 * trace could disagree, eventually they would.
 *
 * "Nobody else will show the seven dates."
 */
import { useState } from "react";
import clsx from "clsx";
import {
  ALL_RULES,
  GLYPH,
  WORD,
  hoursToHm,
  verdictLegality,
  type Candidate,
  type Legality,
  type RuleVerdict,
} from "../types";

const TONE: Record<Legality, string> = {
  legal: "v-legal",
  breach: "v-breach",
  caution: "v-caution",
};

function RuleChip({
  verdict,
  open,
  onClick,
}: {
  verdict: RuleVerdict;
  open: boolean;
  onClick: () => void;
}) {
  const tone = verdictLegality(verdict);
  return (
    <button
      className={clsx("chip px-2 py-1 mono", TONE[tone])}
      style={open ? { borderColor: "currentColor" } : undefined}
      onClick={onClick}
      aria-expanded={open}
      // Never colour alone: the glyph and the word carry the meaning too.
      aria-label={`${verdict.rule_id} ${WORD[tone]}`}
    >
      <span aria-hidden>{GLYPH[tone]}</span> {verdict.rule_id.replace("RULE-", "")}
    </button>
  );
}

/** The expanded trace. This is the part a controller challenges. */
function RuleTrace({ v }: { v: RuleVerdict }) {
  const tone = verdictLegality(v);
  const dates = v.window ?? [];
  const hasInputs = Object.keys(v.inputs ?? {}).length > 0;

  return (
    <div className="certificate expand mt-2 p-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className={clsx("font-medium", TONE[tone])}>
          {v.rule_id} <span aria-hidden>{GLYPH[tone]}</span>{" "}
          {WORD[tone].toUpperCase()}
        </span>
        {v.source_files?.length > 0 && (
          <span style={{ color: "var(--ink-2)" }}>
            source: {v.source_files.join(", ")}
          </span>
        )}
      </div>

      {dates.length > 0 && (
        <div className="mt-2" style={{ color: "var(--ink-2)" }}>
          window: {dates[0]} → {dates[dates.length - 1]} ({dates.length} UTC
          dates, inclusive)
        </div>
      )}

      {hasInputs ? (
        // The seven dates. The whole point.
        <div
          className="mt-2 grid gap-x-6 gap-y-1"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
        >
          {dates.map((d) => {
            const val = v.inputs[d];
            const proposed = val === undefined;
            return (
              <div key={d} className="flex justify-between tabular-nums">
                <span style={{ color: "var(--ink-2)" }}>{d.slice(5)}</span>
                <span className={proposed ? TONE.caution : undefined}>
                  {proposed ? "proposed" : val.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        dates.length > 0 && (
          <div className="mt-2" style={{ color: "var(--caution)" }}>
            ! per-date breakdown not present on this verdict
            <span style={{ color: "var(--ink-2)" }}>
              {" "}
              — engine must populate RuleVerdict.inputs (tasks/BACKLOG.md)
            </span>
          </div>
        )
      )}

      <div className="mt-3 pt-2" style={{ borderTop: "1px solid var(--rule)" }}>
        <div>{v.detail}</div>
        {v.actual !== null && v.limit !== null && (
          <div className={clsx("mt-1 font-medium", TONE[tone])}>
            {v.actual.toFixed(2)} vs limit {v.limit.toFixed(2)}
            {v.margin !== null && (
              <>
                {" · "}
                {v.margin < 0
                  ? `BREACH by ${hoursToHm(v.margin)}`
                  : `${hoursToHm(v.margin)} headroom`}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Certificate({ candidate }: { candidate: Candidate }) {
  const [openRule, setOpenRule] = useState<string | null>(null);

  // Render in ALL_RULES order regardless of what the engine emitted, so the
  // seven chips are always in the same place on screen.
  const byId = new Map(candidate.verdicts.map((v) => [v.rule_id, v]));
  const ordered = ALL_RULES.map((id) => byId.get(id)).filter(
    (v): v is RuleVerdict => Boolean(v),
  );
  const open = ordered.find((v) => v.rule_id === openRule);

  return (
    <div className="expand px-4 pb-4 pt-1">
      <div className="mb-2 text-13" style={{ color: "var(--ink-2)" }}>
        {ordered.length} rules checked · click one to see the working
      </div>

      <div className="flex flex-wrap gap-1.5">
        {ordered.map((v) => (
          <RuleChip
            key={v.rule_id}
            verdict={v}
            open={openRule === v.rule_id}
            onClick={() =>
              setOpenRule(openRule === v.rule_id ? null : v.rule_id)
            }
          />
        ))}
      </div>

      {open && <RuleTrace v={open} />}

      {candidate.depletion && (
        <div className="mt-3 text-13" style={{ color: "var(--ink-2)" }}>
          Forward cover: covers {candidate.depletion.forward_slots_covered}{" "}
          slots, drops out of {candidate.depletion.forward_slots_lost} ·
          weighted depletion{" "}
          <span className="num" style={{ color: "var(--ink)" }}>
            {candidate.depletion.weighted.toFixed(3)}
          </span>
          {candidate.depletion.thinnest_slot_cover === 1 && (
            <span className="v-breach"> · sole cover on a forward slot</span>
          )}
          <div className="mt-1">
            An ordering signal, not a forecast — the dataset's disruption rates
            are not statistically calibrated.
          </div>
        </div>
      )}
    </div>
  );
}
