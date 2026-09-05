#!/usr/bin/env python3
"""Shuffle pairings per crew in the consolidated impacts JSON and recompute cost recommendations.

Produces `data/costs/impacts_detailed_consolidated_shuffled.json`.
"""
import json
import os
import random

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
COSTS_DIR = os.path.join(DATA_DIR, "costs")
IN_PATH = os.path.join(COSTS_DIR, "impacts_detailed_consolidated.json")
OUT_PATH = os.path.join(COSTS_DIR, "impacts_detailed_consolidated_shuffled.json")


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)


def recompute_leg_recommendation(costs):
    # costs: dict with cancel_cost, reserve_total, deadhead_only
    vals = (costs.get("cancel_cost", 10**12), costs.get("reserve_total", 10**12), costs.get("deadhead_only", 10**12))
    labels = ("cancel", "reserve", "deadhead")
    best = min(vals)
    return labels[vals.index(best)]


def main(seed=42):
    random.seed(seed)
    if not os.path.exists(IN_PATH):
        print("Input consolidated file not found:", IN_PATH)
        return
    data = load(IN_PATH)

    # Shuffle pairings per crew and recompute recommended_action from costs
    for crew in data:
        pairings = crew.get("pairings", [])
        random.shuffle(pairings)
        for p in pairings:
            for leg in p.get("leg_scenarios", []):
                leg_costs = leg.get("costs", {})
                leg["recommended_action"] = recompute_leg_recommendation(leg_costs)

    save(OUT_PATH, data)
    print("Wrote shuffled consolidated impacts to:", OUT_PATH)


if __name__ == "__main__":
    main()
