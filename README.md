# Crew Ops Advisor — Synthetic Dataset

Master dataset for the dCortex hackathon problem statement. Deterministic
(seed 42), regenerable with `generate.py`, independently checked by `validate.py`.

**Carrier:** dCortex Air (fictional) · **Hub:** BLR · **Week:** 2026-09-14 → 2026-09-20
**Snapshot ("now"):** `2026-09-14T18:00:00Z` · **All times UTC** · **Currency: INR**

## Contents

| Path | What it is |
|---|---|
| `data/flights.json` | 147 legs, 8 stations, 6 aircraft (4× A320-162, 2× ATR72-72), rotations + block hours |
| `data/crew.json` | 150 crew — rank, base, ratings, seniority, reachability, status (`active`/`leave`/`training`) |
| `data/rosters.json` | 39 pairings with per-day flights, report/release, full crew complements; `flagged_exceptions` lists the one deliberately illegal assignment |
| `data/duty_clocks.json` | Per crew: 28 days of daily duty/flight hours (2026-08-18 → 09-14), 7d/28d summaries, `last_rest_ended` |
| `data/reserve_pool.json` | 16 reserves with on-call windows. A reserve is usable when the **required report time** falls inside their window |
| `data/certifications.json` | 4 cert types per crew with validity dates |
| `data/rules.json` | The 7 rules, machine-readable params + prose. **Windows are calendar-day based** (see below) |
| `data/costs.json` | Callout / deadhead / delay / cancellation rates |
| `data/risk_signals.json` | Pre-computed disruption-risk scores (provided input — teams do NOT build prediction) |
| `data/scenarios.json` | 6 worked scenarios (S1–S6) with **computed** answer keys |
| `data/questions.json` | 38 questions (16 Tier-1, 14 Tier-2, 8 Tier-3) with expected answers |
| `internal/held_out_scenarios.json` | 2 held-out scenarios for judging. **Do not ship to participants** |
| `validate.py` | Independent consistency checker (no shared code with the generator) |
| `generate.py` | Regenerates everything. Internal — reveals answer-key derivations |

## Conventions teams must know (also stated in rules.json)

- **Duty period** = report → release. Report = first departure −60 min; release = last arrival +30 min.
- **RULE-FDP-01**: max FDP = 13h − 0.5h per sector beyond the 2nd.
- **RULE-DUTY-02 / RULE-FLT-03**: rolling windows are **calendar-day** windows (7 / 28 UTC dates, inclusive of the duty date). `daily_history` in duty_clocks.json exists precisely so these are computable on any day of the week.
- **RULE-REST-04**: ≥12h between release and next report.
- **Reserve windows**: the required report time (after any deadhead positioning) must fall inside the on-call window; once activated, the reserve operates as line crew.
- **Deadhead (RULE-BASE-07)**: positioning DEL→BLR uses DX402 (arr 08:45Z; odd dates) or DX589 (arr 07:45Z; even dates); new report = arrival +15 min; costs = callout + positioning + delay hours × `delay_cost_per_duty_hour`.

## Scenario independence

Each scenario is an **alternate timeline applied to the base snapshot**. They do
not chain: S2's sick call does not exist in S6's world. Answer keys are
computed by exhaustive candidate enumeration against the rules; equal-cost
plans (e.g. S6 mirror assignments) are equally correct.

## Engineered facts (these reproduce the problem-statement examples exactly)

- `C-1042` (A. Nair, Captain, BLR) operates 2-day pairing `P-2291`: day 1 `DX412/DX413/DX588`, day 2 `DX589/DX590/DX591`.
- Covering P-2291 with `C-2087` breaches RULE-DUTY-02 by **1h20m** (61.33h vs 60h).
- Reserve `C-3310` covers it cleanly at **₹18,500**.
- `C-2210` (DEL) is legal via deadhead at **₹41,200** (18,500 + 6,500 + 3h × 5,400), delaying DX412 ~3h.
- `C-3305` (early-window reserve) is a teaching case: legal for day 1 in isolation, breaches DUTY-02 on day 2.
- `C-2091` is ATR-only — the RULE-QUAL-05 exclusion case.
- The single flagged roster exception: one cabin crew's `recurrent_training` expires 2026-09-17 while rostered 2026-09-19 (scenario S5).

## ⚠ One fix needed in the problem-statement doc before release

The Tier-2 example question says "**FO** C-2087" — in the dataset (and in the
doc's own worked output, where C-2087 substitutes for a *captain*), **C-2087 is
a Captain**. Change "FO C-2087" → "Captain C-2087" in the doc.

## Verifying

```bash
python3 validate.py            # checks data/ (PASS/FAIL with details)
python3 generate.py            # regenerates everything (seed-stable)
```

---

# The dataset in SQLite

The Node app reads `airline.db`, built from `data/*.json` by `src/ingest.ts`.

```bash
npm run ingest    # build airline.db from data/*.json
npm run verify    # check it against the JSON it came from
npm run db        # both
npm run typecheck # tsc --noEmit
```

The JSON stays the source of truth: `generate.py` still emits it and
`validate.py` still checks it, both untouched. `airline.db` is derived,
git-ignored and rebuilt in under a second, so it is always safe to delete.

## Why this replaced the two-table ingest

The previous `src/ingest.ts` covered `crew` and `duty_clocks` only — 2 tables
of 23 — and, critically, **discarded `daily_history`**: the 4,200 rows that
this README's own conventions section calls out as existing "precisely so
these are computable on any day of the week".

Without those rows, `RULE-DUTY-02` had nothing to sum, so it fell back on
`duty_clocks.duty_hours_7d`. That column is a **snapshot artifact** — correct
only for the window ending on the dataset's `as_of` date, 2026-09-14. Every
scenario is dated 2026-09-15 or later.

Measured on this repo's own `data/`, for a 9.5h duty on 2026-09-15:

| | |
|---|---|
| Crew whose 7-day figure was wrong | **57 of 150** |
| Largest error | **+22.05h** |
| Verdicts that flipped | **1 — C-3305** |

C-3305 is the teaching case listed under *Engineered facts* above. The old
code computed **65.90h → BREACH**; the truth is **59.50h → LEGAL**, so it
wrongly excluded him from day 1 of the flagship scenario S2. C-2087 still
comes out at 61.33h → BREACH, exactly as the engineered facts require.

The old ingest also dropped `crew.status` entirely (the table had no such
column), so the 6 crew on leave and 2 in training were indistinguishable from
the 142 active ones, and stored `ratings` as a JSON string, so "every
A320-rated captain" was a parse-and-filter instead of a join.

## What is in the schema

23 tables with real foreign keys — `dataset/schema.sql` equivalent lives at
`src/schema.sql` and carries the column-level comments. Nested arrays become
child tables: `crew_ratings`, `pairing_days`, `pairing_day_flights`,
`pairing_crew`, `duty_daily_history`, `reserve_dates`, `rule_params`,
`risk_drivers`.

Three things are deliberately **not** in it:

- **No derived fields, and no views computing them.** Report/release for a
  *proposed* assignment, the window sums and the FDP limit stay in
  `rulesEngine.ts`, where the result carries `limit`, `actual`, `window` and
  `inputs` so a controller can challenge the number.
- **No normalised answer keys.** `scenarios` and `questions` keep their
  answer keys as JSON text — they are heterogeneous assertions, and columns
  would invent a structure the data has not got.
- **No rule limits in code.** `60` and `100` come from the `rule_params`
  table, so swapping a regulator's limits is a data change plus a re-ingest.

## Verifying

`npm run verify` runs five groups of checks — provenance hashes, row counts,
foreign keys and invariants, a full round trip (all eleven files are
reconstructed *from the database* and compared to the files on disk), and a
regression that recomputes RULE-DUTY-02 for all 150 crew straight from
`duty_clocks.json` and compares it to the engine.

Nothing in it hardcodes a row count or an hours figure — every expectation is
derived from `data/*.json` at run time, so it stays correct if the dataset is
regenerated. That matters here: more than one generator run of this dataset
exists, and they differ in `duty_clocks`, `certifications`, `risk_signals`
and one `questions` answer key.

```bash
python3 validate.py   # the JSON checker, unchanged by any of this
```
