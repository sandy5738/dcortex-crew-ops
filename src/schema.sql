-- src/schema.sql - the relational form of the crew-ops dataset.
--
-- Built from data/*.json by src/ingest.ts (`npm run ingest`) into airline.db.
-- The JSON files stay the source of truth; the database is a rebuildable
-- artifact and is git-ignored.
--
-- Replaces the original two-table ingest (crew + duty_clocks), which stored
-- ratings as a JSON string and dropped `daily_history` entirely. That last
-- omission mattered: daily_history is the ONLY correct source for the 7- and
-- 28-day windows on any date other than the snapshot date, and without it
-- RULE-DUTY-02 had to fall back on duty_hours_7d, which is a snapshot
-- artifact. See README, "The dataset in SQLite".
--
-- Two conventions run through every table:
--
--   seq   the row's index in its source JSON array, so the export in
--         src/verify.ts can reconstruct each file and prove the ingest is
--         lossless. Several source files are in no natural sort order.
--
--   TEXT  every date and timestamp. ISO-8601, UTC, exactly as shipped
--         ("2026-09-14", "2026-09-14T02:30:00Z"). SQLite has no date type;
--         ISO text sorts and compares correctly and survives the round trip.
--
-- Derived fields are deliberately absent - no report/release for proposed
-- assignments, no window sums, no FDP limits, and no views computing them.
-- That arithmetic belongs in rulesEngine.ts, where the result carries the
-- numbers that went into it.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------- provenance

CREATE TABLE dataset_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
) WITHOUT ROWID;

-- Which bytes this database was built from. Lets a test detect a database
-- that has drifted from data/ without re-running the whole comparison.
CREATE TABLE source_files (
    filename     TEXT PRIMARY KEY,
    sha256       TEXT    NOT NULL,
    bytes        INTEGER NOT NULL,
    in_snapshot  INTEGER NOT NULL CHECK (in_snapshot IN (0, 1)),
    seq          INTEGER NOT NULL
) WITHOUT ROWID;

-- ---------------------------------------------------------------- flights

CREATE TABLE flights (
    flight_id      TEXT PRIMARY KEY,   -- flight_no + date
    flight_no      TEXT NOT NULL,
    date           TEXT NOT NULL,
    dep_station    TEXT NOT NULL,
    arr_station    TEXT NOT NULL,
    dep_utc        TEXT NOT NULL,
    arr_utc        TEXT NOT NULL,
    block_hours    REAL NOT NULL,      -- RULE-FLT-03, not DUTY-02
    aircraft       TEXT NOT NULL,
    aircraft_type  TEXT NOT NULL,      -- drives RULE-QUAL-05
    seats          INTEGER NOT NULL,   -- drives passengers_at_risk
    seq            INTEGER NOT NULL
);

CREATE INDEX ix_flights_date_dep   ON flights(date, dep_station, dep_utc);
CREATE INDEX ix_flights_aircraft   ON flights(aircraft, dep_utc);
CREATE INDEX ix_flights_date_type  ON flights(date, aircraft_type);

-- ------------------------------------------------------------------- crew

CREATE TABLE crew (
    crew_id               TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    rank                  TEXT NOT NULL
        CHECK (rank IN ('Captain', 'First Officer',
                        'Senior Cabin Crew', 'Cabin Crew')),
    base                  TEXT NOT NULL,   -- drives RULE-BASE-07
    seniority             INTEGER NOT NULL,
    reachability_minutes  INTEGER NOT NULL,
    status                TEXT NOT NULL
        CHECK (status IN ('active', 'leave', 'training')),
    seq                   INTEGER NOT NULL
);

CREATE INDEX ix_crew_rank ON crew(rank, status);
CREATE INDEX ix_crew_base ON crew(base);

-- crew.ratings[] — the many side of RULE-QUAL-05.
CREATE TABLE crew_ratings (
    crew_id  TEXT NOT NULL REFERENCES crew(crew_id),
    rating   TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    PRIMARY KEY (crew_id, rating)
) WITHOUT ROWID;

CREATE INDEX ix_crew_ratings_rating ON crew_ratings(rating, crew_id);

-- ---------------------------------------------------------------- rosters

CREATE TABLE pairings (
    pairing_id  TEXT PRIMARY KEY,
    aircraft    TEXT NOT NULL,      -- aircraft_type comes via flights
    seq         INTEGER NOT NULL
);

-- The pairing-day is the unit of work, not the pairing: 39 -> 42.
-- report_utc / release_utc are stored here for ROSTERED days only; a
-- proposed assignment must still derive them (docs/DATA_MODEL.md §3).
CREATE TABLE pairing_days (
    pairing_id   TEXT NOT NULL REFERENCES pairings(pairing_id),
    date         TEXT NOT NULL,
    report_utc   TEXT NOT NULL,
    release_utc  TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    PRIMARY KEY (pairing_id, date)
) WITHOUT ROWID;

CREATE INDEX ix_pairing_days_date ON pairing_days(date);

-- pairing_days[].flights[] — ordered, so seq is the leg number.
CREATE TABLE pairing_day_flights (
    pairing_id  TEXT NOT NULL,
    date        TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    flight_id   TEXT NOT NULL REFERENCES flights(flight_id),
    PRIMARY KEY (pairing_id, date, seq),
    FOREIGN KEY (pairing_id, date)
        REFERENCES pairing_days(pairing_id, date)
) WITHOUT ROWID;

CREATE INDEX ix_pairing_day_flights_flight ON pairing_day_flights(flight_id);

-- 6 crew on an A320 pairing, 4 on an ATR. 206 rows, not 39 x 6.
CREATE TABLE pairing_crew (
    pairing_id  TEXT NOT NULL REFERENCES pairings(pairing_id),
    crew_id     TEXT NOT NULL REFERENCES crew(crew_id),
    role        TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (pairing_id, crew_id)
) WITHOUT ROWID;

-- "what is this person rostered on" — docs/DATA_MODEL.md §4 index 8.
CREATE INDEX ix_pairing_crew_crew ON pairing_crew(crew_id);

-- The deliberately illegal assignments. Exactly one row (C-5417, scenario
-- S5). Detect and surface it; do not crash on it.
CREATE TABLE flagged_exceptions (
    seq      INTEGER PRIMARY KEY,
    crew_id  TEXT NOT NULL REFERENCES crew(crew_id),
    date     TEXT NOT NULL,
    rule     TEXT NOT NULL,
    note     TEXT NOT NULL
);

-- ------------------------------------------------------------ duty clocks

CREATE TABLE duty_clocks (
    crew_id           TEXT PRIMARY KEY REFERENCES crew(crew_id),
    as_of_utc         TEXT NOT NULL,
    -- SNAPSHOT ONLY: valid for the window ending 2026-09-14 and nothing
    -- else. Recompute from duty_daily_history for any other date.
    duty_hours_7d     REAL NOT NULL,
    flight_hours_28d  REAL NOT NULL,
    last_rest_ended   TEXT NOT NULL,   -- drives RULE-REST-04
    seq               INTEGER NOT NULL
);

-- 4,200 rows — the largest grain in the dataset, and the ONLY correct
-- source for RULE-DUTY-02 and RULE-FLT-03 on any date other than
-- 2026-09-14. Windows are calendar-day, inclusive of the duty date.
CREATE TABLE duty_daily_history (
    crew_id       TEXT NOT NULL REFERENCES duty_clocks(crew_id),
    date          TEXT NOT NULL,      -- 2026-08-18 .. 2026-09-14, 28 per crew
    duty_hours    REAL NOT NULL,
    flight_hours  REAL NOT NULL,
    seq           INTEGER NOT NULL,
    PRIMARY KEY (crew_id, date)
) WITHOUT ROWID;

CREATE INDEX ix_duty_daily_history_date ON duty_daily_history(date);

-- --------------------------------------------------------- certifications

-- 600 rows = 4 types x 150 crew. All four must be valid on the duty date.
-- valid_from is UNUSABLE — generated as valid_to - 730d and never
-- corrected, so some ranges are inverted. It is kept for fidelity with the
-- source file; RULE-CERT-06 checks valid_to only (docs/DATA_MODEL.md §6.1).
CREATE TABLE certifications (
    crew_id     TEXT NOT NULL REFERENCES crew(crew_id),
    cert_type   TEXT NOT NULL
        CHECK (cert_type IN ('licence', 'medical_class1',
                             'recurrent_training', 'dangerous_goods')),
    valid_from  TEXT NOT NULL,
    valid_to    TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (crew_id, cert_type)
) WITHOUT ROWID;

CREATE INDEX ix_certifications_valid_to ON certifications(valid_to);

-- ---------------------------------------------------------- reserve pool

-- A reserve is usable when the REQUIRED REPORT TIME (after any deadhead
-- positioning) falls inside the window. `note` says "callout time" and
-- contradicts the implementation and the answer keys — kept verbatim,
-- believed only as prose. docs/DATA_MODEL.md §6.3.
CREATE TABLE reserves (
    crew_id       TEXT PRIMARY KEY REFERENCES crew(crew_id),
    base          TEXT NOT NULL,
    oncall_start  TEXT NOT NULL,      -- "00:00", UTC clock time
    oncall_end    TEXT NOT NULL,      -- "05:30"
    note          TEXT NOT NULL,
    seq           INTEGER NOT NULL
);

CREATE TABLE reserve_dates (
    crew_id  TEXT NOT NULL REFERENCES reserves(crew_id),
    date     TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    PRIMARY KEY (crew_id, date)
) WITHOUT ROWID;

CREATE INDEX ix_reserve_dates_date ON reserve_dates(date, crew_id);

-- ------------------------------------------------------------------ rules

CREATE TABLE rules (
    rule_id  TEXT PRIMARY KEY,
    text     TEXT NOT NULL,
    seq      INTEGER NOT NULL
);

-- 10 rows across 7 rules: QUAL-05, CERT-06 and BASE-07 have no params at
-- all. The absence is meaningful — see docs/DATA_MODEL.md §2 RULE.
--
-- is_int preserves 60 vs 60.0 across the round trip. A bare REAL column
-- would compare equal and still change the shipped file.
CREATE TABLE rule_params (
    rule_id    TEXT NOT NULL REFERENCES rules(rule_id),
    param_key  TEXT NOT NULL,
    value_num  REAL NOT NULL,
    is_int     INTEGER NOT NULL CHECK (is_int IN (0, 1)),
    seq        INTEGER NOT NULL,
    PRIMARY KEY (rule_id, param_key)
) WITHOUT ROWID;

-- rules.json.definitions — the authority on window and duty semantics.
CREATE TABLE rule_definitions (
    term  TEXT PRIMARY KEY,
    text  TEXT NOT NULL,
    seq   INTEGER NOT NULL
) WITHOUT ROWID;

-- ------------------------------------------------------------------ costs

-- Flat rate table. Read at pricing time, never held as constants in core/.
-- Exactly one of value_int / value_text is non-null per row: the file mixes
-- integer rates with `currency` and `notes` strings.
CREATE TABLE costs (
    key         TEXT PRIMARY KEY,
    value_int   INTEGER,
    value_text  TEXT,
    seq         INTEGER NOT NULL,
    CHECK ((value_int IS NULL) <> (value_text IS NULL))
) WITHOUT ROWID;

-- Derived cost tables produced by tools/split_and_extract_costs.py and
-- tools/generate_*_impacts.py. These are not the canonical source of
-- truth, but they make common cost analytics much faster to write in SQL.
CREATE TABLE IF NOT EXISTS costs_per_flight (
    flight_id TEXT PRIMARY KEY,
    cancellation_cost INTEGER,
    estimated_deadhead_cost INTEGER,
    estimated_delay_cost_per_hour INTEGER
);

CREATE TABLE IF NOT EXISTS costs_per_pairing (
    pairing_id TEXT PRIMARY KEY,
    total_block_hours REAL,
    estimated_hotel_nights INTEGER,
    hotel_cost_total INTEGER,
    cancellation_costs_total INTEGER
);

-- Normalized/denormalized artifacts produced by the normalization step.
-- These shadow the canonical tables but are intentionally named so they
-- don't collide with snapshot tables; they are useful for ad-hoc joins
-- and for importing intermediate outputs produced by tools/ without
-- disturbing the canonical ingest pipeline.
CREATE TABLE IF NOT EXISTS normalized_flights_basic (
    flight_id      TEXT PRIMARY KEY,
    flight_no      TEXT NOT NULL,
    date           TEXT NOT NULL,
    dep_station    TEXT NOT NULL,
    arr_station    TEXT NOT NULL,
    dep_utc        TEXT NOT NULL,
    arr_utc        TEXT NOT NULL,
    block_hours    REAL NOT NULL,
    aircraft       TEXT NOT NULL,
    aircraft_type  TEXT NOT NULL,
    seats          INTEGER NOT NULL,
    seq            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS normalized_pairings (
    pairing_id TEXT PRIMARY KEY,
    aircraft   TEXT NOT NULL,
    seq        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS normalized_pairing_crew (
    pairing_id TEXT NOT NULL,
    crew_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (pairing_id, crew_id)
);

CREATE TABLE IF NOT EXISTS normalized_pairing_legs (
    pairing_id TEXT NOT NULL,
    flight_id  TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (pairing_id, seq)
);

CREATE TABLE IF NOT EXISTS normalized_crew_base (
    crew_id  TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    rank     TEXT NOT NULL,
    base     TEXT NOT NULL,
    seniority INTEGER NOT NULL,
    reachability_minutes INTEGER NOT NULL,
    status   TEXT NOT NULL,
    seq      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS normalized_duty_clock_summary (
    crew_id TEXT PRIMARY KEY,
    as_of_utc TEXT NOT NULL,
    duty_hours_7d REAL NOT NULL,
    flight_hours_28d REAL NOT NULL,
    last_rest_ended TEXT NOT NULL,
    seq INTEGER NOT NULL
);

-- Precomputed reserve availability: whether a reserve on a given date is
-- actually usable considering duty and flight-hour windows. This lets
-- queries filter reserves cheaply without recomputing window sums.
CREATE TABLE IF NOT EXISTS reserve_availability (
    crew_id TEXT NOT NULL REFERENCES reserves(crew_id),
    date    TEXT NOT NULL,
    usable  INTEGER NOT NULL CHECK (usable IN (0,1)),
    duty_hours_7d REAL,
    flight_hours_28d REAL,
    reason  TEXT,
    PRIMARY KEY (crew_id, date)
) WITHOUT ROWID;

-- ---------------------------------------------------------------- impacts (consolidated detailed)
-- ---------------------------------------------------------------- impacts (consolidated detailed)

-- Detailed, per-crew, per-pairing, per-leg cost scenarios derived by
-- the analysis tools under `tools/`. These tables store the derived
-- cost scenarios (baseline pairing costs are kept as a small JSON blob)
-- and one row per (crew, pairing, leg) for efficient querying and joins
-- with the canonical snapshot tables (flights, crew, pairings).
--
-- Notes:
--  - `baseline_json` contains the pairing-level cost summary as JSON text
--    (hotel totals, cancellation totals, etc.) to avoid shredding a small
--    heterogeneous object into many columns.
--  - `impacts_leg` stores the per-leg numeric estimates used by the
--    recommendation heuristics so SQL queries can reproduce or inspect
--    the same decision logic without re-running Python tools.
CREATE TABLE impacts_pairing (
    crew_id    TEXT NOT NULL REFERENCES crew(crew_id),
    pairing_id TEXT NOT NULL,
    role       TEXT,
    baseline_json TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (crew_id, pairing_id)
) WITHOUT ROWID;

CREATE TABLE impacts_leg (
    crew_id    TEXT NOT NULL REFERENCES crew(crew_id),
    pairing_id TEXT NOT NULL,
    leg_seq    INTEGER NOT NULL,
    flight_id  TEXT NOT NULL,
    remaining_legs INTEGER NOT NULL,
    cancel_cost INTEGER,
    reserve_total INTEGER,
    deadhead_only INTEGER,
    recommended_action TEXT,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (crew_id, pairing_id, leg_seq)
) WITHOUT ROWID;

-- ------------------------------------------------------------ risk signals

-- A GIVEN INPUT, like a weather forecast. We do not build a prediction
-- model — SPEC.md §2, "explicitly NOT in scope".
CREATE TABLE risk_signals (
    crew_id                TEXT PRIMARY KEY REFERENCES crew(crew_id),
    as_of_utc              TEXT NOT NULL,
    disruption_risk_score  REAL NOT NULL,
    seq                    INTEGER NOT NULL
);

CREATE TABLE risk_drivers (
    crew_id  TEXT NOT NULL REFERENCES risk_signals(crew_id),
    seq      INTEGER NOT NULL,
    driver   TEXT NOT NULL,
    PRIMARY KEY (crew_id, seq)
) WITHOUT ROWID;

-- ----------------------------------------------------- harness input only

-- scenarios.json and questions.json are harness input, NOT world state:
-- only the other nine files load into Snapshot (docs/DATA_MODEL.md §1).
-- Their answer keys are heterogeneous assertions, not entities — a str, an
-- int, a list or a dict depending on the question — so they are stored
-- whole as JSON text rather than shredded into columns that would invent a
-- structure the data does not have.

CREATE TABLE harness_scenarios (
    scenario_id      TEXT PRIMARY KEY,
    difficulty       TEXT NOT NULL,
    title            TEXT NOT NULL,
    event_json       TEXT NOT NULL,
    answer_key_json  TEXT NOT NULL,
    seq              INTEGER NOT NULL
);

CREATE TABLE harness_questions (
    question_id           TEXT PRIMARY KEY,
    tier                  INTEGER NOT NULL CHECK (tier IN (1, 2, 3)),
    prompt                TEXT NOT NULL,
    expected_answer_json  TEXT NOT NULL,
    explanation           TEXT NOT NULL,
    rules_ref_json        TEXT NOT NULL,
    seq                   INTEGER NOT NULL
);

CREATE INDEX ix_harness_questions_tier ON harness_questions(tier);

-- ------------------------------------------------------------------ derived

-- Store any derived JSON artifact produced by tools/ so the database
-- contains a copy of what the analysis pipeline produced. The canonical
-- source_files table continues to track the nine world files; this table
-- is a convenience for analysts who want the derived artifacts available
-- inside the DB without adding many separate columns or tables for each
-- tool output.
CREATE TABLE IF NOT EXISTS derived_json_files (
    filename   TEXT PRIMARY KEY,
    sha256     TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    json_text  TEXT NOT NULL,
    seq        INTEGER NOT NULL
) WITHOUT ROWID;
