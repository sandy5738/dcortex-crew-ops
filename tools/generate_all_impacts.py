#!/usr/bin/env python3
"""Generate per-crew impact JSONs for all crew IDs.

Writes files to `data/costs/impacts/<crew_id>.json` containing impact estimates
for each pairing the crew is assigned to. Uses the normalized and cost JSONs
produced by the earlier scripts.
"""
import json
import os
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
NORM_DIR = os.path.join(DATA_DIR, "normalized")
COSTS_DIR = os.path.join(DATA_DIR, "costs")
IMPACTS_DIR = os.path.join(COSTS_DIR, "impacts")


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


def cert_expires_during(crew_id, certs, start_dt, end_dt):
    hits = [c for c in certs if c.get("crew_id") == crew_id]
    problems = []
    for c in hits:
        vt = c.get("valid_to")
        if not vt:
            continue
        try:
            vt_dt = datetime.fromisoformat(vt)
        except Exception:
            try:
                vt_dt = datetime.fromisoformat(vt + "T00:00:00")
            except Exception:
                continue
        if vt_dt < start_dt:
            problems.append({"cert_type": c.get("cert_type"), "status": "expired_before_start", "valid_to": vt})
        elif start_dt <= vt_dt <= end_dt:
            problems.append({"cert_type": c.get("cert_type"), "status": "expires_during_pairing", "valid_to": vt})
    return problems


def main():
    ensure_dir(IMPACTS_DIR)

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

    # create lookup maps
    pairing_map = {p.get("pairing_id"): p for p in pairings}
    pairing_legs_map = {}
    for l in pairing_legs:
        pairing_legs_map.setdefault(l.get("pairing_id"), []).append(l.get("flight_id"))
    pairing_crew_map = {}
    for c in pairing_crew:
        pairing_crew_map.setdefault(c.get("crew_id"), []).append({"pairing_id": c.get("pairing_id"), "role": c.get("role")})
    costs_per_pairing_map = {c.get("pairing_id"): c for c in costs_per_pairing}

    # for each crew, compute impacts for each assigned pairing
    for crew in crew_base:
        cid = crew.get("crew_id")
        recs = pairing_crew_map.get(cid, [])
        crew_out = {"crew_id": cid, "pairings": []}
        for r in recs:
            pid = r.get("pairing_id")
            pairing = pairing_map.get(pid)
            legs = pairing_legs_map.get(pid, [])
            num_legs = len(legs)
            pairing_cost = costs_per_pairing_map.get(pid, {})

            # compute simple options
            cancel_per_flight = costs.get("cancellation_per_flight", 0)
            cancellation_option = num_legs * cancel_per_flight

            role_is_pilot = crew_is_pilot(crew.get("rank", ""))
            reserve_cost_key = "reserve_callout_pilot" if role_is_pilot else "reserve_callout_cabin"
            reserve_callout = costs.get(reserve_cost_key, 0)

            # prefer reserves from same base if available
            pairing_base = crew.get("base")
            same_base_reserves = [rp for rp in reserve_pool if rp.get("base") == pairing_base]
            deadhead_positioning = costs.get("deadhead_positioning", 0)
            deadhead_needed = 0 if same_base_reserves else deadhead_positioning
            reserve_option = reserve_callout + deadhead_needed + (pairing_cost.get("hotel_cost_total") or 0)

            deadhead_only = deadhead_positioning + (pairing_cost.get("hotel_cost_total") or 0)

            # cert problems
            start_date = pairing.get("start_date") if pairing else None
            end_date = pairing.get("end_date") if pairing else None
            try:
                start_dt = datetime.fromisoformat(start_date) if start_date else None
            except Exception:
                start_dt = None
            try:
                end_dt = datetime.fromisoformat(end_date) if end_date else None
            except Exception:
                end_dt = None

            cert_problems = []
            if start_dt and end_dt:
                cert_problems = cert_expires_during(cid, certifications, start_dt, end_dt)

            estimates = {
                "cancellation_option_total": cancellation_option,
                "reserve_option_estimate": reserve_option,
                "deadhead_only_estimate": deadhead_only,
            }

            # recommendation simple heuristic
            best = min(estimates.values())
            if best == estimates["reserve_option_estimate"]:
                recommendation = "Use reserve callout (cheapest estimated option)."
            elif best == estimates["deadhead_only_estimate"]:
                recommendation = "Deadhead replacement from other base (cheapest)."
            else:
                recommendation = "Cancellation may be cheapest; consider re-accommodation."

            crew_out["pairings"].append({
                "pairing_id": pid,
                "role": r.get("role"),
                "num_legs": num_legs,
                "baseline_pairing_costs": pairing_cost,
                "estimates": estimates,
                "cert_problems": cert_problems,
                "recommendation": recommendation,
            })

        # write per-crew file
        out_path = os.path.join(IMPACTS_DIR, f"{cid}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(crew_out, f, indent=2)

    print("Wrote per-crew impact JSONs to:", IMPACTS_DIR)


if __name__ == "__main__":
    main()
