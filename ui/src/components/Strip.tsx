/**
 * One option, as a rack strip — UI_DESIGN.md §3.2.
 *
 * Ops rooms ran for decades on paper strips slotted into a metal rack.
 * Controllers still think in strips, so options are strips in a rack, not
 * cards in a grid: wide and short, hairline separation, a colour-coded left
 * edge, one pulled forward to reveal its detail.
 */
import clsx from "clsx";
import { Certificate } from "./Certificate";
import {
  candidateLegality,
  hours,
  inr,
  type Candidate,
  type Legality,
} from "../types";

const EDGE: Record<Legality, string> = {
  legal: "edge-legal",
  breach: "edge-breach",
  caution: "edge-caution",
};

const SOURCE_LABEL: Record<string, string> = {
  reserve: "reserve",
  dayoff: "day-off",
  swap: "swap",
};

export function Strip({
  candidate,
  open,
  cursor,
  onToggle,
}: {
  candidate: Candidate;
  open: boolean;
  cursor: boolean;
  onToggle: () => void;
}) {
  const tone = candidateLegality(candidate);
  const thin =
    candidate.fragility_margin_hours !== null &&
    candidate.fragility_margin_hours < 2;

  return (
    <div className={clsx("strip mb-1.5", EDGE[tone])} data-cursor={cursor}>
      <button
        className="flex w-full items-center gap-4 px-4 py-3 text-left"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span
          className="num w-6 shrink-0 text-16 font-medium"
          style={{ color: "var(--ink-2)" }}
        >
          {candidate.rank_position ?? "—"}
        </span>

        <span className="w-44 shrink-0">
          <span className="mono text-16 font-medium">{candidate.crew_id}</span>
          <span className="ml-2 text-13" style={{ color: "var(--ink-2)" }}>
            {candidate.name}
          </span>
        </span>

        <span
          className="w-20 shrink-0 text-13"
          style={{ color: "var(--ink-2)" }}
        >
          {SOURCE_LABEL[candidate.source] ?? candidate.source}
        </span>

        <span className="num w-28 shrink-0 text-right text-16 font-medium">
          {candidate.cost ? inr(candidate.cost.total_inr) : "—"}
        </span>

        <span className="w-28 shrink-0 text-13">{candidate.coverage}</span>

        <span
          className="num w-24 shrink-0 text-right text-13"
          style={{ color: "var(--ink-2)" }}
          title="forward depletion — optionality consumed"
        >
          {candidate.depletion ? candidate.depletion.weighted.toFixed(3) : "—"}
        </span>

        <span
          className={clsx(
            "num w-28 shrink-0 text-right text-13",
            thin && "v-caution",
          )}
          title="rest margin before this crew member's own next duty"
        >
          {candidate.fragility_margin_hours !== null
            ? hours(candidate.fragility_margin_hours)
            : "—"}
          {thin && <span aria-hidden> !</span>}
        </span>

        {candidate.cost && candidate.cost.delay_hours > 0 && (
          <span className="v-caution shrink-0 text-13">
            +{candidate.cost.delay_hours}h delay
          </span>
        )}
      </button>

      {open && <Certificate candidate={candidate} />}
    </div>
  );
}

/** Column headings for the rack. Kept next to Strip so they cannot drift. */
export function StripHeader() {
  return (
    <div
      className="flex items-center gap-4 px-4 pb-1 text-13"
      style={{ color: "#9aa3a9" }}
    >
      <span className="w-6 shrink-0">#</span>
      <span className="w-44 shrink-0">crew</span>
      <span className="w-20 shrink-0">source</span>
      <span className="w-28 shrink-0 text-right">cost</span>
      <span className="w-28 shrink-0">coverage</span>
      <span className="w-24 shrink-0 text-right">depletion</span>
      <span className="w-28 shrink-0 text-right">rest margin</span>
    </div>
  );
}
