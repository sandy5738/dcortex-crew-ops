#!/usr/bin/env python3
"""Ingest detailed impact JSONs into a SQLite DB for querying.

Creates `data/impacts.db` with two tables:
 - impacts_summary (crew_id, pairing_id, recommended_action, baseline_json)
 - impacts_leg (crew_id, pairing_id, leg_seq, flight_id, cancel_cost, reserve_total, deadhead_only, recommended_action)

Run: py -3 tools\ingest_impacts_sqlite.py
"""
import json
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
COSTS_DIR = os.path.join(DATA_DIR, "costs")
DB_PATH = os.path.join(DATA_DIR, "impacts.db")
IMPACTS_DIR = os.path.join(COSTS_DIR, "impacts_detailed")


def ensure_db(conn):
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS impacts_summary (
        crew_id TEXT,
        pairing_id TEXT,
        recommended_action TEXT,
        baseline_json TEXT,
        PRIMARY KEY (crew_id, pairing_id)
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS impacts_leg (
        crew_id TEXT,
        pairing_id TEXT,
        leg_seq INTEGER,
        flight_id TEXT,
        cancel_cost INTEGER,
        reserve_total INTEGER,
        deadhead_only INTEGER,
        recommended_action TEXT,
        PRIMARY KEY (crew_id, pairing_id, leg_seq)
    )
    """)
    conn.commit()


def ingest_file(conn, path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    crew_id = data.get("crew_id")
    for p in data.get("pairings", []):
        pid = p.get("pairing_id")
        leg_scenarios = p.get("leg_scenarios", [])
        # pick first recommended action among legs as summary
        recs = [l.get("recommended_action") for l in leg_scenarios if l.get("recommended_action")]
        summary_rec = recs[0] if recs else None
        cur = conn.cursor()
        cur.execute("INSERT OR REPLACE INTO impacts_summary (crew_id, pairing_id, recommended_action, baseline_json) VALUES (?,?,?,?)",
                    (crew_id, pid, summary_rec, json.dumps(p.get("baseline_pairing_costs"))))
        for idx, l in enumerate(leg_scenarios, start=1):
            costs = l.get("costs", {})
            cur.execute("INSERT OR REPLACE INTO impacts_leg (crew_id, pairing_id, leg_seq, flight_id, cancel_cost, reserve_total, deadhead_only, recommended_action) VALUES (?,?,?,?,?,?,?,?)",
                        (crew_id, pid, idx, l.get("flight_id"), costs.get("cancel_cost"), costs.get("reserve_total"), costs.get("deadhead_only"), l.get("recommended_action")))
    conn.commit()


def main():
    conn = sqlite3.connect(DB_PATH)
    ensure_db(conn)
    files = [f for f in os.listdir(IMPACTS_DIR) if f.endswith('.json')]
    for fn in files:
        ingest_file(conn, os.path.join(IMPACTS_DIR, fn))
    conn.close()
    print("Ingested", len(files), "files into", DB_PATH)


if __name__ == "__main__":
    main()
