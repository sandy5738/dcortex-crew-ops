/**
 * Build airline.db from data/*.json.   `npm run ingest`
 *
 * All eleven files, 23 tables, real foreign keys. Replaces the original
 * two-table ingest, which covered crew and duty_clocks only and — the part
 * that actually mattered — dropped `daily_history`, the 4,200 rows that are
 * the only correct source for the 7- and 28-day windows on any date other
 * than the snapshot date.
 *
 * The JSON stays the source of truth. This database is derived, git-ignored,
 * and rebuilt in under a second, so it is always safe to delete.
 *
 * Deterministic: same JSON in, same rows out. No timestamps, no random ids.
 * `npm run verify` checks the result against the JSON it came from.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR, DB_PATH, openForWrite } from './db';

/** The nine that describe the world, then the two that are harness input. */
export const WORLD_FILES = [
  'flights', 'crew', 'rosters', 'duty_clocks', 'reserve_pool',
  'certifications', 'rules', 'costs', 'risk_signals',
] as const;
export const HARNESS_FILES = ['scenarios', 'questions'] as const;
export const ALL_FILES = [...WORLD_FILES, ...HARNESS_FILES];

export const SCHEMA_VERSION = '1';

export function readJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf-8'));
}

function sha256(name: string): { hash: string; bytes: number } {
  const buf = fs.readFileSync(path.join(DATA_DIR, `${name}.json`));
  // require() rather than a top-level import so this file stays readable as
  // "the ingest" — crypto is an implementation detail of provenance.
  const hash = require('crypto').createHash('sha256').update(buf).digest('hex');
  return { hash, bytes: buf.length };
}

// ---------------------------------------------------------------- loaders

function loadProvenance(db: Database.Database) {
  const rules = readJson('rules');
  const rosters = readJson('rosters');
  const costs = readJson('costs');

  const meta = db.prepare('INSERT INTO dataset_meta (key, value) VALUES (?, ?)');
  // Derive provenance values rather than hard-coding them. Week bounds are
  // taken from the rostered pairing days; snapshot time defaults to
  // midnight UTC on the first rostered date if no explicit value exists.
  const allDates: string[] = [];
  rosters.pairings?.forEach((p: any) => p.days?.forEach((d: any) => allDates.push(d.date)));
  const week_start = allDates.length ? allDates.slice().sort()[0] : '';
  // week_end = week_start + 6 days
  let week_end = '';
  if (week_start) {
    const dt = new Date(week_start + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 6);
    week_end = dt.toISOString().slice(0, 10);
  }
  const snapshot_utc = costs.snapshot_utc || (week_start ? `${week_start}T00:00:00Z` : '');

  const rows: [string, string][] = [
    ['schema_version', SCHEMA_VERSION],
    ['source', 'data/*.json (the source of truth)'],
    ['carrier', 'dCortex Air'],
    ['hub', 'BLR'],
    ['week_start', week_start],
    ['week_end', week_end],
    ['snapshot_utc', snapshot_utc],
    ['currency', costs.currency],
    ['time_convention', rules.time_convention],
    ['rosters_note', rosters.note],
  ];
  for (const [k, v] of rows) meta.run(k, v);

  const src = db.prepare(
    'INSERT INTO source_files (filename, sha256, bytes, in_snapshot, seq) VALUES (?,?,?,?,?)'
  );
  ALL_FILES.forEach((name, i) => {
    const { hash, bytes } = sha256(name);
    src.run(`${name}.json`, hash, bytes, (WORLD_FILES as readonly string[]).includes(name) ? 1 : 0, i);
  });
}

function loadFlights(db: Database.Database) {
  const ins = db.prepare(`
    INSERT INTO flights (flight_id, flight_no, date, dep_station, arr_station,
                         dep_utc, arr_utc, block_hours, aircraft, aircraft_type,
                         seats, seq)
    VALUES (@flight_id, @flight_no, @date, @dep_station, @arr_station,
            @dep_utc, @arr_utc, @block_hours, @aircraft, @aircraft_type,
            @seats, @seq)`);
  readJson('flights').forEach((f: any, seq: number) => ins.run({ ...f, seq }));
}

function loadCrew(db: Database.Database) {
  const ins = db.prepare(`
    INSERT INTO crew (crew_id, name, rank, base, seniority,
                      reachability_minutes, status, seq)
    VALUES (@crew_id, @name, @rank, @base, @seniority,
            @reachability_minutes, @status, @seq)`);
  // ratings become a child table rather than a JSON string, so
  // "every A320-rated captain" is a join instead of a parse-and-filter.
  const rating = db.prepare(
    'INSERT INTO crew_ratings (crew_id, rating, seq) VALUES (?,?,?)');

  readJson('crew').forEach((c: any, seq: number) => {
    ins.run({
      crew_id: c.crew_id, name: c.name, rank: c.rank, base: c.base,
      seniority: c.seniority, reachability_minutes: c.reachability_minutes,
      status: c.status, seq,
    });
    (c.ratings || []).forEach((r: string, j: number) => rating.run(c.crew_id, r, j));
  });
}

function loadRosters(db: Database.Database) {
  const doc = readJson('rosters');

  const pairing = db.prepare(
    'INSERT INTO pairings (pairing_id, aircraft, seq) VALUES (?,?,?)');
  const day = db.prepare(`
    INSERT INTO pairing_days (pairing_id, date, report_utc, release_utc, seq)
    VALUES (?,?,?,?,?)`);
  const leg = db.prepare(`
    INSERT INTO pairing_day_flights (pairing_id, date, seq, flight_id)
    VALUES (?,?,?,?)`);
  const member = db.prepare(
    'INSERT INTO pairing_crew (pairing_id, crew_id, role, seq) VALUES (?,?,?,?)');

  doc.pairings.forEach((p: any, seq: number) => {
    pairing.run(p.pairing_id, p.aircraft, seq);
    p.days.forEach((d: any, j: number) => {
      day.run(p.pairing_id, d.date, d.report_utc, d.release_utc, j);
      d.flights.forEach((fid: string, k: number) => leg.run(p.pairing_id, d.date, k, fid));
    });
    // 6 crew on an A320 pairing, 4 on an ATR — 206 rows, not 39 x 6.
    p.crew.forEach((c: any, j: number) =>
      member.run(p.pairing_id, c.crew_id, c.role, j));
  });

  const flagged = db.prepare(`
    INSERT INTO flagged_exceptions (seq, crew_id, date, rule, note)
    VALUES (?,?,?,?,?)`);
  doc.flagged_exceptions.forEach((f: any, i: number) =>
    flagged.run(i, f.crew_id, f.date, f.rule, f.note));
}

function loadDutyClocks(db: Database.Database) {
  const ins = db.prepare(`
    INSERT INTO duty_clocks (crew_id, as_of_utc, duty_hours_7d,
                             flight_hours_28d, last_rest_ended, seq)
    VALUES (@crew_id, @as_of_utc, @duty_hours_7d,
            @flight_hours_28d, @last_rest_ended, @seq)`);
  // The row that the old ingest threw away. 28 per crew, 4,200 total.
  const hist = db.prepare(`
    INSERT INTO duty_daily_history (crew_id, date, duty_hours, flight_hours, seq)
    VALUES (?,?,?,?,?)`);

  readJson('duty_clocks').forEach((c: any, seq: number) => {
    ins.run({
      crew_id: c.crew_id, as_of_utc: c.as_of_utc,
      duty_hours_7d: c.duty_hours_7d, flight_hours_28d: c.flight_hours_28d,
      last_rest_ended: c.last_rest_ended, seq,
    });
    (c.daily_history || []).forEach((h: any, j: number) =>
      hist.run(c.crew_id, h.date, h.duty_hours, h.flight_hours, j));
  });
}

function loadCertifications(db: Database.Database) {
  const ins = db.prepare(`
    INSERT INTO certifications (crew_id, cert_type, valid_from, valid_to, seq)
    VALUES (?,?,?,?,?)`);
  readJson('certifications').forEach((c: any, seq: number) =>
    ins.run(c.crew_id, c.cert_type, c.valid_from, c.valid_to, seq));
}

function loadReserves(db: Database.Database) {
  const ins = db.prepare(`
    INSERT INTO reserves (crew_id, base, oncall_start, oncall_end, note, seq)
    VALUES (?,?,?,?,?,?)`);
  const date = db.prepare(
    'INSERT INTO reserve_dates (crew_id, date, seq) VALUES (?,?,?)');

  readJson('reserve_pool').forEach((r: any, seq: number) => {
    ins.run(r.crew_id, r.base, r.oncall_window_utc.start,
            r.oncall_window_utc.end, r.note, seq);
    (r.dates || []).forEach((d: string, j: number) => date.run(r.crew_id, d, j));
  });
}

function loadRules(db: Database.Database) {
  const doc = readJson('rules');
  const rule = db.prepare('INSERT INTO rules (rule_id, text, seq) VALUES (?,?,?)');
  const param = db.prepare(`
    INSERT INTO rule_params (rule_id, param_key, value_num, is_int, seq)
    VALUES (?,?,?,?,?)`);
  const def = db.prepare(
    'INSERT INTO rule_definitions (term, text, seq) VALUES (?,?,?)');

  doc.rules.forEach((r: any, seq: number) => {
    rule.run(r.rule_id, r.text, seq);
    // QUAL-05, CERT-06 and BASE-07 have no `params` key at all. The absence
    // is meaningful; do not invent an empty object's worth of rows.
    Object.entries(r.params ?? {}).forEach(([k, v], j) =>
      param.run(r.rule_id, k, Number(v), Number.isInteger(v) ? 1 : 0, j));
  });
  Object.entries(doc.definitions).forEach(([term, text], i) =>
    def.run(term, text as string, i));
}

function loadReserveAvailability(db: Database.Database) {
  // Precompute whether a reserve entry is usable on each of its dates
  // by summing the duty and flight windows and comparing against rule limits.
  type RuleParamRow = { value_num: number | null };
  const dutyParam = db.prepare(
    "SELECT value_num FROM rule_params WHERE rule_id='RULE-DUTY-02' AND param_key='max_duty_hours'"
  ).get() as RuleParamRow | undefined;
  const dutyWindow = db.prepare(
    "SELECT value_num FROM rule_params WHERE rule_id='RULE-DUTY-02' AND param_key='window_days'"
  ).get() as RuleParamRow | undefined;
  const flightParam = db.prepare(
    "SELECT value_num FROM rule_params WHERE rule_id='RULE-FLT-03' AND param_key='max_flight_hours'"
  ).get() as RuleParamRow | undefined;
  const flightWindow = db.prepare(
    "SELECT value_num FROM rule_params WHERE rule_id='RULE-FLT-03' AND param_key='window_days'"
  ).get() as RuleParamRow | undefined;

  const maxDuty = dutyParam ? Number(dutyParam.value_num) : 60;
  const dutyDays = dutyWindow ? Number(dutyWindow.value_num) : 7;
  const maxFlight = flightParam ? Number(flightParam.value_num) : 100;
  const flightDays = flightWindow ? Number(flightWindow.value_num) : 28;

  const reserveDates = db.prepare('SELECT crew_id, date FROM reserve_dates').all() as {crew_id:string, date:string}[];
  const ins = db.prepare('INSERT OR REPLACE INTO reserve_availability (crew_id, date, usable, duty_hours_7d, flight_hours_28d, reason) VALUES (?,?,?,?,?,?)');

  for (const r of reserveDates) {
    const crew = r.crew_id;
    const date = r.date;
    // compute window starts
    const dStart = new Date(date + 'T00:00:00Z');
    dStart.setUTCDate(dStart.getUTCDate() - (dutyDays - 1));
    const dutyStart = dStart.toISOString().slice(0,10);
    const fStartDate = new Date(date + 'T00:00:00Z');
    fStartDate.setUTCDate(fStartDate.getUTCDate() - (flightDays - 1));
    const flightStart = fStartDate.toISOString().slice(0,10);

    const dutyRow = db.prepare('SELECT SUM(duty_hours) AS s FROM duty_daily_history WHERE crew_id = ? AND date BETWEEN ? AND ?').get(crew, dutyStart, date) as any;
    const flightRow = db.prepare('SELECT SUM(flight_hours) AS s FROM duty_daily_history WHERE crew_id = ? AND date BETWEEN ? AND ?').get(crew, flightStart, date) as any;
    const dutySum = Math.max(0, Number(dutyRow?.s || 0));
    const flightSum = Math.max(0, Number(flightRow?.s || 0));

    let usable = 1;
    let reason: string | null = null;
    if (dutySum >= maxDuty) {
      usable = 0;
      reason = 'duty_hours_exceeded';
    }
    if (flightSum >= maxFlight) {
      usable = 0;
      reason = reason ? reason + ';flight_hours_exceeded' : 'flight_hours_exceeded';
    }

    ins.run(crew, date, usable, dutySum, flightSum, reason);
  }
}

function loadCosts(db: Database.Database) {
  const ins = db.prepare(
    'INSERT INTO costs (key, value_int, value_text, seq) VALUES (?,?,?,?)');
  Object.entries(readJson('costs')).forEach(([k, v], i) =>
    ins.run(k, typeof v === 'number' ? v : null,
            typeof v === 'string' ? v : null, i));
}

function loadCostsPerFlight(db: Database.Database) {
  const p = path.join(DATA_DIR, 'costs', 'costs_per_flight.json');
  if (!fs.existsSync(p)) return;
  const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
  const ins = db.prepare(
    `INSERT OR REPLACE INTO costs_per_flight (flight_id, cancellation_cost, estimated_deadhead_cost, estimated_delay_cost_per_hour)
     VALUES (?,?,?,?)`);
  doc.forEach((r: any) => ins.run(r.flight_id, r.cancellation_cost ?? null, r.estimated_deadhead_cost ?? null, r.estimated_delay_cost_per_hour ?? null));
}

function loadCostsPerPairing(db: Database.Database) {
  const p = path.join(DATA_DIR, 'costs', 'costs_per_pairing.json');
  if (!fs.existsSync(p)) return;
  const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
  const ins = db.prepare(
    `INSERT OR REPLACE INTO costs_per_pairing (pairing_id, total_block_hours, estimated_hotel_nights, hotel_cost_total, cancellation_costs_total)
     VALUES (?,?,?,?,?)`);
  doc.forEach((r: any) => ins.run(r.pairing_id, r.total_block_hours ?? null, r.estimated_hotel_nights ?? null, r.hotel_cost_total ?? null, r.cancellation_costs_total ?? null));
}

function loadNormalizedArtifacts(db: Database.Database) {
  // normalized/flights_basic.json
  try {
    const p = path.join(DATA_DIR, 'normalized', 'flights_basic.json');
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
      const ins = db.prepare(`INSERT OR REPLACE INTO normalized_flights_basic (flight_id, flight_no, date, dep_station, arr_station, dep_utc, arr_utc, block_hours, aircraft, aircraft_type, seats, seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      doc.forEach((r: any, i: number) => ins.run(r.flight_id, r.flight_no, r.date, r.dep_station, r.arr_station, r.dep_utc, r.arr_utc, r.block_hours, r.aircraft, r.aircraft_type, r.seats, i));
    }
  } catch (e) { /* tolerate */ }

  // normalized/pairings.json
  try {
    const p = path.join(DATA_DIR, 'normalized', 'pairings.json');
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
      const ins = db.prepare('INSERT OR REPLACE INTO normalized_pairings (pairing_id, aircraft, seq) VALUES (?,?,?)');
      doc.forEach((r: any, i: number) => ins.run(r.pairing_id, r.aircraft, i));
    }
  } catch (e) { }

  // normalized/pairing_crew.json
  try {
    const p = path.join(DATA_DIR, 'normalized', 'pairing_crew.json');
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
      const ins = db.prepare('INSERT OR REPLACE INTO normalized_pairing_crew (pairing_id, crew_id, role, seq) VALUES (?,?,?,?)');
      doc.forEach((r: any, i: number) => ins.run(r.pairing_id, r.crew_id, r.role, i));
    }
  } catch (e) { }

  // normalized/pairing_legs.json
  try {
    const p = path.join(DATA_DIR, 'normalized', 'pairing_legs.json');
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
      const ins = db.prepare('INSERT OR REPLACE INTO normalized_pairing_legs (pairing_id, flight_id, seq) VALUES (?,?,?)');
      doc.forEach((r: any, i: number) => ins.run(r.pairing_id, r.flight_id, r.seq ?? i));
    }
  } catch (e) { }

  // normalized/crew_base.json
  try {
    const p = path.join(DATA_DIR, 'normalized', 'crew_base.json');
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
      const ins = db.prepare('INSERT OR REPLACE INTO normalized_crew_base (crew_id, name, rank, base, seniority, reachability_minutes, status, seq) VALUES (?,?,?,?,?,?,?,?)');
      doc.forEach((r: any, i: number) => ins.run(r.crew_id, r.name, r.rank, r.base, r.seniority, r.reachability_minutes, r.status, i));
    }
  } catch (e) { }

  // normalized/duty_clock_summary.json
  try {
    const p = path.join(DATA_DIR, 'normalized', 'duty_clock_summary.json');
    if (fs.existsSync(p)) {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as any[];
      const ins = db.prepare('INSERT OR REPLACE INTO normalized_duty_clock_summary (crew_id, as_of_utc, duty_hours_7d, flight_hours_28d, last_rest_ended, seq) VALUES (?,?,?,?,?,?)');
      doc.forEach((r: any, i: number) => ins.run(r.crew_id, r.as_of_utc, r.duty_hours_7d, r.flight_hours_28d, r.last_rest_ended, i));
    }
  } catch (e) { }
}

function loadRiskSignals(db: Database.Database) {
  const ins = db.prepare(`
    INSERT INTO risk_signals (crew_id, as_of_utc, disruption_risk_score, seq)
    VALUES (?,?,?,?)`);
  const driver = db.prepare(
    'INSERT INTO risk_drivers (crew_id, seq, driver) VALUES (?,?,?)');

  readJson('risk_signals').forEach((r: any, seq: number) => {
    ins.run(r.crew_id, r.as_of_utc, r.disruption_risk_score, seq);
    (r.drivers || []).forEach((d: string, j: number) => driver.run(r.crew_id, j, d));
  });
}

function loadImpacts(db: Database.Database) {
  // Load a consolidated, tool-produced detailed impacts file. This file is
  // a derived artifact and not required for core rules or verification; the
  // loader is therefore tolerant: if the file is absent the ingest proceeds
  // normally. When present, rows are inserted into two small tables that
  // let analysts query replacement/cancellation cost scenarios alongside
  // the canonical snapshot (flights, pairings, crew).
  const filePath = path.join(DATA_DIR, 'costs', 'impacts_detailed_consolidated.json');
  if (!fs.existsSync(filePath)) return;
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as any[];

  // Pairing-level baseline (keeps the small summary object as JSON text).
  const insPair = db.prepare(
    'INSERT OR REPLACE INTO impacts_pairing (crew_id, pairing_id, role, baseline_json, seq) VALUES (?,?,?,?,?)'
  );

  // Leg-level numeric estimates used to compute recommendations. Storing
  // them as columns avoids re-parsing JSON for common analytic queries.
  const insLeg = db.prepare(
    `INSERT OR REPLACE INTO impacts_leg (crew_id, pairing_id, leg_seq, flight_id, remaining_legs, cancel_cost, reserve_total, deadhead_only, recommended_action, seq)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  // Iterate deterministic order: the consolidated file is stable but we
  // retain seq values to preserve any original ordering semantics.
  doc.forEach((c: any, ci: number) => {
    const crew_id = c.crew_id;
    (c.pairings || []).forEach((p: any, pi: number) => {
      insPair.run(crew_id, p.pairing_id, p.role || null, JSON.stringify(p.baseline_pairing_costs || {}), pi);
      (p.leg_scenarios || []).forEach((l: any, li: number) => {
        const costs = l.costs || {};
        insLeg.run(
          crew_id,
          p.pairing_id,
          l.dropped_before_leg || (li + 1),
          l.flight_id || null,
          l.remaining_legs || 0,
          costs.cancel_cost ?? null,
          costs.reserve_total ?? null,
          costs.deadhead_only ?? null,
          l.recommended_action || null,
          li
        );
      });
    });
  });
}

function loadDerivedArtifacts(db: Database.Database) {
  // Walk DATA_DIR and its common subfolders and insert any JSON files
  // that are not part of the canonical ALL_FILES set into
  // `derived_json_files` so the DB contains the exact tool outputs.
  const crypto = require('crypto');
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(p);
    }
  }

  walk(DATA_DIR);
  const ins = db.prepare('INSERT OR REPLACE INTO derived_json_files (filename, sha256, bytes, json_text, seq) VALUES (?,?,?,?,?)');
  let seq = 0;
  for (const abs of files.sort()) {
    const rel = path.relative(DATA_DIR, abs).replace(/\\/g, '/');
    const base = path.basename(rel, '.json');
    // Skip the canonical source files; they are already recorded in source_files
    if ((ALL_FILES as readonly string[]).includes(base)) continue;
    const buf = fs.readFileSync(abs);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    ins.run(rel, hash, buf.length, buf.toString('utf-8'), seq++);
  }
}

function loadHarness(db: Database.Database) {
  // Answer keys are heterogeneous assertions — a string, a number, a list or
  // an object depending on the question — so they are stored whole rather
  // than shredded into columns that would invent a structure the data has not
  // got. These two are harness input, not world state.
  const scenario = db.prepare(`
    INSERT INTO harness_scenarios (scenario_id, difficulty, title, event_json,
                                   answer_key_json, seq)
    VALUES (?,?,?,?,?,?)`);
  readJson('scenarios').forEach((s: any, seq: number) =>
    scenario.run(s.scenario_id, s.difficulty, s.title,
                 JSON.stringify(s.event), JSON.stringify(s.answer_key), seq));

  const question = db.prepare(`
    INSERT INTO harness_questions (question_id, tier, prompt,
                                   expected_answer_json, explanation,
                                   rules_ref_json, seq)
    VALUES (?,?,?,?,?,?,?)`);
  readJson('questions').forEach((q: any, seq: number) =>
    question.run(q.question_id, q.tier, q.prompt,
                 JSON.stringify(q.expected_answer), q.explanation,
                 JSON.stringify(q.rules_ref), seq));
}

// ------------------------------------------------------------------ build

export function build(): void {
  // Build into a sibling temp file and swap it in only once it is complete
  // and its foreign keys check out. Deleting the live database first meant a
  // parse error or a bad row left no database at all — recoverable, since the
  // JSON is the source of truth, but it also fails on Windows if a reader
  // still holds the file open, and leaves readers pointing at nothing.
  const tmpPath = `${DB_PATH}.building`;
  for (const stale of [tmpPath, `${tmpPath}-journal`, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }

  const db = openForWrite(tmpPath);
  try {
    db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
    db.pragma('foreign_keys = ON');

    // One transaction for the lot: better-sqlite3 is synchronous, and this
    // turns ~6,400 inserts into a single fsync.
    db.transaction(() => {
      loadProvenance(db);
      loadFlights(db);
      loadCrew(db);
      loadRosters(db);
      loadDutyClocks(db);
      loadCertifications(db);
      loadReserves(db);
      loadRules(db);
      loadReserveAvailability(db);
      loadCosts(db);
      loadCostsPerFlight(db);
      loadCostsPerPairing(db);
      loadNormalizedArtifacts(db);
      loadRiskSignals(db);
      loadImpacts(db);
      loadDerivedArtifacts(db);
      loadHarness(db);
    })();

    const problems = db.pragma('foreign_key_check') as any[];
    if (problems.length) {
      throw new Error(`foreign key violations after ingest: ${JSON.stringify(problems.slice(0, 5))}`);
    }
    db.exec('VACUUM');
    db.close();

    // Only now is the old database replaced. rename is atomic within a
    // filesystem, so a reader sees either the previous database or the new
    // one, never a half-built file.
    fs.renameSync(tmpPath, DB_PATH);
  } catch (err) {
    try { db.close(); } catch { /* already closed on the success path */ }
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw err;
  }
}

function main() {
  const started = Date.now();
  build();

  const db = new Database(DB_PATH, { readonly: true });
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  const total = tables.reduce(
    (n, t) => n + (db.prepare(`SELECT count(*) c FROM "${t.name}"`).get() as any).c, 0);
  db.close();

  const kb = (fs.statSync(DB_PATH).size / 1024).toFixed(0);
  console.log(
    `built airline.db - ${tables.length} tables, ${total.toLocaleString()} rows, ` +
    `${kb} KB in ${Date.now() - started} ms`);
  console.log('verify with: npm run verify');
}

if (require.main === module) main();
