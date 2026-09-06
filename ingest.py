import sqlite3
import json
import os
import hashlib
from pathlib import Path
from datetime import datetime, timedelta

DATA_DIR = Path("data")
DB_PATH = "airline.db"

WORLD_FILES = ['flights', 'crew', 'rosters', 'duty_clocks', 'reserve_pool', 'certifications', 'rules', 'costs', 'risk_signals']
HARNESS_FILES = ['scenarios', 'questions']
ALL_FILES = WORLD_FILES + HARNESS_FILES
SCHEMA_VERSION = '1'

def read_json(name):
    with open(DATA_DIR / f"{name}.json", "r", encoding="utf-8") as f:
        return json.load(f)

def get_sha256(name):
    with open(DATA_DIR / f"{name}.json", "rb") as f:
        buf = f.read()
    return hashlib.sha256(buf).hexdigest(), len(buf)

def load_provenance(cursor):
    rules = read_json('rules')
    rosters = read_json('rosters')
    costs = read_json('costs')

    all_dates = []
    for p in rosters.get('pairings', []):
        for d in p.get('days', []):
            all_dates.append(d['date'])
    all_dates.sort()
    
    week_start = all_dates[0] if all_dates else ""
    week_end = ""
    if week_start:
        dt = datetime.strptime(week_start + 'T00:00:00Z', '%Y-%m-%dT%H:%M:%SZ')
        dt += timedelta(days=6)
        week_end = dt.strftime('%Y-%m-%d')
    
    snapshot_utc = costs.get('snapshot_utc', f"{week_start}T00:00:00Z" if week_start else "")

    rows = [
        ('schema_version', SCHEMA_VERSION),
        ('source', 'data/*.json (the source of truth)'),
        ('carrier', 'dCortex Air'),
        ('hub', 'BLR'),
        ('week_start', week_start),
        ('week_end', week_end),
        ('snapshot_utc', snapshot_utc),
        ('currency', costs.get('currency')),
        ('time_convention', rules.get('time_convention')),
        ('rosters_note', rosters.get('note'))
    ]
    cursor.executemany('INSERT INTO dataset_meta (key, value) VALUES (?, ?)', rows)

    src_rows = []
    for i, name in enumerate(ALL_FILES):
        h, b = get_sha256(name)
        in_snapshot = 1 if name in WORLD_FILES else 0
        src_rows.append((f"{name}.json", h, b, in_snapshot, i))
    cursor.executemany('INSERT INTO source_files (filename, sha256, bytes, in_snapshot, seq) VALUES (?,?,?,?,?)', src_rows)

def load_flights(cursor):
    data = read_json('flights')
    rows = []
    for i, f in enumerate(data):
        rows.append((f.get('flight_id'), f.get('flight_no'), f.get('date'), f.get('dep_station'), f.get('arr_station'), f.get('dep_utc'), f.get('arr_utc'), f.get('block_hours'), f.get('aircraft'), f.get('aircraft_type'), f.get('seats'), i))
    cursor.executemany('INSERT INTO flights (flight_id, flight_no, date, dep_station, arr_station, dep_utc, arr_utc, block_hours, aircraft, aircraft_type, seats, seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', rows)

def load_crew(cursor):
    data = read_json('crew')
    crew_rows = []
    rating_rows = []
    for i, c in enumerate(data):
        crew_id = c.get('crew_id')
        crew_rows.append((crew_id, c.get('name'), c.get('rank'), c.get('base'), c.get('seniority'), c.get('reachability_minutes'), c.get('status'), i))
        for j, r in enumerate(c.get('ratings', [])):
            rating_rows.append((crew_id, r, j))
    cursor.executemany('INSERT INTO crew (crew_id, name, rank, base, seniority, reachability_minutes, status, seq) VALUES (?,?,?,?,?,?,?,?)', crew_rows)
    cursor.executemany('INSERT INTO crew_ratings (crew_id, rating, seq) VALUES (?,?,?)', rating_rows)

def load_rosters(cursor):
    doc = read_json('rosters')
    p_rows = []
    d_rows = []
    l_rows = []
    c_rows = []
    f_rows = []
    
    for i, p in enumerate(doc.get('pairings', [])):
        pid = p.get('pairing_id')
        p_rows.append((pid, p.get('aircraft'), i))
        for j, d in enumerate(p.get('days', [])):
            d_rows.append((pid, d.get('date'), d.get('report_utc'), d.get('release_utc'), j))
            for k, fid in enumerate(d.get('flights', [])):
                l_rows.append((pid, d.get('date'), k, fid))
        for j, c in enumerate(p.get('crew', [])):
            c_rows.append((pid, c.get('crew_id'), c.get('role'), j))
            
    for i, f in enumerate(doc.get('flagged_exceptions', [])):
        f_rows.append((i, f.get('crew_id'), f.get('date'), f.get('rule'), f.get('note')))
        
    cursor.executemany('INSERT INTO pairings (pairing_id, aircraft, seq) VALUES (?,?,?)', p_rows)
    cursor.executemany('INSERT INTO pairing_days (pairing_id, date, report_utc, release_utc, seq) VALUES (?,?,?,?,?)', d_rows)
    cursor.executemany('INSERT INTO pairing_day_flights (pairing_id, date, seq, flight_id) VALUES (?,?,?,?)', l_rows)
    cursor.executemany('INSERT INTO pairing_crew (pairing_id, crew_id, role, seq) VALUES (?,?,?,?)', c_rows)
    cursor.executemany('INSERT INTO flagged_exceptions (seq, crew_id, date, rule, note) VALUES (?,?,?,?,?)', f_rows)

def load_duty_clocks(cursor):
    data = read_json('duty_clocks')
    dc_rows = []
    dh_rows = []
    for i, c in enumerate(data):
        cid = c.get('crew_id')
        dc_rows.append((cid, c.get('as_of_utc'), c.get('duty_hours_7d'), c.get('flight_hours_28d'), c.get('last_rest_ended'), i))
        for j, h in enumerate(c.get('daily_history', [])):
            dh_rows.append((cid, h.get('date'), h.get('duty_hours'), h.get('flight_hours'), j))
    cursor.executemany('INSERT INTO duty_clocks (crew_id, as_of_utc, duty_hours_7d, flight_hours_28d, last_rest_ended, seq) VALUES (?,?,?,?,?,?)', dc_rows)
    cursor.executemany('INSERT INTO duty_daily_history (crew_id, date, duty_hours, flight_hours, seq) VALUES (?,?,?,?,?)', dh_rows)

def load_certifications(cursor):
    data = read_json('certifications')
    rows = [(c.get('crew_id'), c.get('cert_type'), c.get('valid_from'), c.get('valid_to'), i) for i, c in enumerate(data)]
    cursor.executemany('INSERT INTO certifications (crew_id, cert_type, valid_from, valid_to, seq) VALUES (?,?,?,?,?)', rows)

def load_reserves(cursor):
    data = read_json('reserve_pool')
    r_rows = []
    d_rows = []
    for i, r in enumerate(data):
        cid = r.get('crew_id')
        r_rows.append((cid, r.get('base'), r.get('oncall_window_utc', {}).get('start'), r.get('oncall_window_utc', {}).get('end'), r.get('note'), i))
        for j, d in enumerate(r.get('dates', [])):
            d_rows.append((cid, d, j))
    cursor.executemany('INSERT INTO reserves (crew_id, base, oncall_start, oncall_end, note, seq) VALUES (?,?,?,?,?,?)', r_rows)
    cursor.executemany('INSERT INTO reserve_dates (crew_id, date, seq) VALUES (?,?,?)', d_rows)

def load_rules(cursor):
    doc = read_json('rules')
    r_rows = []
    p_rows = []
    d_rows = []
    
    for i, r in enumerate(doc.get('rules', [])):
        rid = r.get('rule_id')
        r_rows.append((rid, r.get('text'), i))
        for j, (k, v) in enumerate(r.get('params', {}).items()):
            p_rows.append((rid, k, float(v), 1 if isinstance(v, int) else 0, j))
            
    for i, (term, text) in enumerate(doc.get('definitions', {}).items()):
        d_rows.append((term, text, i))
        
    cursor.executemany('INSERT INTO rules (rule_id, text, seq) VALUES (?,?,?)', r_rows)
    cursor.executemany('INSERT INTO rule_params (rule_id, param_key, value_num, is_int, seq) VALUES (?,?,?,?,?)', p_rows)
    cursor.executemany('INSERT INTO rule_definitions (term, text, seq) VALUES (?,?,?)', d_rows)

def load_reserve_availability(cursor):
    cursor.execute("SELECT value_num FROM rule_params WHERE rule_id='RULE-DUTY-02' AND param_key='max_duty_hours'")
    dutyParam = cursor.fetchone()
    cursor.execute("SELECT value_num FROM rule_params WHERE rule_id='RULE-DUTY-02' AND param_key='window_days'")
    dutyWindow = cursor.fetchone()
    cursor.execute("SELECT value_num FROM rule_params WHERE rule_id='RULE-FLT-03' AND param_key='max_flight_hours'")
    flightParam = cursor.fetchone()
    cursor.execute("SELECT value_num FROM rule_params WHERE rule_id='RULE-FLT-03' AND param_key='window_days'")
    flightWindow = cursor.fetchone()

    maxDuty = dutyParam[0] if dutyParam else 60
    dutyDays = dutyWindow[0] if dutyWindow else 7
    maxFlight = flightParam[0] if flightParam else 100
    flightDays = flightWindow[0] if flightWindow else 28

    cursor.execute('SELECT crew_id, date FROM reserve_dates')
    reserveDates = cursor.fetchall()

    rows = []
    for crew, date in reserveDates:
        dStart = datetime.strptime(date + 'T00:00:00Z', '%Y-%m-%dT%H:%M:%SZ') - timedelta(days=dutyDays - 1)
        dutyStart = dStart.strftime('%Y-%m-%d')
        fStart = datetime.strptime(date + 'T00:00:00Z', '%Y-%m-%dT%H:%M:%SZ') - timedelta(days=flightDays - 1)
        flightStart = fStart.strftime('%Y-%m-%d')

        cursor.execute('SELECT SUM(duty_hours) FROM duty_daily_history WHERE crew_id = ? AND date BETWEEN ? AND ?', (crew, dutyStart, date))
        ds = cursor.fetchone()
        dutySum = max(0, ds[0] or 0) if ds else 0
        
        cursor.execute('SELECT SUM(flight_hours) FROM duty_daily_history WHERE crew_id = ? AND date BETWEEN ? AND ?', (crew, flightStart, date))
        fs = cursor.fetchone()
        flightSum = max(0, fs[0] or 0) if fs else 0

        usable = 1
        reason = None
        if dutySum >= maxDuty:
            usable = 0
            reason = 'duty_hours_exceeded'
        if flightSum >= maxFlight:
            usable = 0
            reason = f"{reason};flight_hours_exceeded" if reason else 'flight_hours_exceeded'

        rows.append((crew, date, usable, dutySum, flightSum, reason))
        
    cursor.executemany('INSERT OR REPLACE INTO reserve_availability (crew_id, date, usable, duty_hours_7d, flight_hours_28d, reason) VALUES (?,?,?,?,?,?)', rows)

def load_costs(cursor):
    data = read_json('costs')
    rows = []
    for i, (k, v) in enumerate(data.items()):
        rows.append((k, v if isinstance(v, (int, float)) else None, v if isinstance(v, str) else None, i))
    cursor.executemany('INSERT INTO costs (key, value_int, value_text, seq) VALUES (?,?,?,?)', rows)

def load_costs_per_flight(cursor):
    p = DATA_DIR / 'costs' / 'costs_per_flight.json'
    if not p.exists(): return
    with open(p, "r", encoding="utf-8") as f: doc = json.load(f)
    rows = [(r.get('flight_id'), r.get('cancellation_cost'), r.get('estimated_deadhead_cost'), r.get('estimated_delay_cost_per_hour')) for r in doc]
    cursor.executemany('INSERT OR REPLACE INTO costs_per_flight (flight_id, cancellation_cost, estimated_deadhead_cost, estimated_delay_cost_per_hour) VALUES (?,?,?,?)', rows)

def load_costs_per_pairing(cursor):
    p = DATA_DIR / 'costs' / 'costs_per_pairing.json'
    if not p.exists(): return
    with open(p, "r", encoding="utf-8") as f: doc = json.load(f)
    rows = [(r.get('pairing_id'), r.get('total_block_hours'), r.get('estimated_hotel_nights'), r.get('hotel_cost_total'), r.get('cancellation_costs_total')) for r in doc]
    cursor.executemany('INSERT OR REPLACE INTO costs_per_pairing (pairing_id, total_block_hours, estimated_hotel_nights, hotel_cost_total, cancellation_costs_total) VALUES (?,?,?,?,?)', rows)

def load_normalized_artifacts(cursor):
    try:
        p = DATA_DIR / 'normalized' / 'flights_basic.json'
        if p.exists():
            with open(p, "r", encoding="utf-8") as f: doc = json.load(f)
            rows = [(r.get('flight_id'), r.get('flight_no'), r.get('date'), r.get('dep_station'), r.get('arr_station'), r.get('dep_utc'), r.get('arr_utc'), r.get('block_hours'), r.get('aircraft'), r.get('aircraft_type'), r.get('seats'), i) for i, r in enumerate(doc)]
            cursor.executemany('INSERT OR REPLACE INTO normalized_flights_basic (flight_id, flight_no, date, dep_station, arr_station, dep_utc, arr_utc, block_hours, aircraft, aircraft_type, seats, seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', rows)
    except: pass

    try:
        p = DATA_DIR / 'normalized' / 'pairings.json'
        if p.exists():
            with open(p, "r", encoding="utf-8") as f: doc = json.load(f)
            rows = [(r.get('pairing_id'), r.get('aircraft'), i) for i, r in enumerate(doc)]
            cursor.executemany('INSERT OR REPLACE INTO normalized_pairings (pairing_id, aircraft, seq) VALUES (?,?,?)', rows)
    except: pass

def load_risk_signals(cursor):
    data = read_json('risk_signals')
    r_rows = []
    d_rows = []
    for i, r in enumerate(data):
        cid = r.get('crew_id')
        r_rows.append((cid, r.get('as_of_utc'), r.get('disruption_risk_score'), i))
        for j, d in enumerate(r.get('drivers', [])):
            d_rows.append((cid, j, d))
    cursor.executemany('INSERT INTO risk_signals (crew_id, as_of_utc, disruption_risk_score, seq) VALUES (?,?,?,?)', r_rows)
    cursor.executemany('INSERT INTO risk_drivers (crew_id, seq, driver) VALUES (?,?,?)', d_rows)

def load_impacts(cursor):
    p = DATA_DIR / 'costs' / 'impacts_detailed_consolidated.json'
    if not p.exists(): return
    with open(p, "r", encoding="utf-8") as f: doc = json.load(f)
    p_rows = []
    l_rows = []
    for ci, c in enumerate(doc):
        crew_id = c.get('crew_id')
        for pi, pairing in enumerate(c.get('pairings', [])):
            pid = pairing.get('pairing_id')
            p_rows.append((crew_id, pid, pairing.get('role'), json.dumps(pairing.get('baseline_pairing_costs', {})), pi))
            for li, l in enumerate(pairing.get('leg_scenarios', [])):
                costs = l.get('costs', {})
                l_rows.append((crew_id, pid, l.get('dropped_before_leg') or (li + 1), l.get('flight_id'), l.get('remaining_legs') or 0, costs.get('cancel_cost'), costs.get('reserve_total'), costs.get('deadhead_only'), l.get('recommended_action'), li))
    cursor.executemany('INSERT OR REPLACE INTO impacts_pairing (crew_id, pairing_id, role, baseline_json, seq) VALUES (?,?,?,?,?)', p_rows)
    cursor.executemany('INSERT OR REPLACE INTO impacts_leg (crew_id, pairing_id, leg_seq, flight_id, remaining_legs, cancel_cost, reserve_total, deadhead_only, recommended_action, seq) VALUES (?,?,?,?,?,?,?,?,?,?)', l_rows)

def load_derived_artifacts(cursor):
    rows = []
    seq = 0
    for root, dirs, files in os.walk(DATA_DIR):
        for file in sorted(files):
            if file.endswith('.json'):
                base = file[:-5]
                if base in ALL_FILES:
                    continue
                abs_path = os.path.join(root, file)
                rel = os.path.relpath(abs_path, DATA_DIR).replace('\\', '/')
                with open(abs_path, 'rb') as f:
                    buf = f.read()
                h = hashlib.sha256(buf).hexdigest()
                rows.append((rel, h, len(buf), buf.decode('utf-8'), seq))
                seq += 1
    cursor.executemany('INSERT OR REPLACE INTO derived_json_files (filename, sha256, bytes, json_text, seq) VALUES (?,?,?,?,?)', rows)

def load_harness(cursor):
    s_rows = []
    q_rows = []
    for i, s in enumerate(read_json('scenarios')):
        s_rows.append((s.get('scenario_id'), s.get('difficulty'), s.get('title'), json.dumps(s.get('event')), json.dumps(s.get('answer_key')), i))
    for i, q in enumerate(read_json('questions')):
        q_rows.append((q.get('question_id'), q.get('tier'), q.get('prompt'), json.dumps(q.get('expected_answer')), q.get('explanation'), json.dumps(q.get('rules_ref')), i))
    cursor.executemany('INSERT INTO harness_scenarios (scenario_id, difficulty, title, event_json, answer_key_json, seq) VALUES (?,?,?,?,?,?)', s_rows)
    cursor.executemany('INSERT INTO harness_questions (question_id, tier, prompt, expected_answer_json, explanation, rules_ref_json, seq) VALUES (?,?,?,?,?,?,?)', q_rows)

def build():
    tmp_path = f"{DB_PATH}.building"
    for stale in [tmp_path, f"{tmp_path}-journal", f"{tmp_path}-wal", f"{tmp_path}-shm"]:
        if os.path.exists(stale):
            os.remove(stale)

    conn = sqlite3.connect(tmp_path)
    try:
        with open("src/schema.sql", "r", encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.execute("PRAGMA foreign_keys = ON")
        cursor = conn.cursor()
        
        load_provenance(cursor)
        load_flights(cursor)
        load_crew(cursor)
        load_rosters(cursor)
        load_duty_clocks(cursor)
        load_certifications(cursor)
        load_reserves(cursor)
        load_rules(cursor)
        load_reserve_availability(cursor)
        load_costs(cursor)
        load_costs_per_flight(cursor)
        load_costs_per_pairing(cursor)
        load_normalized_artifacts(cursor)
        load_risk_signals(cursor)
        load_impacts(cursor)
        load_derived_artifacts(cursor)
        load_harness(cursor)

        conn.commit()
        
        cursor.execute("PRAGMA foreign_key_check")
        problems = cursor.fetchall()
        if problems:
            raise Exception(f"Foreign key violations after ingest: {problems[:5]}")
        
        conn.execute("VACUUM")
        conn.close()
        
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        os.rename(tmp_path, DB_PATH)
    except Exception as e:
        conn.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise e

if __name__ == "__main__":
    import time
    start = time.time()
    build()
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    tables = [row[0] for row in cursor.fetchall()]
    
    total = sum(conn.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in tables)
    conn.close()
    
    kb = int(os.path.getsize(DB_PATH) / 1024)
    ms = int((time.time() - start) * 1000)
    print(f"built airline.db - {len(tables)} tables, {total:,} rows, {kb} KB in {ms} ms")
