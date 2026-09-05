#!/usr/bin/env python3
"""Assess cost impact when a crew member is dropped or their cert expires for a pairing.

Usage examples:
  py -3 tools\assess_pairing_impact.py --pairing P-2291 --crew C-1042 --scenario dropped
  py -3 tools\assess_pairing_impact.py --pairing P-2291 --crew C-1042 --scenario cert-expiry

The script reads normalized JSONs under `data/normalized` and `data/costs`, plus
`data/costs.json`, `data/reserve_pool.json`, and `data/certifications.json`.
Outputs a JSON with cost estimates for replacement, cancellation, and recommendations.
"""
import argparse
import json
import os
from datetime import datetime
from typing import List

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
NORM_DIR = os.path.join(DATA_DIR, "normalized")
COSTS_DIR = os.path.join(DATA_DIR, "costs")


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def find_pairing(pairing_id, pairings) -> dict:
    for p in pairings:
        if p.get("pairing_id") == pairing_id:
            return p
    return None


def get_pairing_legs(pairing_id, pairing_legs) -> List[str]:
    return [l["flight_id"] for l in pairing_legs if l.get("pairing_id") == pairing_id]


def get_pairing_crew(pairing_id, pairing_crew) -> List[dict]:
    return [c for c in pairing_crew if c.get("pairing_id") == pairing_id]


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
    p = argparse.ArgumentParser()
    p.add_argument("--pairing", required=True)
    p.add_argument("--crew", required=True)
    p.add_argument("--scenario", choices=["dropped", "cert-expiry"], default="dropped")
    args = p.parse_args()

    # Load files
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

    pairing = find_pairing(args.pairing, pairings)
    if not pairing:
        print(json.dumps({"error": f"pairing {args.pairing} not found"}))
        return

    legs = get_pairing_legs(args.pairing, pairing_legs)
    if not legs:
        print(json.dumps({"error": "no legs found for pairing"}))
        return

    # pairing dates (best effort)
    start_date = pairing.get("start_date")
    end_date = pairing.get("end_date")
    try:
        start_dt = datetime.fromisoformat(start_date) if start_date else None
    except Exception:
        start_dt = None
    try:
        end_dt = datetime.fromisoformat(end_date) if end_date else None
    except Exception:
        end_dt = None

    # get crew record
    crew_rec = next((c for c in crew_base if c.get("crew_id") == args.crew), None)
    if not crew_rec:
        print(json.dumps({"error": f"crew {args.crew} not found"}))
        return

    # baseline costs for pairing
    pairing_cost = next((c for c in costs_per_pairing if c.get("pairing_id") == args.pairing), None)
    baseline = pairing_cost or {"total_block_hours": None, "hotel_cost_total": 0, "cancellation_costs_total": 0}

    # compute simple estimates
    num_legs = len(legs)
    cancel_per_flight = costs.get("cancellation_per_flight", 0)
    cancellation_option = num_legs * cancel_per_flight

    # Reserve option (assume one reserve covers whole pairing)
    role_is_pilot = crew_is_pilot(crew_rec.get("rank", ""))
    reserve_cost_key = "reserve_callout_pilot" if role_is_pilot else "reserve_callout_cabin"
    reserve_callout = costs.get(reserve_cost_key, 0)

    # check for a reserve at same base
    pairing_base = crew_rec.get("base") or None
    same_base_reserves = [r for r in reserve_pool if r.get("base") == pairing_base]
    deadhead_positioning = costs.get("deadhead_positioning", 0)
    deadhead_needed = 0 if same_base_reserves else deadhead_positioning

    reserve_option = reserve_callout + deadhead_needed + (baseline.get("hotel_cost_total") or 0)

    # Deadhead-only option: fly in a replacement from another base (one-time deadhead + hotel)
    deadhead_only = deadhead_positioning + (baseline.get("hotel_cost_total") or 0)

    # Cert expiry scenario: compute partial replacement if expiry inside pairing
    cert_problems = []
    if args.scenario == "cert-expiry":
        if start_dt and end_dt:
            cert_problems = cert_expires_during(args.crew, certifications, start_dt, end_dt)
        else:
            # if dates unknown, check any cert that is expired today
            today = datetime.utcnow()
            cert_problems = cert_expires_during(args.crew, certifications, today, today)

    # Build output
    out = {
        "pairing_id": args.pairing,
        "crew_id": args.crew,
        "num_legs": num_legs,
        "baseline_pairing_costs": baseline,
        "estimates": {
            "cancellation_option_total": cancellation_option,
            "reserve_option_estimate": reserve_option,
            "deadhead_only_estimate": deadhead_only,
        },
        "assumptions": {
            "reserve_callout_used": reserve_cost_key,
            "deadhead_positioning": deadhead_positioning,
            "hotel_cost_included": bool(baseline.get("hotel_cost_total")),
        },
        "cert_problems": cert_problems,
        "recommendation": None,
    }

    # simple recommendation logic
    ests = out["estimates"]
    best = min(ests.values())
    if best == ests["reserve_option_estimate"]:
        out["recommendation"] = "Use reserve callout (cheapest estimated option)."
    elif best == ests["deadhead_only_estimate"]:
        out["recommendation"] = "Deadhead replacement from other base (cheapest)."
    else:
        out["recommendation"] = "Cancellation may be cheapest; consider re-accommodation or re-accommodation tradeoffs."

    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
