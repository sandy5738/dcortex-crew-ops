#!/usr/bin/env python3
"""Generate a single consolidated detailed impacts JSON for all crew.

This produces `data/costs/impacts_detailed_consolidated.json` and does NOT
write individual per-crew files.
"""
import json
import os
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
NORM_DIR = os.path.join(DATA_DIR, "normalized")
COSTS_DIR = os.path.join(DATA_DIR, "costs")
OUT_PATH = os.path.join(COSTS_DIR, "impacts_detailed_consolidated.json")


def ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def crew_is_pilot(rank: str) -> bool:
    if not rank:
        return False
    r = rank.lower()
    return "captain" in r or "first" in r or "pilot" in r or "fo" in r


def main():
    ensure_dir(COSTS_DIR)

    pairings = load(os.path.join(NORM_DIR, "pairings.json"))
    pairing_legs = load(os.path.join(NORM_DIR, "pairing_legs.json"))
    pairing_crew = load(os.path.join(NORM_DIR, "pairing_crew.json"))
    flights = load(os.path.join(NORM_DIR, "flights_basic.json"))
    costs_per_flight = load(os.path.join(COSTS_DIR, "costs_per_flight.json"))
    costs_per_pairing = load(os.path.join(COSTS_DIR, "costs_per_pairing.json"))
    costs = load(os.path.join(DATA_DIR, "costs.json"))
    certifications = load(os.path.join(DATA_DIR, "certifications.json"))
    reserve_pool = load(os.path.join(DATA_DIR, "reserve_pool.json"))
    crew_base = load(os.path.join(NORM_DIR, "crew_base.json"))

    # maps
    pairing_map = {p.get("pairing_id"): p for p in pairings}
    legs_by_pairing = {}
    for l in pairing_legs:
        legs_by_pairing.setdefault(l.get("pairing_id"), []).append(l.get("flight_id"))
    crew_pairings = {}
    for c in pairing_crew:
        crew_pairings.setdefault(c.get("crew_id"), []).append({"pairing_id": c.get("pairing_id"), "role": c.get("role")})
    pairing_cost_map = {c.get("pairing_id"): c for c in costs_per_pairing}

    deadhead_positioning = costs.get("deadhead_positioning", 0)
    cancel_per_flight = costs.get("cancellation_per_flight", 0)
    hotel_overnight = costs.get("hotel_overnight", 0)

    consolidated = []

    for crew in crew_base:
        cid = crew.get("crew_id")
        recs = crew_pairings.get(cid, [])
        crew_out = {"crew_id": cid, "pairings": []}
        for r in recs:
            pid = r.get("pairing_id")
            pairing = pairing_map.get(pid, {})
            legs = legs_by_pairing.get(pid, [])
            pairing_cost = pairing_cost_map.get(pid, {})

            leg_scenarios = []
            for i, flight_id in enumerate(legs):
                remaining = len(legs) - i
                cancel_cost = remaining * cancel_per_flight
                role_is_pilot = crew_is_pilot(crew.get("rank", ""))
                reserve_key = "reserve_callout_pilot" if role_is_pilot else "reserve_callout_cabin"
                reserve_callout = costs.get(reserve_key, 0)
                same_base = any(rp.get("base") == crew.get("base") for rp in reserve_pool)
                deadhead = 0 if same_base else deadhead_positioning
                nights = max(0, pairing.get("days", 1) - 1)
                hotel = nights * hotel_overnight
                reserve_total = reserve_callout + deadhead + hotel
                deadhead_only = deadhead_positioning + hotel
                best = min(cancel_cost, reserve_total, deadhead_only)
                if best == reserve_total:
                    rec = "reserve"
                elif best == deadhead_only:
                    rec = "deadhead"
                else:
                    rec = "cancel"

                leg_scenarios.append({
                    "dropped_before_leg": i + 1,
                    "flight_id": flight_id,
                    "remaining_legs": remaining,
                    "costs": {
                        "cancel_cost": cancel_cost,
                        "reserve_total": reserve_total,
                        "deadhead_only": deadhead_only,
                    },
                    "recommended_action": rec,
                })

            crew_out["pairings"].append({
                "pairing_id": pid,
                "role": r.get("role"),
                "leg_scenarios": leg_scenarios,
                "baseline_pairing_costs": pairing_cost,
            })

        consolidated.append(crew_out)

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(consolidated, f, indent=2)

    print("Wrote consolidated detailed impacts to:", OUT_PATH)


if __name__ == "__main__":
    main()
