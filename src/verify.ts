/**
 * Check airline.db against the JSON it was built from.   `npm run verify`
 *
 * Five groups:
 *
 *   1. provenance   the recorded source hashes still match data/*.json
 *   2. counts       every table holds what the JSON holds
 *   3. integrity    foreign keys clean, and the invariants the rules rely on
 *   4. round trip   all eleven files reconstruct from the database
 *   5. rules        RULE-DUTY-02 / FLT-03 agree with the JSON computed
 *                   independently — the regression for the snapshot-column bug
 *
 * Nothing here hardcodes a row count or an hours figure. Every expectation is
 * derived from data/*.json at run time, so this stays correct if the dataset
 * is regenerated — which matters, because more than one generator run of this
 * dataset exists in the wild.
 *
 * Exit code 0 on PASS, 1 on FAIL.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, DB_PATH, getDb } from './db';
import { ALL_FILES, readJson } from './ingest';
import { RulesEngine, Schemas, calendarWindow, ruleParams } from './rulesEngine';

const round2 = (n: number) => Math.round(n * 100) / 100;

const failures: string[] = [];
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
    checks++;
    if (!ok) failures.push(label + (detail ? `: ${detail}` : ''));
}

function equal(label: string, actual: unknown, expected: unknown): void {
    check(label, deepEqual(actual, expected),
          `expected ${short(expected)}, got ${short(actual)}`);
}

function short(v: unknown): string {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s === undefined ? String(v) : (s.length > 140 ? s.slice(0, 140) + '…' : s);
}

/** Key-order-independent deep equality. */
function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b);
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const rows = (sql: string, ...args: any[]): any[] => getDb().prepare(sql).all(...args);
const count = (table: string): number =>
    (getDb().prepare(`SELECT count(*) c FROM "${table}"`).get() as any).c;

// 1. provenance -----------------------------------------------------------

function provenance() {
    const recorded = rows('SELECT filename, sha256 FROM source_files');
    equal('source_files rows', recorded.length, ALL_FILES.length);
    for (const r of recorded) {
        const file = path.join(DATA_DIR, r.filename);
        if (!fs.existsSync(file)) {
            check(`provenance ${r.filename}`, false, 'source file missing');
            continue;
        }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        check(`provenance ${r.filename}`, actual === r.sha256,
              'source JSON changed since ingest - re-run `npm run ingest`');
    }
}

// 2. counts ---------------------------------------------------------------

function counts() {
    const crew = readJson('crew');
    const clocks = readJson('duty_clocks');
    const rosters = readJson('rosters');
    const reserves = readJson('reserve_pool');
    const risk = readJson('risk_signals');
    const rules = readJson('rules');
    const sum = (xs: any[], f: (x: any) => number) => xs.reduce((n, x) => n + f(x), 0);

    equal('count(flights)', count('flights'), readJson('flights').length);
    equal('count(crew)', count('crew'), crew.length);
    equal('count(crew_ratings)', count('crew_ratings'), sum(crew, (c) => c.ratings.length));
    equal('count(pairings)', count('pairings'), rosters.pairings.length);
    equal('count(pairing_days)', count('pairing_days'), sum(rosters.pairings, (p) => p.days.length));
    equal('count(pairing_crew)', count('pairing_crew'), sum(rosters.pairings, (p) => p.crew.length));
    equal('count(pairing_day_flights)', count('pairing_day_flights'),
          sum(rosters.pairings, (p) => sum(p.days, (d: any) => d.flights.length)));
    equal('count(flagged_exceptions)', count('flagged_exceptions'), rosters.flagged_exceptions.length);
    equal('count(duty_clocks)', count('duty_clocks'), clocks.length);
    // The row the previous ingest dropped entirely.
    equal('count(duty_daily_history)', count('duty_daily_history'),
          sum(clocks, (c) => c.daily_history.length));
    equal('count(certifications)', count('certifications'), readJson('certifications').length);
    equal('count(reserves)', count('reserves'), reserves.length);
    equal('count(reserve_dates)', count('reserve_dates'), sum(reserves, (r) => r.dates.length));
    equal('count(rules)', count('rules'), rules.rules.length);
    equal('count(rule_params)', count('rule_params'),
          sum(rules.rules, (r: any) => Object.keys(r.params ?? {}).length));
    equal('count(rule_definitions)', count('rule_definitions'), Object.keys(rules.definitions).length);
    equal('count(costs)', count('costs'), Object.keys(readJson('costs')).length);
    equal('count(risk_signals)', count('risk_signals'), risk.length);
    equal('count(risk_drivers)', count('risk_drivers'), sum(risk, (r) => r.drivers.length));
    equal('count(harness_scenarios)', count('harness_scenarios'), readJson('scenarios').length);
    equal('count(harness_questions)', count('harness_questions'), readJson('questions').length);
}

// 3. integrity ------------------------------------------------------------

function integrity() {
    equal('foreign_key_check', getDb().pragma('foreign_key_check'), []);
    equal('integrity_check', (getDb().pragma('integrity_check') as any[])[0].integrity_check, 'ok');

    equal('every crew has a duty clock',
          rows(`SELECT c.crew_id FROM crew c LEFT JOIN duty_clocks d USING (crew_id)
                WHERE d.crew_id IS NULL`).map(r => r.crew_id), []);
    equal('every crew has 4 certifications',
          rows(`SELECT crew_id FROM certifications GROUP BY crew_id HAVING count(*) != 4`)
              .map(r => r.crew_id), []);

    // Uniform history length, whatever it is — the window sums assume it.
    const lengths = rows('SELECT count(*) n FROM duty_daily_history GROUP BY crew_id')
        .map(r => r.n);
    check('daily_history length is uniform', new Set(lengths).size === 1,
          `saw lengths ${[...new Set(lengths)].join(', ')}`);

    equal('no orphan flights',
          rows(`SELECT f.flight_id FROM flights f
                LEFT JOIN pairing_day_flights p USING (flight_id)
                WHERE p.flight_id IS NULL`).map(r => r.flight_id), []);
    equal('no flight flown twice',
          rows(`SELECT flight_id FROM pairing_day_flights GROUP BY flight_id
                HAVING count(*) > 1`).map(r => r.flight_id), []);

    // crew.status survives the ingest — the old schema had no such column,
    // so leave/training crew were indistinguishable from active ones.
    const statuses = rows('SELECT DISTINCT status FROM crew').map(r => r.status).sort();
    check('crew.status is populated', statuses.length > 1, `statuses: ${statuses.join(', ')}`);
}

// 4. round trip -----------------------------------------------------------

function exportAll(): Record<string, any> {
    const group = <T, K extends string | number>(xs: any[], key: (x: any) => K, val: (x: any) => T) => {
        const out = new Map<K, T[]>();
        for (const x of xs) {
            const k = key(x);
            if (!out.has(k)) out.set(k, []);
            out.get(k)!.push(val(x));
        }
        return out;
    };
    const meta = (k: string) =>
        (getDb().prepare('SELECT value FROM dataset_meta WHERE key = ?').get(k) as any).value;

    const ratings = group(rows('SELECT * FROM crew_ratings ORDER BY crew_id, seq'),
                          r => r.crew_id as string, r => r.rating as string);
    const legs = group(rows('SELECT * FROM pairing_day_flights ORDER BY pairing_id, date, seq'),
                       r => `${r.pairing_id}|${r.date}`, r => r.flight_id as string);
    const pDays = group(rows('SELECT * FROM pairing_days ORDER BY pairing_id, seq'),
                        r => r.pairing_id as string, r => ({
                            date: r.date,
                            flights: legs.get(`${r.pairing_id}|${r.date}`) ?? [],
                            report_utc: r.report_utc,
                            release_utc: r.release_utc,
                        }));
    const pCrew = group(rows('SELECT * FROM pairing_crew ORDER BY pairing_id, seq'),
                        r => r.pairing_id as string, r => ({ crew_id: r.crew_id, role: r.role }));
    const history = group(rows('SELECT * FROM duty_daily_history ORDER BY crew_id, seq'),
                          r => r.crew_id as string, r => ({
                              date: r.date, duty_hours: r.duty_hours, flight_hours: r.flight_hours }));
    const rDates = group(rows('SELECT * FROM reserve_dates ORDER BY crew_id, seq'),
                         r => r.crew_id as string, r => r.date as string);
    const drivers = group(rows('SELECT * FROM risk_drivers ORDER BY crew_id, seq'),
                          r => r.crew_id as string, r => r.driver as string);
    const params = group(rows('SELECT * FROM rule_params ORDER BY rule_id, seq'),
                         r => r.rule_id as string,
                         r => [r.param_key, r.is_int ? Math.round(r.value_num) : r.value_num] as [string, number]);

    return {
        'flights.json': rows('SELECT * FROM flights ORDER BY seq').map(r => ({
            flight_id: r.flight_id, flight_no: r.flight_no, date: r.date,
            dep_station: r.dep_station, arr_station: r.arr_station,
            dep_utc: r.dep_utc, arr_utc: r.arr_utc, block_hours: r.block_hours,
            aircraft: r.aircraft, aircraft_type: r.aircraft_type, seats: r.seats })),

        'crew.json': rows('SELECT * FROM crew ORDER BY seq').map(r => ({
            crew_id: r.crew_id, name: r.name, rank: r.rank, base: r.base,
            ratings: ratings.get(r.crew_id) ?? [], seniority: r.seniority,
            reachability_minutes: r.reachability_minutes, status: r.status })),

        'rosters.json': {
            pairings: rows('SELECT * FROM pairings ORDER BY seq').map(r => ({
                pairing_id: r.pairing_id, aircraft: r.aircraft,
                days: pDays.get(r.pairing_id) ?? [], crew: pCrew.get(r.pairing_id) ?? [] })),
            flagged_exceptions: rows('SELECT * FROM flagged_exceptions ORDER BY seq').map(r => ({
                crew_id: r.crew_id, date: r.date, rule: r.rule, note: r.note })),
            note: meta('rosters_note'),
        },

        'duty_clocks.json': rows('SELECT * FROM duty_clocks ORDER BY seq').map(r => ({
            crew_id: r.crew_id, as_of_utc: r.as_of_utc, duty_hours_7d: r.duty_hours_7d,
            flight_hours_28d: r.flight_hours_28d, last_rest_ended: r.last_rest_ended,
            daily_history: history.get(r.crew_id) ?? [] })),

        'reserve_pool.json': rows('SELECT * FROM reserves ORDER BY seq').map(r => ({
            crew_id: r.crew_id, base: r.base, dates: rDates.get(r.crew_id) ?? [],
            oncall_window_utc: { start: r.oncall_start, end: r.oncall_end }, note: r.note })),

        'certifications.json': rows('SELECT * FROM certifications ORDER BY seq').map(r => ({
            crew_id: r.crew_id, cert_type: r.cert_type,
            valid_from: r.valid_from, valid_to: r.valid_to })),

        'rules.json': {
            time_convention: meta('time_convention'),
            definitions: Object.fromEntries(
                rows('SELECT * FROM rule_definitions ORDER BY seq').map(r => [r.term, r.text])),
            rules: rows('SELECT * FROM rules ORDER BY seq').map(r => {
                const p = params.get(r.rule_id);
                // Absent, not empty — three rules have no params key at all.
                return p ? { rule_id: r.rule_id, text: r.text, params: Object.fromEntries(p) }
                         : { rule_id: r.rule_id, text: r.text };
            }),
        },

        'costs.json': Object.fromEntries(rows('SELECT * FROM costs ORDER BY seq')
            .map(r => [r.key, r.value_int === null ? r.value_text : r.value_int])),

        'risk_signals.json': rows('SELECT * FROM risk_signals ORDER BY seq').map(r => ({
            crew_id: r.crew_id, as_of_utc: r.as_of_utc,
            disruption_risk_score: r.disruption_risk_score,
            drivers: drivers.get(r.crew_id) ?? [] })),

        'scenarios.json': rows('SELECT * FROM harness_scenarios ORDER BY seq').map(r => ({
            scenario_id: r.scenario_id, difficulty: r.difficulty, title: r.title,
            event: JSON.parse(r.event_json), answer_key: JSON.parse(r.answer_key_json) })),

        'questions.json': rows('SELECT * FROM harness_questions ORDER BY seq').map(r => ({
            question_id: r.question_id, tier: r.tier, prompt: r.prompt,
            expected_answer: JSON.parse(r.expected_answer_json),
            explanation: r.explanation, rules_ref: JSON.parse(r.rules_ref_json) })),
    };
}

function roundTrip() {
    const rebuilt = exportAll();
    for (const name of ALL_FILES) {
        const file = `${name}.json`;
        check(`round trip ${file}`, deepEqual(rebuilt[file], readJson(name)),
              'reconstruction from SQLite differs from the JSON on disk');
    }
}

// 5. rules ----------------------------------------------------------------

/**
 * The regression for the bug this branch fixes.
 *
 * RULE-DUTY-02 used to read duty_clocks.duty_hours_7d — a snapshot artifact
 * valid only for the window ending on the dataset's as_of date. Here every
 * crew member's window is recomputed straight from duty_clocks.json and
 * compared against the engine, on a date that is NOT the snapshot date.
 */
function rulesAgainstTheJson() {
    const clocks = readJson('duty_clocks');
    const dutyDate = '2026-09-15';
    const newDuty = 9.5;
    const windowDays = ruleParams('RULE-DUTY-02')['window_days'];
    const window = calendarWindow(dutyDate, windowDays);
    const limit = ruleParams('RULE-DUTY-02')['max_duty_hours'];

    let mismatches = 0;
    let wouldHaveBeenWrong = 0;

    for (const c of clocks) {
        const byDate = new Map<string, number>(
            c.daily_history.map((h: any) => [h.date, h.duty_hours]));
        const truth = Math.round(
            (window.reduce((n, d) => n + (byDate.get(d) ?? 0), 0) + newDuty) * 100) / 100;

        const got = RulesEngine.checkDuty02({
            crewId: c.crew_id, newDutyHours: newDuty, dutyDate });
        if (Math.abs((got.actual ?? -1) - truth) > 0.011) mismatches++;
        if (got.legal !== (truth <= limit)) mismatches++;

        // How many the old implementation would have got wrong, for the record.
        const old = Math.round((c.duty_hours_7d + newDuty) * 100) / 100;
        if (Math.abs(old - truth) > 0.011) wouldHaveBeenWrong++;
    }

    equal('RULE-DUTY-02 matches the JSON for all crew', mismatches, 0);
    check('the snapshot-column bug is real and is now fixed', wouldHaveBeenWrong > 0,
          'duty_hours_7d happened to match every window — the regression proves nothing on this dataset');
    console.log(`  note: duty_hours_7d would have given the wrong figure for ` +
                `${wouldHaveBeenWrong}/${clocks.length} crew on ${dutyDate}`);

    // ---- RULE-FLT-03, checked the same way and for the same reason.
    // The header claimed both rules; for a while only DUTY-02 was actually
    // exercised, so a broken 28-day window would have passed `npm test`.
    const fltWindowDays = ruleParams('RULE-FLT-03')['window_days'];
    const fltWindow = calendarWindow(dutyDate, fltWindowDays);
    const fltLimit = ruleParams('RULE-FLT-03')['max_flight_hours'];
    const newFlight = 6.5;
    let fltMismatches = 0;

    for (const c of clocks) {
        const byDate = new Map<string, number>(
            c.daily_history.map((h: any) => [h.date, h.flight_hours]));
        const truth = Math.round(
            (fltWindow.reduce((n, d) => n + (byDate.get(d) ?? 0), 0) + newFlight) * 100) / 100;

        const got = RulesEngine.checkFlt03({
            crewId: c.crew_id, newFlightHours: newFlight, dutyDate });
        if (Math.abs((got.actual ?? -1) - truth) > 0.011) fltMismatches++;
        if (got.legal !== (truth <= fltLimit)) fltMismatches++;
    }
    equal('RULE-FLT-03 matches the JSON for all crew', fltMismatches, 0);
    check('RULE-FLT-03 limit is loaded from the rules table', fltLimit !== undefined);
    equal('RULE-FLT-03 window is 28 calendar dates', fltWindow.length, 28);

    // ---- Impossible dates must be rejected, not answered.
    // The shape-only regex accepted 2026-02-30, which produced a window of
    // nulls and a confident "Legal. 0h over null..null".
    check('a shape-valid but impossible date is rejected by the schema',
          !Schemas.DUTY02.safeParse(
              { crewId: 'C-2087', newDutyHours: 9.5, dutyDate: '2026-02-30' }).success);
    let threw = false;
    try { calendarWindow('2026-02-30', 7); } catch { threw = true; }
    check('calendarWindow throws on an impossible date', threw);

    // ---- Multi-day assignments must carry earlier proposed days forward.
    // Day 2 of a pairing has to see day 1's proposed duty, which is not in
    // duty_daily_history because it has not happened yet.
    const soloDay2 = RulesEngine.checkDuty02({
        crewId: 'C-3305', newDutyHours: 10.75, dutyDate: '2026-09-16' });
    const seqDay2 = RulesEngine.checkDuty02({
        crewId: 'C-3305', newDutyHours: 10.75, dutyDate: '2026-09-16',
        priorProposed: { '2026-09-15': 9.5 } });
    check('day 2 in isolation misses day 1 (the bug being guarded)',
          soloDay2.legal === true);
    check('day 2 with priorProposed breaches DUTY-02',
          seqDay2.legal === false,
          `expected a breach, got ${seqDay2.actual}h`);
    equal('C-3305 sequential day-2 total', seqDay2.actual, round2(soloDay2.actual! + 9.5));

    // Params come from the table, not from constants in the code.
    check('RULE-DUTY-02 limit is loaded from the rules table', limit !== undefined);
    for (const id of ['RULE-QUAL-05', 'RULE-CERT-06', 'RULE-BASE-07']) {
        equal(`${id} has no params`, Object.keys(ruleParams(id)).length, 0);
    }
}

// -------------------------------------------------------------------- cli

function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error('FAIL - airline.db does not exist. Build it: npm run ingest');
        process.exit(1);
    }

    provenance();
    counts();
    integrity();
    roundTrip();
    rulesAgainstTheJson();

    if (failures.length) {
        console.error(`\nFAIL - ${failures.length} of ${checks} checks failed\n`);
        for (const f of failures) console.error(`  x ${f}`);
        process.exit(1);
    }
    console.log(`\nPASS - ${checks} checks on airline.db`);
}

if (require.main === module) main();
