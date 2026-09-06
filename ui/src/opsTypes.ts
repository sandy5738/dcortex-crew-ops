/**
 * Shared types for the aerospace ops UI.
 *
 * OpsSnapshot mirrors src/opsSnapshot.ts on the backend — one GET powers
 * the whole deck. ChatResponse mirrors POST /chat: an answer plus the
 * reasoning_trail of every tool call the agent made.
 */

export interface SnapshotCrew {
  crew_id: string;
  name: string;
  rank: string;
  role: string;
}

export interface SnapshotFlight {
  flight_id: string;
  flight_no: string;
  date: string;
  dep_station: string;
  arr_station: string;
  dep_utc: string;
  arr_utc: string;
  block_hours: number;
  aircraft: string;
  aircraft_type: string;
  seats: number;
  crew: SnapshotCrew[];
}

export interface SnapshotReserve {
  crew_id: string;
  name: string;
  rank: string;
  base: string;
  oncall_start: string;
  oncall_end: string;
  dates: string[];
  reachability_minutes: number;
  status: string;
}

export interface SnapshotRisk {
  crew_id: string;
  name: string;
  rank: string;
  base: string;
  status: string;
  disruption_risk_score: number;
  drivers: string[];
  on_pairings: string[];
}

export interface SnapshotDuty {
  crew_id: string;
  name: string;
  rank: string;
  duty_hours_7d: number;
  duty_limit_7d: number;
  flight_hours_28d: number;
  flight_limit_28d: number;
  last_rest_ended: string;
}

export interface SnapshotCertAlert {
  crew_id: string;
  name: string;
  rank: string;
  cert_type: string;
  valid_to: string;
  days_left: number;
}

export interface OpsSnapshot {
  as_of_utc: string;
  dates: string[];
  flights: SnapshotFlight[];
  reserves: SnapshotReserve[];
  risk: SnapshotRisk[];
  duty: SnapshotDuty[];
  cert_alerts: SnapshotCertAlert[];
  stations: string[];
}

export interface ReasoningTrailItem {
  tool_called: string;
  arguments: unknown;
  raw_result: unknown;
}

/** The Tier-3 shape the system prompt asks the LLM to emit for disruptions. */
export interface RankedOption {
  rank: number;
  action: string;
  legal: boolean;
  rules_checked?: string[];
  cost_inr?: number;
  coverage?: string;
  reasoning?: string;
}

export interface ChatResponse {
  answer?: string;
  reasoning_trail?: ReasoningTrailItem[];
  options?: RankedOption[];
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "advisor";
  text: string;
  options?: RankedOption[];
  trail?: ReasoningTrailItem[];
  error?: boolean;
}

/** RAG tier of a tool, straight from the hackathon's language. */
export function tierOfTool(tool: string): 1 | 2 | 3 {
  if (tool.startsWith("get_")) return 1;
  if (tool.startsWith("check_")) return 2;
  return 3;
}
