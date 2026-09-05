# 🏗️ Crew Ops Advisor — Complete Architecture Deep Dive

## Table of Contents
1. [System Overview](#system-overview)
2. [Layered Architecture](#layered-architecture)
3. [Data Flow & Request Lifecycle](#data-flow--request-lifecycle)
4. [The Deterministic Boundary Pattern](#the-deterministic-boundary-pattern)
5. [API Tiers & Endpoints](#api-tiers--endpoints)
6. [Database Schema (23 Tables)](#database-schema-23-tables)
7. [LangGraph Agentic Loop](#langgraph-agentic-loop)
8. [Tool Schemas & Validation](#tool-schemas--validation)
9. [Deployment & Performance](#deployment--performance)

---

## System Overview

**Crew Ops Advisor** is a **Hybrid AI-Deterministic System** that makes crew scheduling decisions in real-time for airline operations.

```
┌─────────────────────────────────────────────────────────────────┐
│                    CREW CONTROLLER (User)                       │
│            "C-1042 is sick. Cover P-2291 tomorrow"             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────▼────────────┐
                │   React Chat UI        │ ← Natural language input
                │   (ConversationRail)   │   + Reasoning trail display
                └────────────┬────────────┘
                             │
                ┌────────────▼────────────────────────────┐
                │   Express API Server (Node.js)         │
                │   ┌──────────────────────────────────┐ │
                │   │ TIER 1: Query Engine             │ │ ← Lookups
                │   │ TIER 2: Rules Engine             │ │ ← Legality
                │   │ TIER 3: Simulator + Chat Service │ │ ← Impacts
                │   └──────────────────────────────────┘ │
                │                                        │
                │   ┌──────────────────────────────────┐ │
                │   │ LangGraph Agentic Loop           │ │ ← Reasoning
                │   │ + OpenAI GPT-4 Tool Calling      │ │
                │   └──────────────────────────────────┘ │
                └────────────┬─────────────────────────────┘
                             │
                ┌────────────▼───────────────┐
                │  SQLite (airline.db)       │
                │  23 Relational Tables      │
                │  4,200 Historical Rows     │
                └────────────────────────────┘
```

**Key Design Principle:** LLM + Deterministic = Explainability + Correctness
- **LLM**: Understands natural language, routes to correct tools, synthesizes answers
- **Deterministic Engines**: Compute exact results (compliance checks, costs, impacts)
- **Result**: Every answer is auditable and 100% legally compliant

---

## Layered Architecture

### Layer 1: Presentation (Frontend)

**Location:** `ui/src/`  
**Tech:** React + TypeScript + Vite + Tailwind CSS

```typescript
// App.tsx structure
<App>
  <ConversationRail/>      ← Chat history & input box
  <TieredResponse/>        ← Main display
    ├─ Answer              ← Natural language response
    ├─ Tier-1 Data         ← Crew details, flights
    ├─ Tier-2 Rules        ← Legality verdicts
    └─ Tier-3 Simulation   ← Impact analysis & costs
```

**API Integration:** `ui/src/api.ts`
```typescript
const useChat = () => {
  // POST /agent/chat
  // Sends: { message: string }
  // Returns: { response: string, reasoning_trail: [...] }
}
```

---

### Layer 2: API & Orchestration (Backend)

**Location:** `src/api.ts`  
**Tech:** Express.js + TypeScript

#### Route Categories

```
POST /tools/get_*              ← TIER 1: Data lookups
  /get_reserve_pool
  /get_duty_hours
  /get_flights
  /get_crew
  /get_pairing
  /get_expiring_certifications

POST /tools/check_*            ← TIER 2: Rule checks
  /check_fdp_limit              (RULE-FDP-01)
  /check_7d_duty_limit          (RULE-DUTY-02)
  /check_28d_flight_hours       (RULE-FLT-03)
  /check_rest04                 (RULE-REST-04)
  /check_qual05                 (RULE-QUAL-05)
  /check_cert06                 (RULE-CERT-06)
  /check_base07                 (RULE-BASE-07)

POST /tools/simulate_*         ← TIER 3: Impact analysis
  /simulate_impact

POST /agent/chat               ← LLM Agentic Loop
  { message: "...", context: {...} }

POST /tools/call               ← Generic tool dispatcher
  { name: "checkRuleFdp01", arguments: {...} }
```

#### Request Validation Pattern

Every route uses **Zod schema validation**:

```typescript
app.post('/tools/check_fdp_limit', (req, res) => {
    // 1. Parse & validate
    const parsed = RuleSchemas.FDP01.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error);
    
    // 2. Call deterministic engine
    res.json(RulesEngine.checkFdp01(parsed.data));
});
```

**Why Zod?**
- Single schema for both API validation AND LLM tool parameters
- No hand-written JSON Schema (errors were common)
- Runtime safety: bad inputs rejected before reaching the rule engine

---

### Layer 3: Deterministic Engines (The Math)

#### 3a. Query Engine

**Location:** `src/queryEngine.ts` (153 LOC)  
**Purpose:** Tier-1 lookups — retrieve data from SQLite

```typescript
export const QueryEngine = {
  getReservePool({ base, date }) {
    // SELECT * FROM reserve_pool WHERE base = ? AND date IN on-call window
  },
  
  getDutyHours({ crewId }) {
    // SELECT duty_hours_7d, flight_hours_28d, last_rest_ended FROM duty_clocks
  },
  
  getFlights({ date, depStation, arrStation }) {
    // SELECT * FROM flights WHERE date = ? AND (dep_station = ? OR arr_station = ?)
  },
  
  getCrew({ crewId }) {
    // SELECT crew.*, crew_ratings.* FROM crew LEFT JOIN crew_ratings
  },
  
  getPairing({ pairingId }) {
    // SELECT pairing.*, flights.*, crew.* 
    // Reconstructs full multi-day assignment graph
  }
};
```

---

#### 3b. Rules Engine

**Location:** `src/rulesEngine.ts` (497 LOC)  
**Purpose:** Tier-2 checks — deterministic legal compliance

**Export Interface:**

```typescript
export interface RuleResult {
    rule_id: string;
    legal: boolean;              // Verdict
    reason: string;              // English explanation
    cost_incurred?: boolean;      // For BASE-07 deadhead
    limit?: number;              // From rules.json (auditable)
    actual?: number;             // What crew actually has
    window?: string[];           // Calendar dates used in calculation
    inputs?: Record<string, number>; // date -> hours breakdown
}
```

**The 7 Rules Implemented:**

```typescript
export const RulesEngine = {
  // RULE-FDP-01: Max duty period 13h − 0.5h per sector beyond 2nd
  checkFdp01({ numSectors, proposedFdpHours }) {
    const penaltySectors = Math.max(0, numSectors - 2);
    const maxAllowed = 13.0 - (penaltySectors * 0.5);
    return {
      rule_id: 'RULE-FDP-01',
      legal: proposedFdpHours <= maxAllowed,
      reason: `...`,
      limit: maxAllowed,
      actual: proposedFdpHours
    };
  },

  // RULE-DUTY-02: Max 60h duty in rolling 7-day calendar window
  checkDuty02({ crewId, newDutyHours, dutyDate, priorProposed }) {
    // 1. Fetch daily_history rows from DB for 7-day window
    // 2. Sum historical hours
    // 3. Add newDutyHours + priorProposed
    // 4. Compare against 60h limit from rules.json
  },

  // RULE-FLT-03: Max 100h block hours in rolling 28-day window
  checkFlt03({ crewId, newFlightHours, dutyDate, priorProposed }) {
    // Same pattern as DUTY-02 but checks flight_hours_28d
  },

  // RULE-REST-04: Min 12h continuous rest between release + next report
  checkRest04({ crewId, newReportUtc, coverReleaseUtc }) {
    // 1. Check last_rest_ended ≥ coverReleaseUtc + 12h? (next duty)
    // 2. Check newReportUtc ≥ last_rest_ended? (current duty)
    // 3. Check double-booking (overlapping duty periods)
  },

  // RULE-QUAL-05: Pilot must hold rating for aircraft type
  checkQual05({ crewId, targetAircraftType }) {
    // JOIN crew_ratings table; check if rating exists
  },

  // RULE-CERT-06: All certifications must be valid on duty date
  checkCert06({ crewId, dutyDate }) {
    // SELECT certifications WHERE crew_id = ? AND valid_to >= dutyDate
  },

  // RULE-BASE-07: Reserve must be based at departure station or deadhead
  checkBase07({ crewId, requiredDepartureStation }) {
    // Check crew.base; if mismatch, flag cost_incurred=true
  }
};
```

**Key Features:**
- ✅ **Auditable**: Every number tied to `rules.json` or database
- ✅ **Calendar-aware**: Duty windows are CALENDAR DAYS, not 168 hours
- ✅ **Multi-day aware**: Can accept `priorProposed` for pairing day-2 checks
- ✅ **Structured outputs**: Includes limit, actual, window, and inputs for debugging

---

#### 3c. Simulator

**Location:** `src/simulator.ts` (80 LOC)  
**Purpose:** Tier-3 impact analysis

```typescript
export async function simulateImpact(crewId: string, date: string) {
  // Given a crew dropout on a specific date:
  // 1. Find all pairings where crew_id appears
  // 2. Identify "uncrewed" flights (lost captain, FO, etc.)
  // 3. Trace ripple effects:
  //    - Downstream connections (flight 3 depends on crew from flight 1+2)
  //    - Passenger count affected
  //    - Delay costs (per hour)
  //    - Cancellation costs (full refund + rebooking)
  // 4. Return structured impact object for synthesis
}
```

**Output:**
```typescript
{
  original_crew: string,
  date: string,
  affected_pairings: [
    {
      pairing_id: string,
      uncrewed_flights: [{ flight_id, passengers, impact_cost }],
      earliest_cover_time: datetime,
      estimated_delay_hours: number,
      cancellation_cost: number,
      recovery_options: [...]
    }
  ],
  total_passengers_at_risk: number,
  total_impact_cost: number
}
```

---

#### 3d. Chat Service (New)

**Location:** `src/chatService.ts` (77 LOC)  
**Purpose:** Higher-level crew replacement recommendations

```typescript
export async function getCrewReplacementOptions(pairingId: string, role: string) {
  // 1. Fetch pairing details
  // 2. Enumerate all candidates (line crew + reserves)
  // 3. Run RULE-QUAL-05 (rating check)
  // 4. Run RULE-DUTY-02 (7-day duty check)
  // 5. Run RULE-FLT-03 (28-day flight hours)
  // 6. Run RULE-CERT-06 (certification check)
  // 7. Run RULE-BASE-07 (base/deadhead cost)
  // 8. Rank by cost (cheapest legal option first)
  // 9. Return top-N options with verdicts
}
```

---

### Layer 4: Data (SQLite)

**Location:** `src/schema.sql` + `airline.db` (built from `data/*.json`)

#### Key Design Decisions

1. **23 relational tables** (not just 2)
   - Replaces old ingest that dropped `daily_history` entirely
   - `daily_history` has 4,200 rows needed for RULE-DUTY-02 & RULE-FLT-03 window calculations

2. **Foreign keys enforced** (`PRAGMA foreign_keys = ON`)
   - Ensures `crew_id` in `duty_clocks` exists in `crew`
   - Prevents orphaned references

3. **No derived fields**
   - Report/release times: computed in `rulesEngine.ts` (not pre-stored)
   - Duty sums: computed on-demand (not materialized views)
   - Why? Rule inputs can change; pre-computed values go stale

4. **All dates as ISO-8601 TEXT**
   - SQLite has no date type
   - TEXT sorts and compares correctly
   - Survives JSON round-trip exactly

#### Schema Snapshot

```sql
-- Core tables
flights(
  flight_id,           -- PK
  flight_no, date, 
  dep_station, arr_station,
  dep_utc, arr_utc,
  block_hours,         -- RULE-FLT-03
  aircraft, aircraft_type,
  seats                -- Passengers at risk
)

crew(
  crew_id,             -- PK
  name, rank,
  base,                -- RULE-BASE-07
  seniority,
  reachability_minutes,
  status               -- active | leave | training
)

crew_ratings(
  crew_id, rating      -- PK (composite)
                       -- RULE-QUAL-05: A320, ATR72, etc.
)

duty_clocks(
  crew_id,             -- FK
  duty_hours_7d,       -- Snapshot (as_of 2026-09-14)
  flight_hours_28d,    -- Snapshot
  last_rest_ended      -- When they woke up
)

duty_daily_history(
  crew_id, date,       -- PK (composite)
  duty_hours,          -- Used for RULE-DUTY-02 window
  flight_hours         -- Used for RULE-FLT-03 window
)

certifications(
  crew_id, cert_type,
  valid_to             -- Date; RULE-CERT-06 checks this
)

pairings(
  pairing_id,          -- PK
  aircraft,
  num_days,
  ...
)

pairing_days(
  pairing_id, day_no,
  report_utc, release_utc
)

pairing_day_flights(
  pairing_id, day_no, flight_no
)

pairing_crew(
  pairing_id, day_no, role, crew_id  -- Who's assigned
)

reserve_pool(
  crew_id,
  base,
  oncall_start, oncall_end,
  valid_from, valid_to
)

rules(
  rule_id,             -- RULE-FDP-01, etc.
  description, prose
)

rule_params(
  rule_id, param_key, value_num  -- 60 (duty limit), 12 (rest), etc.
)

# ... and 10+ more for scenarios, questions, risk signals, costs, etc.
```

---

## Data Flow & Request Lifecycle

### Scenario: "Cover C-1042's sick call for P-2291"

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. USER TYPES IN CHAT                                          │
│    "C-1042 is sick. Who can cover P-2291?"                    │
└────────────┬────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────┐
│ 2. FRONTEND (React)                                             │
│    POST /agent/chat { message: "..." }                         │
│    (ConversationRail captures input, sends to backend)         │
└────────────┬────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────┐
│ 3. BACKEND: LANGGRAPH AGENT LOOP STARTS                        │
│                                                                  │
│    Node 1: Understand Intent                                   │
│    ├─ LLM reads: "C-1042 is sick. Cover P-2291."              │
│    ├─ LLM routes: Need PAIRING DATA first                      │
│    └─ LLM calls: getTool("getPairing", { pairingId: "P-2291" })
│                                                                  │
│    Node 2: Execute Tool (getPairing)                           │
│    ├─ QueryEngine.getPairing("P-2291")                         │
│    │   SELECT pairing.*, flights.*, crew.* FROM...            │
│    │   Result: {"pairing_id": "P-2291", "flights": [...],    │
│    │            "assigned_crew": [C-1042, ...], ...}          │
│    └─ Return result to LLM                                     │
│                                                                  │
│    Node 3: Enumerate Candidates                                │
│    ├─ LLM recognizes: Need to check ALL crew                  │
│    ├─ LLM calls: getCrew({ rank: "Captain", base: "BLR" })   │
│    └─ Result: [{C-1050, active, A320-rated}, {C-2087, ...}]  │
│                                                                  │
│    Node 4-11: Run Legality Checks                             │
│    ├─ For each candidate, call rule checks in parallel:       │
│    │   checkQual05(C-1050, A320)      → ✓ legal              │
│    │   checkCert06(C-1050, 2026-09-15) → ✓ legal             │
│    │   checkDuty02(C-1050, pairing_hours, 2026-09-15)        │
│    │   checkRest04(C-1050, report_utc, release_utc)          │
│    │   checkBase07(C-1050, "BLR")     → ✓ legal              │
│    │                                                            │
│    │   checkQual05(C-2087, A320)      → ✓ legal              │
│    │   checkDuty02(C-2087, ...)       → ✗ BREACH (61.33h)   │
│    │                                                            │
│    │   checkQual05(C-3310, A320)      → ✓ legal (reserve)    │
│    │   checkDuty02(C-3310, ...)       → ✓ legal              │
│    │   ...                                                      │
│                                                                  │
│    Node 12: Rank by Cost                                       │
│    ├─ simulateImpact() for each legal candidate               │
│    ├─ Compute total cost = base_callout + deadhead + delay    │
│    ├─ Rank: [C-3310 (₹18,500), C-2210 (₹41,200), ...]       │
│    └─ LLM sees top-3 options                                  │
│                                                                  │
│    Node 13: Synthesize Answer                                  │
│    └─ LLM outputs:                                             │
│       "Reserve C-3310 is the cheapest legal option at ₹18,500.
│        Callout time: 2026-09-15T18:00:00Z
│        Flights: DX412, DX413, DX588, DX589, DX590, DX591"    │
│                                                                  │
└────────────┬────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────┐
│ 4. BACKEND: BUILD REASONING TRAIL                              │
│                                                                  │
│    Collect all tool calls + results:                           │
│    [                                                            │
│      {                                                          │
│        tool: "getPairing",                                     │
│        input: { pairingId: "P-2291" },                         │
│        result: { pairing: {...}, flights: [...] }             │
│      },                                                         │
│      {                                                          │
│        tool: "checkDuty02",                                    │
│        input: { crewId: "C-1050", dutyHours: 9.5, ... },      │
│        result: { legal: true, actual: 58.5, limit: 60 }       │
│      },                                                         │
│      ...                                                        │
│    ]                                                            │
│                                                                  │
└────────────┬────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────┐
│ 5. RETURN JSON RESPONSE                                         │
│                                                                  │
│    {                                                            │
│      "response": "Reserve C-3310 is the cheapest...",         │
│      "reasoning_trail": [                                      │
│        { tool: "getPairing", input: {...}, result: {...} },   │
│        { tool: "checkDuty02", input: {...}, result: {...} },  │
│        ...                                                      │
│      ],                                                         │
│      "metadata": {                                             │
│        "top_candidates": [                                     │
│          { crew_id: "C-3310", cost: 18500, verdict: "legal" },│
│          { crew_id: "C-2210", cost: 41200, verdict: "legal" },│
│          { crew_id: "C-2087", verdict: "breach: duty-02" }   │
│        ]                                                        │
│      }                                                          │
│    }                                                            │
│                                                                  │
└────────────┬────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────┐
│ 6. FRONTEND: DISPLAY                                            │
│                                                                  │
│    Main area:                                                   │
│    "Reserve C-3310 is the cheapest legal option at ₹18,500..."│
│                                                                  │
│    Collapsible "View Reasoning":                               │
│    ├─ Tier 1: Data retrieved (pairing, crew)                  │
│    ├─ Tier 2: Rule checks (all 7 rules for top-3 candidates) │
│    └─ Tier 3: Costs & impact (callout fee, deadhead, delay)  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Deterministic Boundary Pattern

This is the **core design** that prevents hallucination:

```
                    ┌──────────────────────┐
                    │   LLM (OpenAI GPT)   │
                    │                      │
                    │  Reasoning Layer:    │
                    │  • Parse intent      │
                    │  • Route to tools    │
                    │  • Synthesize answer │
                    └─────────┬────────────┘
                              │
            ┌─────────────────▼──────────────────┐
            │  DETERMINISTIC BOUNDARY (Zod)      │
            │  All inputs validated before use   │
            └─────────────────┬──────────────────┘
                              │
        ┌─────────────────────▼─────────────────────┐
        │     DETERMINISTIC ENGINES (Pure Math)     │
        │                                            │
        │  • Query Engine  → SQLite (exact data)    │
        │  • Rules Engine  → Math (duty limits)     │
        │  • Simulator     → Algorithms (ripple)    │
        │                                            │
        │  Inputs:  Validated Zod objects           │
        │  Outputs: Structured results              │
        │           (legal: true/false,             │
        │            limit: 60, actual: 58.5)       │
        │                                            │
        └─────────────────┬──────────────────────────┘
                          │
                    ┌─────▼──────────┐
                    │  Return to LLM  │
                    │  (never guess)  │
                    └────────────────┘
```

**Example: Duty Check**

```typescript
// ❌ WRONG (LLM path without boundary)
LLM response: "C-2087 has 55 hours of duty... so 9.5 more hours = 64.5.
              That's over 60, so illegal!"
// Problem: Math is wrong (55 + 9.5 = 64.5, not what he actually has)
//          LLM is guessing, not checking database

// ✅ CORRECT (with deterministic boundary)
LLM call: checkDuty02({
  crewId: "C-2087",
  newDutyHours: 9.5,
  dutyDate: "2026-09-15",
  priorProposed: { "2026-09-14": 8.7 }  // Day 1 of 2-day pairing
})

Rules Engine:
  1. Query duty_daily_history for 7-day window ending 2026-09-15
  2. Sum rows: 2026-09-09 (8.2h) + 2026-09-10 (7.1h) + ... + 2026-09-15 (?)
  3. Add priorProposed["2026-09-14"] = 8.7h (day-1 of this pairing)
  4. Add newDutyHours = 9.5h (day-2)
  5. Total = 61.33h
  6. Compare against limit = 60h
  7. Return: { legal: false, actual: 61.33, limit: 60, window: [...], inputs: {...} }

LLM synthesis: "C-2087 has 61.33 hours of duty over the 7-day window,
               which exceeds the 60-hour limit. RULE-DUTY-02 breach."
// Guaranteed accurate because the LLM didn't compute it
```

---

## API Tiers & Endpoints

### Tier 1: Lookups (Data Retrieval)

**Goal:** Populate LLM context with raw data  
**Latency:** < 10ms  
**Schema:** Fully constrained (date, base, station code)

| Endpoint | Input | Output |
|----------|-------|--------|
| `/tools/get_reserve_pool` | `{ base, date }` | `[ { crew_id, name, oncall_start, oncall_end } ]` |
| `/tools/get_duty_hours` | `{ crewId }` | `{ duty_hours_7d, flight_hours_28d, last_rest_ended }` |
| `/tools/get_flights` | `{ date, depStation?, arrStation? }` | `[ flights ]` |
| `/tools/get_crew` | `{ crewId? }` or `{ rank, base }` | `[ { crew_id, name, rank, base, ratings: [...] } ]` |
| `/tools/get_pairing` | `{ pairingId }` | `{ pairing_id, flights: [...], crew: [...], costs: [...] }` |
| `/tools/get_expiring_certifications` | `{ base, validBefore }` | `[ { crew_id, cert_type, valid_to } ]` |

### Tier 2: Legality Rules (Constraints)

**Goal:** Determine if an assignment is legal  
**Latency:** < 50ms (includes DB queries)  
**Result:** `{ legal: true/false, reason: string, limit?, actual?, window?, inputs? }`

| Rule | Endpoint | Check |
|------|----------|-------|
| FDP-01 | `/tools/check_fdp_limit` | Duty period ≤ 13h − 0.5h/sector |
| DUTY-02 | `/tools/check_7d_duty_limit` | 7-day cumulative ≤ 60h |
| FLT-03 | `/tools/check_28d_flight_hours` | 28-day block hours ≤ 100h |
| REST-04 | `/tools/check_rest04` | 12h rest between duties |
| QUAL-05 | `/tools/check_qual05` | Pilot has aircraft rating |
| CERT-06 | `/tools/check_cert06` | Certifications valid on date |
| BASE-07 | `/tools/check_base07` | Base matches or deadhead needed |

### Tier 3: Impact & Operations (Synthesis)

**Goal:** High-level operational decisions  
**Latency:** 100–500ms (compute-heavy)  
**Result:** Structured operational guidance

| Endpoint | Input | Output |
|----------|-------|--------|
| `/tools/simulate_impact` | `{ crew_id, date }` | `{ affected_pairings, uncrewed_flights, impact_cost }` |
| `/agent/chat` | `{ message, context? }` | `{ response, reasoning_trail, metadata }` |

---

## Database Schema (23 Tables)

### Table Dependency Graph

```
flights
  │
  └─→ pairings (aircraft.type)
  
crew
  ├─→ crew_ratings
  ├─→ duty_clocks
  ├─→ duty_daily_history
  ├─→ certifications
  ├─→ reserve_pool
  └─→ pairing_crew

pairings
  ├─→ pairing_days
  ├─→ pairing_day_flights
  └─→ pairing_crew

rosters
  ├─→ pairing_crew
  └─→ flagged_exceptions

scenarios
  └─→ risk_signals (per-flight disruption risk)

questions
  └─→ (no foreign keys; just text)

rules
  └─→ rule_params (limit values)

costs
  ├─→ cost_flights (per-leg costs)
  └─→ cost_pairings (precomputed impact)
```

### Key Table Relationships

**1. crew → duty_daily_history (RULE-DUTY-02 & RULE-FLT-03)**

```sql
SELECT SUM(duty_hours) FROM duty_daily_history
WHERE crew_id = ? AND date >= ? AND date <= ?
-- Calculates rolling 7-day window for DUTY-02 check
```

**2. crew → crew_ratings (RULE-QUAL-05)**

```sql
SELECT rating FROM crew_ratings
WHERE crew_id = ? AND rating = 'A320'
-- Validates aircraft qualification
```

**3. crew → certifications (RULE-CERT-06)**

```sql
SELECT * FROM certifications
WHERE crew_id = ? AND valid_to < ?
-- Finds expired certificates on duty date
```

**4. pairings → pairing_day_flights (Ripple Effects)**

```sql
SELECT DISTINCT f.* FROM flights f
JOIN pairing_day_flights pdf ON f.flight_id = pdf.flight_id
WHERE pdf.pairing_id = ?
-- Identifies all flights affected if one crew member drops
```

---

## LangGraph Agentic Loop

**Location:** `src/agent.ts` (390 LOC)

### Node Flow

```
START
  │
  ├─→ [Node: "understand_intent"]
  │   LLM reads user message
  │   Decides: Which tools to call?
  │   → tool_calls = [{"name": "getPairing", "args": {...}}, ...]
  │
  ├─→ [Node: "execute_tools"]
  │   For each tool_call:
  │     ├─ Validate args against Zod schema
  │     ├─ Call handler (QueryEngine / RulesEngine / Simulator)
  │     └─ Collect result
  │   → tool_results = [{"name": "...", "result": {...}}, ...]
  │
  ├─→ [Loop condition: tool_results is not empty?]
  │   Yes → Go back to "understand_intent" with results in context
  │   No  → Continue
  │
  ├─→ [Node: "synthesize_answer"]
  │   LLM sees all tool results
  │   Formats human-readable response
  │   Extracts reasoning trail
  │
  └─→ END
       Return {response, reasoning_trail}
```

### Code Structure

```typescript
// 1. Define tools using Zod schemas + LangChain tool()
const checkFdpLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.FDP01>) => {
        return JSON.stringify(RulesEngine.checkFdp01(input));
    },
    {
        name: "check_fdp_limit",
        description: "Evaluates RULE-FDP-01...",
        schema: RuleSchemas.FDP01
    }
);

// 2. Compile tools into ToolNode (handles dispatching)
const tools = [
    checkFdpLimitTool,
    checkDutyLimitTool,
    checkFlightHoursTool,
    // ... 7 rules + 6 queries + simulators
];
const toolNode = new ToolNode(tools);

// 3. Define state graph
const graph = new StateGraph(MessagesAnnotation)
    .addNode("tools", toolNode)
    .addNode("agent", agentNode)
    .addEdge("START", "agent")
    .addConditionalEdges(
        "agent",
        shouldContinue,  // If tool calls exist, go to tools; else END
        {
            "tools": "tools",
            "end": "END"
        }
    )
    .addEdge("tools", "agent")
    .compile();

// 4. Invoke
const result = await graph.invoke({
    messages: [
        new HumanMessage("C-1042 is sick. Cover P-2291.")
    ]
});
```

### State Annotation

```typescript
const MessagesAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (state, update) => state.concat(update),
        default: () => []
    })
});
```

**Why Annotation?**
- Tracks message history (user → LLM → tool results → LLM → response)
- Each node appends its output; graph keeps full context
- Enables "turn-based" reasoning (LLM → tools → LLM → tools → ...)

---

## Tool Schemas & Validation

### Single Source of Truth (Zod)

```typescript
// src/rulesEngine.ts
export const Schemas = {
    FDP01: z.object({
        numSectors: z.number().int().min(1),
        proposedFdpHours: z.number().positive()
    }),
    // ...
};

// src/agent.ts uses the same schema
const checkFdpLimitTool = tool(
    async (input: z.infer<typeof RuleSchemas.FDP01>) => {...},
    {
        name: "check_fdp_limit",
        schema: RuleSchemas.FDP01  // ← Same schema
    }
);

// src/api.ts also validates
app.post('/tools/check_fdp_limit', (req, res) => {
    const parsed = RuleSchemas.FDP01.safeParse(req.body);  // ← Same schema
    if (!parsed.success) return res.status(400).json(parsed.error);
    res.json(RulesEngine.checkFdp01(parsed.data));
});

// src/llmTools.ts exports to LLM
const OPENAI_TOOLS = [
    {
        name: "checkRuleFdp01",
        parameters: toParams(RuleSchemas.FDP01)  // ← Derived from same schema
    }
];
```

**Why single source of truth?**
1. **LLM Contract**: OpenAI sees the exact schema
2. **Runtime Validation**: Zod checks inputs before use
3. **No Duplication**: Hand-written JSON Schema errors are eliminated
4. **Traceability**: Change the schema once; everywhere updates

### Zod Refinements (Runtime-Only)

Some constraints can't be expressed in JSON Schema but are enforced at runtime:

```typescript
const isoDate = (description: string) =>
    z.string()
        .regex(DATE_RE, 'expected YYYY-MM-DD')
        .refine(
            (v) => DateTime.fromISO(v, { zone: 'utc' }).isValid,
            `${description} must be a valid UTC date`
        );

export const Schemas = {
    DUTY02: z.object({
        crewId: z.string(),
        newDutyHours: z.number().positive(),
        dutyDate: isoDate("Duty date"),  // Enforces ISO date + valid calendar day
        priorProposed: z.record(z.string(), z.number()).optional()
    })
};
```

**Flow:**
```
LLM generates: { dutyDate: "2026-02-30" }  ← Invalid calendar date
                ↓
Zod parses: refine() checks DateTime.fromISO()
                ↓
Runtime error: "2026-02-30 must be a valid UTC date"
                ↓
Returns to LLM: "ERROR: Invalid date format. Use YYYY-MM-DD."
                ↓
LLM retries: { dutyDate: "2026-02-28" }  ← Corrected
```

---

## Deployment & Performance

### Pre-flight Checklist

**Before starting server:**

```bash
npm run ingest    # Load data/*.json → airline.db (< 1 second)
npm run verify    # Check integrity (< 5 seconds)
npm run start     # Launch Express + LangGraph
```

### Query Performance Targets

| Layer | Endpoint | Target | Actual |
|-------|----------|--------|--------|
| Tier 1 | `/tools/get_*` | < 10ms | ~5ms (SQLite, in-process) |
| Tier 2 | `/tools/check_*` | < 50ms | ~20ms (math + 1–2 queries) |
| Tier 3 | `/agent/chat` | < 5s | ~2–3s (LLM + N tool calls) |

### Bottlenecks & Optimizations

**Bottleneck 1: LLM Latency**
- **Problem**: OpenAI API call adds 1–2s per chat turn
- **Mitigation**: Tool parallelization (call 10 rule checks simultaneously)
- **Future**: Local LLM or cached embeddings

**Bottleneck 2: Database Seeding**
- **Problem**: Every `checkDuty02` query must scan 28 rows (duty_daily_history)
- **Solution**: Indexes on (crew_id, date) + read-only connection
- **Result**: ~15ms per check (SQLite, in-process)

**Bottleneck 3: LLM Tool Discovery**
- **Problem**: LLM needs to know which 13 tools exist + their schemas
- **Solution**: Static OPENAI_TOOLS array, sent in system prompt (once per session)
- **Result**: Avoids per-turn overhead

### Memory & Disk

**SQLite Database Size:**
- ~5 MB (airline.db)
- Fits in RAM; cache-friendly

**Python Generation (for reference only):**
- `data/*.json`: ~2 MB
- `data/costs/*`: ~1 MB (precomputed impacts)
- `validate.py`: Consistency checks (not used in production)

---

## Deployment Architecture (High-Level)

```
┌─────────────────────────────────────────────────────┐
│  Docker Container (or Lambda, or Vercel)            │
├─────────────────────────────────────────────────────┤
│  Node.js Runtime                                     │
│  ├─ Express Server (port 3000)                      │
│  ├─ SQLite In-Process (airline.db)                  │
│  └─ LangGraph Agent Loop                            │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
    ┌────────┐ ┌────────┐ ┌──────────┐
    │React UI│ │Upstream│ │OpenAI API│
    │(Vite)  │ │Logging │ │(GPT-4)   │
    └────────┘ └────────┘ └──────────┘
```

### Environment Variables

```bash
OPENAI_API_KEY=sk-...     # GPT-4 access
MODEL_NAME=gpt-4          # Default model
PORT=3000                 # API port
DEBUG=false               # Verbose logging
```

### Zero-Downtime Updates

1. **Database**: `airline.db` is rebuilt in < 1 second (safe to overwrite)
2. **Rules Engine**: Logic is stateless; no cached state to flush
3. **Agent**: Conversation context is ephemeral (no session store)

**Update procedure:**
```bash
git pull origin main
npm run ingest && npm run verify
# Kill old process, start new (< 2 second downtime)
```

---

## Summary: Why This Architecture?

| Design Choice | Benefit |
|---|---|
| **Separation of LLM + Deterministic** | Eliminates hallucination in math; every rule check is auditable |
| **Zod Schemas as Single Source** | No hand-written JSON; LLM contract === validation === API schema |
| **Structured Retrieval (SQLite)** | Deterministic exact data; no vector approximation errors |
| **Explicit Reasoning Trail** | Controller can verify every decision; builds trust |
| **Precomputed Impacts** | P-2291's cost impact is precomputed; response time stays < 5s |
| **Calendar-Day Windows** | Correctly handles RULE-DUTY-02 & RULE-FLT-03 on any date |
| **In-Process Database** | Sub-millisecond queries; no network latency |
| **Stateless Agent** | Scales horizontally; no session store needed |

---

**End of Architecture Deep Dive**

For questions about specific components, see:
- Rules logic: `src/rulesEngine.ts`
- Database queries: `src/queryEngine.ts`
- Agent flow: `src/agent.ts`
- Frontend integration: `ui/src/api.ts`
- Schema definitions: `src/schema.sql`
