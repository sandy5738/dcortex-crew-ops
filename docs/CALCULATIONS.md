# CALCULATIONS.md — every number the engine computes

**This is the deterministic half of the system.** Everything here runs in
TypeScript against `airline.db`. The LLM never computes any of it — it only
chooses which function to call and, afterwards, narrates the result.

Every table and column below was read off the built database. Every constant
comes from `rule_params` or `costs`, never from a literal in the code.

Scope: 38 questions (16 Tier 1, 14 Tier 2, 8 Tier 3) and 6 scenarios.

---

## Part 1 — The six primitives

Everything else is built from these. Get them wrong and every downstream
number is wrong in a way that looks plausible.

### P1. Duty period (report / release / length)

**Rostered days are stored. Proposed or shifted days must be derived.**

| Source | Columns |
|---|---|
| `pairing_days` | `report_utc`, `release_utc` — valid only for the roster as planned |
| `pairing_day_flights` → `flights` | `dep_utc`, `arr_utc` — the source of truth for anything proposed |

```
report_utc  = MIN(flights.dep_utc) - 60 min
release_utc = MAX(flights.arr_utc) + 30 min
duty_hours  = (release_utc - report_utc) / 3_600_000 ms
```

```sql
SELECT MIN(f.dep_utc) AS first_dep, MAX(f.arr_utc) AS last_arr, COUNT(*) AS sectors
FROM pairing_day_flights pdf
JOIN flights f ON f.flight_id = pdf.flight_id
WHERE pdf.pairing_id = ? AND pdf.date = ?;
```

⚠ **Never read `pairing_days.report_utc` for a delayed or proposed duty.** It
is the planned value. S4 shifts every leg by 90 minutes; the stored column
does not move.

### P2. Sectors

`COUNT(*) FROM pairing_day_flights WHERE pairing_id = ? AND date = ?`

Drives the FDP reduction. Nothing else.

### P3. FDP limit

From `rule_params` where `rule_id = 'RULE-FDP-01'`:
`base_fdp_hours` 13 · `reduction_per_extra_sector_hours` 0.5 · `free_sectors` 2

```
fdp_limit = 13.0 - 0.5 × MAX(0, sectors - 2)
```

| Sectors | Limit |
|---|---|
| 2 | 13.0 |
| 3 | 12.5 |
| 4 | 12.0 |

### P4. Calendar window

**N UTC calendar dates ending on the duty date, inclusive.** Not a rolling
168 hours. `data/rules.json.time_convention` is explicit.

```
window(endDate, n) = [endDate - (n-1) … endDate]
```

Getting this wrong shifts every Tier 2 answer by exactly one day's hours.
Reject impossible dates (`2026-02-30`) rather than producing a null window.

### P5. Duty hours in a window

```sql
SELECT date, duty_hours FROM duty_daily_history
WHERE crew_id = ? AND date BETWEEN ? AND ?;
```

```
duty_7d(crew, date) = Σ duty_hours over the 7 dates
                    + Σ priorProposed[date]   -- earlier days of the SAME assignment
```

⚠ **Two traps.**

1. **Do not use `duty_clocks.duty_hours_7d`.** It is a snapshot valid only for
   the window ending `2026-09-14`. On 2026-09-15 it is wrong for **57 of 150
   crew** — measured, and asserted in `verify.ts`.
2. **`priorProposed` is mandatory for multi-day pairings.** Day 2's window
   includes day 1, and day 1's proposed duty is not in the database because it
   has not happened. Omitting it makes C-3305 look legal on both days of
   P-2291 when the dataset ships it as the opposite.

### P6. Flight hours in a window

Identical to P5 on `duty_daily_history.flight_hours`, over **28** dates.
`duty_clocks.flight_hours_28d` carries the same snapshot-only warning.

---

## Part 2 — The seven rules

Each returns a `RuleVerdict` carrying `limit`, `actual`, `margin`, `window`
and `inputs` — never a bare boolean. `inputs` is what makes the answer
challengeable by a controller.

Limits come from `rule_params` at evaluation time. **RULE-QUAL-05,
RULE-CERT-06 and RULE-BASE-07 have no rows there at all** — that is correct,
not a missing migration.

### RULE-FDP-01 — max flight duty period

| In | From |
|---|---|
| `duty_hours` | P1 |
| `sectors` | P2 |
| limit | P3 |

`legal = duty_hours ≤ fdp_limit`

### RULE-DUTY-02 — 60 duty hours / 7 calendar days

| In | From |
|---|---|
| prior | P5 over `window(dutyDate, 7)` |
| proposed | the new duty's length (P1) |
| limit | `rule_params.max_duty_hours` = 60 |

```
actual = prior + proposed
legal  = actual ≤ 60
margin = 60 - actual          -- negative means breach
```

**Worked (C-2087, P-2291 day 1):** `51.83 + 9.50 = 61.33` vs 60 → breach by
1.33h (1h20m).

**Worked (C-3305, P-2291 day 2):** day 1 alone is `50.00 + 9.50 = 59.50`,
legal by 0.5h. Day 2 with `priorProposed = {2026-09-15: 9.5}` is
`57.50 + 10.75 = 68.25` → breach by 8.25h.

### RULE-FLT-03 — 100 block hours / 28 calendar days

Same shape on P6. `proposed` is `SUM(flights.block_hours)` for the duty, not
the duty length.

### RULE-REST-04 — minimum 12h rest

**Three checks, not one.** The answer keys treat all three as legality.

| Check | Formula |
|---|---|
| Rest **before** the cover | `cover_report - previous_release ≥ 12h` |
| Rest **after** the cover (downstream) | `next_own_report - cover_release ≥ 12h` |
| **Double-booking** | the cover overlaps a `pairing_days` row the crew already holds |

Previous release: `duty_clocks.last_rest_ended`, or the release of their
preceding `pairing_days` row. Next own duty:

```sql
SELECT MIN(pd.report_utc) FROM pairing_crew pc
JOIN pairing_days pd ON pd.pairing_id = pc.pairing_id
WHERE pc.crew_id = ? AND pd.date > ?;
```

A negative "rest" is how the keys express an overlap
(*"only -7.25h rest before COVER"*).

### RULE-QUAL-05 — aircraft type rating

```sql
SELECT 1 FROM crew_ratings WHERE crew_id = ? AND rating = ?;
```

Type comes from `flights.aircraft_type` (via the pairing's legs), **not** from
`pairings.aircraft`, which is a tail number.

⚠ Do **not** pre-filter the candidate pool by rating. The answer keys list 8
ATR captains as exclusions with `RULE-QUAL-05: no A320 rating`. Filtering
early loses parity and hides the reject table.

### RULE-CERT-06 — certifications valid on the duty date

```sql
SELECT cert_type, valid_to FROM certifications WHERE crew_id = ?;
```

```
legal = ALL 4 cert types have  dutyDate ≤ valid_to
```

⚠ **Check `valid_to` only. Ignore `valid_from`.** It was generated as
`valid_to − 730 days` and never corrected: every `licence` row sits in the
future, and some ranges are inverted (C-2087: from `2027-11-06`, to
`2026-09-18`). A two-sided check grounds all 150 crew. The generator, the
validator and every answer key check expiry only.

Cross-check `flagged_exceptions` — C-5417, 2026-09-19, recurrent training
expired 2026-09-17. Detect it; do not crash on it.

### RULE-BASE-07 — base and positioning

```
crew.base == first leg dep_station  →  legal, no cost
otherwise                            →  legal only via deadhead, cost applies
```

Deadhead DEL→BLR: `DX402` (arr 08:45Z, odd dates) or `DX589` (arr 07:45Z,
even dates). **New report = arrival + 15 min.**

**Reserve on-call window** (`reserves`, `reserve_dates`) is evaluated here:

```
date ∈ reserve_dates(crew)  AND  oncall_start ≤ required_report ≤ oncall_end
```

⚠ The window is tested against the **required report time after any
positioning**, not the callout time. `reserves.note` says otherwise; the
generator and the answer keys use the report time. Follow the implementation.

---

## Part 3 — Costing

`costs` is key/value: `SELECT key, value_int FROM costs`.

| Key | ₹ | Applies when |
|---|---|---|
| `reserve_callout_pilot` | 18,500 | in `reserve_dates` for that date, rank is Captain/First Officer |
| `reserve_callout_cabin` | 9,500 | same, cabin rank |
| `dayoff_callout_pilot` | 24,000 | not reserve, not rostered that date |
| `dayoff_callout_cabin` | 12,500 | same, cabin rank |
| `deadhead_positioning` | 6,500 | `crew.base != dep_station` |
| `delay_cost_per_duty_hour` | 5,400 | per hour the **first departure** slips |
| `cancellation_per_flight` | 250,000 | per uncovered leg |
| `hotel_overnight` | 4,200 | stranded off base |

```
total = callout + deadhead + delay_hours × 5400 + hotel
```

**Worked (C-2210 deadhead):** `18,500 + 6,500 + 3 × 5,400 = 41,200`.

⚠ `dayoff_callout_*` never appears in the problem PDF but the answer keys use
it. Many candidates tie at ₹24,000 — ties are real and need a stated tiebreak.

---

## Part 4 — Impact

```sql
SELECT pd.date, f.flight_id, f.seats
FROM pairing_days pd
JOIN pairing_day_flights pdf ON pdf.pairing_id = pd.pairing_id AND pdf.date = pd.date
JOIN flights f ON f.flight_id = pdf.flight_id
WHERE pd.pairing_id = ? ORDER BY pd.date, pdf.seq;
```

| Output | Formula |
|---|---|
| `uncovered_day1` | legs on the disruption date |
| `at_risk_later` | legs on subsequent pairing-days |
| `passengers_day1` | `Σ flights.seats` for day 1 |
| `cancellation_exposure` | `legs × 250,000` |

⚠ **Uncrewed ≠ at risk.** Day 1 has no crew now; later days break only if
nothing changes. P-2291 day 2 is *at risk*, not uncrewed, because the aircraft
overnights at DEL. The keys score these separately.

**Worked (P-2291):** day 1 = 3 legs × 162 seats = **486 passengers**.

---

## Part 5 — Ranking (Tier 3)

Enumerate **every crew member of the required rank** — all 28 Captains, not a
pre-filtered subset — run all 7 rules on each, then order the legal ones by a
documented lexicographic key:

```
1. coverage_fraction   desc   cover all legs first
2. cost_inr            asc    then cheapest
3. depletion_weighted  asc    then preserve tomorrow's optionality
4. rest_margin_hours   desc   then most buffer
5. crew_id             asc    deterministic final tiebreak
```

Print that key verbatim in the UI. Cost ties are common, so without an
explicit tiebreak the ordering is arbitrary.

Ship `excluded_candidates` with per-rule reasons — it is free, because we
enumerate anyway.

---

## Part 6 — Which computation each tier needs

**Tier 1 (16 questions) — retrieval, almost no arithmetic.**

| Q | Needs |
|---|---|
| Q01, Q06 | `reserves` + `reserve_dates` + `crew` |
| Q02, Q13 | **P5 / P6** + headroom = `limit - actual` |
| Q03, Q09, Q10, Q14 | `flights` filters |
| Q04 | `certifications.valid_to` BETWEEN |
| Q05, Q12 | `flights` — `seats`, `MAX(block_hours)` |
| Q07, Q11 | `crew` + `crew_ratings` |
| Q08, Q15 | `pairing_crew` + `pairings` |
| Q16 | `risk_signals` + `risk_drivers` — **given, never computed** |

Only Q02 and Q13 do real arithmetic, and both are P5/P6 plus a subtraction.

**Tier 2 (14 questions) — one rule or one impact each.**

| Q | Needs |
|---|---|
| Q17 | Impact (Part 4) |
| Q18, Q22, Q26, Q28 | DUTY-02 / CERT-06 + P5 |
| Q19, Q29 | Station closure: flights in window, then FDP-01 on shifted duties |
| Q20 | P1 re-derived with +90 min, then FDP-01 |
| Q21 | BASE-07 deadhead + reserve window + delay cost |
| Q23 | REST-04: `release + 12h` |
| Q24 | DUTY-02 with **`priorProposed`** — the multi-day case |
| Q25, Q30 | `seats` × `cancellation_per_flight` |
| Q27 | Reserve window vs required report + QUAL-05 |

**Tier 3 (8 questions) — full enumerate → rules → cost → rank.**

Q31, Q32, Q34, Q35, Q37 all run Part 5. Q33 is FDP-01 plus delay costing.
Q36 and Q38 are narration over an already-computed verdict — **no new
arithmetic**, and worth noticing: they are LLM-only outputs.

**The 6 scenarios**

| S | Event | Computation |
|---|---|---|
| S1 | `SICK_CREW` C-3231 / P-2224 (ATR, 4 legs) | Impact + rank |
| S2 | `SICK_CREW` C-1042 / P-2291 (2-day) | Impact + rank + `priorProposed` |
| S3 | `STATION_CLOSURE` BLR 08:00–14:00Z | Affected legs + per-flight min delay + FDP-01 |
| S4 | `DELAY` VT-DXA +1.5h | Re-derive P1, FDP-01, delay cost |
| S5 | `CERT_EXPIRY` C-5417 | CERT-06 + replacement ranking |
| S6 | `MULTI_SICK` × 2 simultaneous | Two forked states, **joint** plan |

⚠ Scenarios are independent alternate timelines. S2's sick call does not exist
in S6's world. Do not accumulate state across them.

---

## Part 7 — The eight ways to get this wrong

1. Reading `duty_hours_7d` instead of summing `duty_daily_history` — wrong for
   57/150 crew.
2. Rolling 168 hours instead of 7 calendar dates — every answer off by a day.
3. Omitting `priorProposed` on multi-day pairings — C-3305 reads legal twice.
4. Checking `certifications.valid_from` — grounds all 150 crew.
5. Reading `pairing_days.report_utc` for a delayed duty — S4 silently wrong.
6. Pre-filtering candidates by rating — loses the 8 QUAL-05 exclusions.
7. Testing the reserve window against callout time, not post-positioning
   report time.
8. `rule["params"]` on QUAL-05 / CERT-06 / BASE-07 — those rows do not exist.
