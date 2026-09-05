# Crew Ops Advisor — Synthetic Dataset (updated)

Canonical dataset and tooling for the dCortex crew-ops problem. The JSON
under `data/` remains the source of truth; the repository also builds a
derivative SQLite database and exposes programmatic helpers for rule checks
and LLM-assisted operations.

Quick facts
- Carrier: dCortex Air (fictional)
- Hub: BLR
- Week: 2026-09-14 → 2026-09-20
- Snapshot (dataset as shipped): 2026-09-14T18:00:00Z
- Times are UTC; currency INR

What changed recently
- Ingest now builds a full schema (see `src/schema.sql`) and preserves
  `duty_daily_history` so windowed rules (7d / 28d) are computed correctly.
- The ingest stores any derived/tool-produced JSON under a `derived_json_files`
  table so analysis outputs are available inside the DB.
- Ingest creates an atomic, timestamped filesystem backup of `airline.db`
  in a `backups/` folder next to the DB (best-effort; rotation is optional).
- `reserve_availability` is precomputed during ingest: for each reserve date
  it sums the appropriate duty/flight windows and marks whether the reserve
  is usable (stored in the DB as materialised rows).
- New OpenAI-style function specs are declared in `src/llmTools.ts` to let
  an LLM call structured helpers (lookups, rule checks, scenario analysis,
  cover recommendations, callout generation). The runtime handlers for those
  tools are expected to live server-side and call into `QueryEngine` /
  `RulesEngine`.

Files of interest
- Data source: data/ (e.g. data/flights.json, data/crew.json, data/rosters.json)
- Ingest + schema: src/ingest.ts and src/schema.sql
- DB path / helpers: src/db.ts (`airline.db` is created at repo root)
- Query API: src/queryEngine.ts (tier-1 lookups)
- Rule engine: src/rulesEngine.ts (deterministic legality checks)
- LLM tool specs: src/llmTools.ts (OpenAI function definitions)
- Tools that generate derived artifacts: tools/ (Python/JS scripts write into data/normalized and data/costs)

How the DB is built (what `npm run ingest` does)
1. `src/ingest.ts` creates a temporary DB file and executes `src/schema.sql`.
2. Inside a single transaction it runs per-file loaders that read `data/*.json`
   and insert rows into the appropriate tables. Loaders include provenance,
   flights, crew, rosters, duty_clocks, certifications, reserves, rules,
   reserve availability, costs, normalized/derived artifacts, risk signals,
   impacts, and harness (scenarios/questions).
3. The ingest checks foreign keys, VACUUMs, closes the DB and atomically
   renames the temp file to `airline.db`.
4. A timestamped filesystem backup of the new `airline.db` is written to
   `backups/airline-<ISO-timestamp>.db` (best-effort).

Run locally (Node toolchain required — see notes below)

```powershell
npm install --legacy-peer-deps
npm run ingest    # build airline.db from data/*.json and write backups/
npm run verify    # check DB rows vs JSON
npm run typecheck # tsc --noEmit
```

Notes about native builds
- `better-sqlite3` is a native package. On Windows you either need a
  Visual Studio "Desktop C++" build toolset installed (MSVC) or use Node 18
  where prebuilt binaries are available. If `npm install` fails with a
  `node-gyp` / MSVC error, install the Build Tools or switch to Node 18.

Reserve precompute specifics
- Implemented in `loadReserveAvailability()` (src/ingest.ts). For each row in
  `reserve_dates` it reads rule parameters (RULE-DUTY-02, RULE-FLT-03),
  sums `duty_hours` and `flight_hours` from `duty_daily_history` over the
  corresponding calendar windows, and writes `(crew_id, date, usable,
  duty_hours_7d, flight_hours_28d, reason)` into `reserve_availability`.
- To refresh this table re-run `npm run ingest`.

Derived artifacts
- Tools under `tools/` (e.g. `split_and_extract_costs.py`, `generate_*_impacts.py`)
  write derived JSON into `data/normalized/` and `data/costs/`.
- `src/ingest.ts` now records those files into `derived_json_files` so the
  exact tool outputs are archived in the DB (filename, sha256, bytes, json_text).

LLM tooling
- `src/llmTools.ts` exports OpenAI-compatible function specs (Zod → JSON
  Schema) for lookups, rule checks and higher-level scenario helpers such as
  `assessSickCallImpact`, `recommendCoverOptions`, `generateCalloutNotification`,
  `planRecoveryForClosure`, etc. Implement handlers server-side to perform the
  actual computations and return structured results to the LLM.

Verification and testing
- `python3 validate.py` still independently checks the JSON files.
- `npm run verify` runs DB-vs-JSON roundtrips and additional invariants.

Development notes
- The code intentionally keeps regulatory limits and window sizes in
  `rules.json` / `rule_params` so changing a limit is a data change plus a
  re-ingest, not a code edit.
- The rules engine reads `duty_daily_history` for rolling-window checks;
  do not rely on `duty_clocks.duty_hours_7d` for rule decisions except when
  explicitly computing the snapshot answer.




