/**
 * The Verdict contract — what the engine returns and the UI renders.
 *
 * ⚠ Nothing in src/ produces this shape yet. The rules engine returns
 * RuleResult per rule; there is no handler that enumerates candidates, prices
 * them and returns a ranked Verdict. So today this type is a *target*: it
 * describes the object `recommendCover()` must build, and it is exactly what
 * fixtures/verdict_s2.json contains.
 *
 * When that handler lands, this file and the engine's return type must be the
 * same shape. Keep them in one commit — a UI reading a field the engine
 * stopped sending fails silently, which is the worst way for this to break.
 */

export type Rank =
  | "Captain"
  | "First Officer"
  | "Senior Cabin Crew"
  | "Cabin Crew";

export type RuleId =
  | "RULE-FDP-01"
  | "RULE-DUTY-02"
  | "RULE-FLT-03"
  | "RULE-REST-04"
  | "RULE-QUAL-05"
  | "RULE-CERT-06"
  | "RULE-BASE-07";

export type CandidateSource = "reserve" | "dayoff" | "swap";

export const ALL_RULES: RuleId[] = [
  "RULE-FDP-01",
  "RULE-DUTY-02",
  "RULE-FLT-03",
  "RULE-REST-04",
  "RULE-QUAL-05",
  "RULE-CERT-06",
  "RULE-BASE-07",
];

/** The outcome of ONE rule against ONE candidate for ONE assignment. */
export interface RuleVerdict {
  rule_id: RuleId;
  passed: boolean;
  detail: string;
  limit: number | null;
  actual: number | null;
  margin: number | null;
  /** The dates summed, ISO, in order. */
  window: string[];
  /** Per-date source values. Empty on most fixture rows — see fixtures/README.md. */
  inputs: Record<string, number>;
  source_files: string[];
}

export interface CostBreakdown {
  total_inr: number;
  callout_inr: number;
  deadhead_inr: number;
  delay_inr: number;
  hotel_inr: number;
  delay_hours: number;
  detail: string;
}

export interface DepletionScore {
  forward_slots_covered: number;
  forward_slots_lost: number;
  weighted: number;
  duty_hours_after: number;
  duty_limit: number;
  /** 1 ⇒ sole cover somewhere. Flag it loudly. */
  thinnest_slot_cover: number;
  detail: string;
}

export interface Candidate {
  crew_id: string;
  name: string;
  rank: Rank;
  base: string;
  source: CandidateSource;
  /** ALWAYS all 7, pass or fail. */
  verdicts: RuleVerdict[];
  legal: boolean;
  coverage: string;
  coverage_fraction: number;
  cost: CostBreakdown | null;
  depletion: DepletionScore | null;
  /** Rest margin before the candidate's own next duty. */
  fragility_margin_hours: number | null;
  rank_position: number | null;
  action: string;
  reasoning: string;
}

export interface Impact {
  pairing_id: string | null;
  uncovered_flights_day1: string[];
  uncovered_flights_later: string[];
  passengers_at_risk_day1: number;
  passengers_at_risk_total: number;
  affected_pairings: string[];
  downstream_risks: RuleVerdict[];
}

export interface Verdict {
  intent_kind: string;
  query: string;
  impact: Impact | null;
  /** Legal, ranked. */
  options: Candidate[];
  /** Illegal, WITH reasons — always shipped. */
  excluded: Candidate[];
  /** Tier 1 tabular results. */
  rows: Record<string, unknown>[];
  ranking_key: string;
  pool_size: number;
  trace: string[];
  computed_at: string | null;
  caveats: string[];
}

export interface Refusal {
  reason: string;
  suggestion: string;
  unresolved: string[];
}

export type Result = Verdict | Refusal;

export function isRefusal(r: Result): r is Refusal {
  return (r as Refusal).reason !== undefined;
}

// ------------------------------------------------------------- derived UI

/**
 * Colour is a verdict, never decoration (UI_DESIGN.md §2 principle 3).
 * Amber is doing real work: "legal but 75 minutes of margin" is the most
 * operationally interesting state in the system.
 */
export type Legality = "legal" | "breach" | "caution";

export function verdictLegality(v: RuleVerdict): Legality {
  if (!v.passed) return "breach";
  if (v.margin !== null && v.margin >= 0 && v.margin < 2) return "caution";
  return "legal";
}

/** A strip reads amber when its own rest buffer is thin. */
export function candidateLegality(c: Candidate): Legality {
  if (!c.legal) return "breach";
  if (c.fragility_margin_hours !== null && c.fragility_margin_hours < 2)
    return "caution";
  if (c.verdicts.some((v) => verdictLegality(v) === "caution")) return "caution";
  return "legal";
}

/** Never colour alone — every state carries a glyph and a word. */
export const GLYPH: Record<Legality, string> = {
  legal: "✓",
  breach: "✕",
  caution: "!",
};

export const WORD: Record<Legality, string> = {
  legal: "pass",
  breach: "breach",
  caution: "marginal",
};

export function inr(n: number): string {
  return "₹" + n.toLocaleString("en-IN");
}

export function hours(n: number): string {
  return n.toFixed(2) + "h";
}

/** 1.33 -> "1h20m". The margin a controller actually says out loud. */
export function hoursToHm(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `${sign}${h}h${String(m).padStart(2, "0")}m`;
}
