#!/usr/bin/env python3
"""Normalize dataset and extract cost-focused JSON files.

Usage: python tools/split_and_extract_costs.py
This reads data/*.json and writes:
 - data/normalized/crew_base.json
 - data/normalized/flights_basic.json
 - data/normalized/pairings.json
 - data/normalized/pairing_legs.json
 - data/normalized/pairing_crew.json
 - data/normalized/duty_clock_summary.json
 - data/costs/costs_per_flight.json
 - data/costs/costs_per_pairing.json

It also writes sql/cost_tables.sql with CREATE TABLE statements and sample inserts.
"""
import json
import os
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
NORM_DIR = os.path.join(DATA_DIR, "normalized")
COSTS_DIR = os.path.join(DATA_DIR, "costs")
SQL_DIR = os.path.join(ROOT, "sql")


def ensure_dirs():
    os.makedirs(NORM_DIR, exist_ok=True)
    os.makedirs(COSTS_DIR, exist_ok=True)
    os.makedirs(SQL_DIR, exist_ok=True)


def load(name):
    path = os.path.join(DATA_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def iso_to_dt(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def main():
    ensure_dirs()
    costs = load("costs.json")
    crew = load("crew.json")
    flights = load("flights.json")
    rosters = load("rosters.json")
    duty_clocks = load("duty_clocks.json")

    # Crew base file
    crew_base = []
    for c in crew:
        crew_base.append({
            "crew_id": c.get("crew_id"),
            "name": c.get("name"),
            "rank": c.get("rank"),
            "base": c.get("base"),
            "ratings": c.get("ratings"),
        })
    write_json(os.path.join(NORM_DIR, "crew_base.json"), crew_base)

    # Flights basic
    flights_basic = []
    for f in flights:
        flights_basic.append({
            "flight_id": f.get("flight_id"),
            "dep_utc": f.get("dep_utc"),
            "arr_utc": f.get("arr_utc"),
            "block_hours": f.get("block_hours"),
            "aircraft_type": f.get("aircraft_type"),
            "seats": f.get("seats"),
            "passengers": f.get("passengers", None),
        })
    write_json(os.path.join(NORM_DIR, "flights_basic.json"), flights_basic)

    # Pairings normalization (extract flights from days[])
    pairings = rosters.get("pairings", []) if isinstance(rosters, dict) else []
    pairings_out = []
    pairing_legs = []
    pairing_crew = []
    for p in pairings:
        pid = p.get("pairing_id")
        # rosters.json stores flights under p['days'] each with a 'date' and 'flights' list
        days = p.get("days", [])
        dates = [d.get("date") for d in days if d.get("date")]
        flights_in_p = []
        for d in days:
            for fid in d.get("flights", []):
                flights_in_p.append(fid)
        pairings_out.append({
            "pairing_id": pid,
            "start_date": dates[0] if dates else None,
            "end_date": dates[-1] if dates else None,
            "days": len(dates),
            "notes": p.get("notes"),
        })
        for idx, fid in enumerate(flights_in_p):
            pairing_legs.append({"pairing_id": pid, "flight_id": fid, "seq": idx + 1})
        for member in p.get("crew", []):
            pairing_crew.append({"pairing_id": pid, "crew_id": member.get("crew_id"), "role": member.get("role")})

    write_json(os.path.join(NORM_DIR, "pairings.json"), pairings_out)
    write_json(os.path.join(NORM_DIR, "pairing_legs.json"), pairing_legs)
    write_json(os.path.join(NORM_DIR, "pairing_crew.json"), pairing_crew)

    # Duty clocks summary
    duty_summary = []
    for d in duty_clocks:
        duty_summary.append({
            "crew_id": d.get("crew_id"),
            "duty_hours_7d": d.get("duty_hours_7d"),
            "flight_hours_28d": d.get("flight_hours_28d"),
            "last_rest_ended": d.get("last_rest_ended"),
        })
    write_json(os.path.join(NORM_DIR, "duty_clock_summary.json"), duty_summary)

    # Costs per flight
    costs_per_flight = []
    for f in flights:
        fid = f.get("flight_id")
        cancel = costs.get("cancellation_per_flight")
        deadhead = 0
        # placeholder: if aircraft_type is ATR and flight has seats < 70, assume special handling cost
        if f.get("aircraft_type", "").lower().startswith("atr"):
            deadhead = int(costs.get("deadhead_positioning", 0) * 0.8)
        costs_per_flight.append({
            "flight_id": fid,
            "cancellation_cost": cancel,
            "estimated_deadhead_cost": deadhead,
            "estimated_delay_cost_per_hour": costs.get("delay_cost_per_duty_hour"),
        })
    write_json(os.path.join(COSTS_DIR, "costs_per_flight.json"), costs_per_flight)

    # Costs per pairing
    costs_per_pairing = []
    # Map flights to block_hours for quick sum
    fh = {f["flight_id"]: f.get("block_hours", 0) for f in flights}
    for p in pairings_out:
        pid = p["pairing_id"]
        legs = [x for x in pairing_legs if x["pairing_id"] == pid]
        total_block = sum(fh.get(l["flight_id"], 0) for l in legs)
        nights = max(0, p["days"] - 1) if p.get("days") else 0
        hotel_cost = nights * costs.get("hotel_overnight", 0)
        cancel_total = len(legs) * costs.get("cancellation_per_flight", 0)
        costs_per_pairing.append({
            "pairing_id": pid,
            "total_block_hours": total_block,
            "estimated_hotel_nights": nights,
            "hotel_cost_total": hotel_cost,
            "cancellation_costs_total": cancel_total,
        })
    write_json(os.path.join(COSTS_DIR, "costs_per_pairing.json"), costs_per_pairing)

    # Write SQL DDL
    sql_path = os.path.join(SQL_DIR, "cost_tables.sql")
    with open(sql_path, "w", encoding="utf-8") as f:
        f.write("-- Cost tables DDL and sample inserts\n")
        f.write("CREATE TABLE IF NOT EXISTS costs_per_flight (flight_id TEXT PRIMARY KEY, cancellation_cost INTEGER, estimated_deadhead_cost INTEGER, estimated_delay_cost_per_hour INTEGER);\n")
        f.write("CREATE TABLE IF NOT EXISTS costs_per_pairing (pairing_id TEXT PRIMARY KEY, total_block_hours REAL, estimated_hotel_nights INTEGER, hotel_cost_total INTEGER, cancellation_costs_total INTEGER);\n\n")
        # sample inserts
        for c in costs_per_flight[:20]:
            f.write("INSERT OR REPLACE INTO costs_per_flight VALUES ('{}',{},{},{});\n".format(c["flight_id"], c["cancellation_cost"], c["estimated_deadhead_cost"], c.get("estimated_delay_cost_per_hour") or 0))
        f.write("\n")
        for c in costs_per_pairing[:50]:
            f.write("INSERT OR REPLACE INTO costs_per_pairing VALUES ('{}',{},{},{},{});\n".format(c["pairing_id"], c["total_block_hours"], c["estimated_hotel_nights"], c["hotel_cost_total"], c["cancellation_costs_total"]))

    print("Wrote normalized JSONs to:", NORM_DIR)
    print("Wrote cost JSONs to:", COSTS_DIR)
    print("Wrote SQL DDL to:", sql_path)


if __name__ == "__main__":
    main()
