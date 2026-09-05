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
  const rows: [string, string][] = [
    ['schema_version', SCHEMA_VERSION],
    ['source', 'data/*.json (the source of truth)'],
    ['carrier', 'dCortex Air'],
    ['hub', 'BLR'],
    ['week_start', '2026-09-14'],
    ['week_end', '2026-09-20'],
    ['snapshot_utc', '2026-09-14T18:00:00Z'],
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

function loadCosts(db: Database.Database) {
  const ins = db.prepare(
    'INSERT INTO costs (key, value_int, value_text, seq) VALUES (?,?,?,?)');
  Object.entries(readJson('costs')).forEach(([k, v], i) =>
    ins.run(k, typeof v === 'number' ? v : null,
            typeof v === 'string' ? v : null, i));
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
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = openForWrite();
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
      loadCosts(db);
      loadRiskSignals(db);
      loadHarness(db);
    })();

    const problems = db.pragma('foreign_key_check') as any[];
    if (problems.length) {
      throw new Error(`foreign key violations after ingest: ${JSON.stringify(problems.slice(0, 5))}`);
    }
    db.exec('VACUUM');
  } finally {
    db.close();
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
