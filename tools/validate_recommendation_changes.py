#!/usr/bin/env python3
"""Compare recommended_action counts between original and shuffled consolidated impact files.

Writes `data/costs/impacts_recommendation_diff.json` with overall and per-crew diffs.
Prints a short summary to stdout.
"""
import json
import os
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
COSTS_DIR = os.path.join(DATA_DIR, "costs")
ORIG = os.path.join(COSTS_DIR, "impacts_detailed_consolidated.json")
SHUF = os.path.join(COSTS_DIR, "impacts_detailed_consolidated_shuffled.json")
OUT = os.path.join(COSTS_DIR, "impacts_recommendation_diff.json")


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def tally(data):
    overall = Counter()
    per_crew = defaultdict(Counter)
    for crew in data:
        cid = crew.get("crew_id")
        for p in crew.get("pairings", []):
            for leg in p.get("leg_scenarios", []):
                action = leg.get("recommended_action") or "unknown"
                overall[action] += 1
                per_crew[cid][action] += 1
    return overall, per_crew


def dictify(counter):
    return dict(sorted(counter.items(), key=lambda x: x[0]))


def main():
    if not os.path.exists(ORIG) or not os.path.exists(SHUF):
        print("Required files missing; ensure both original and shuffled consolidated files exist.")
        return
    orig = load(ORIG)
    shuf = load(SHUF)

    orig_overall, orig_per = tally(orig)
    shuf_overall, shuf_per = tally(shuf)

    delta_overall = Counter()
    actions = set(list(orig_overall.keys()) + list(shuf_overall.keys()))
    for a in actions:
        delta_overall[a] = shuf_overall.get(a, 0) - orig_overall.get(a, 0)

    changed_crews = {}
    crews = set(list(orig_per.keys()) + list(shuf_per.keys()))
    for c in crews:
        o = orig_per.get(c, Counter())
        s = shuf_per.get(c, Counter())
        if dict(o) != dict(s):
            changed_crews[c] = {"before": dictify(o), "after": dictify(s)}

    out = {
        "overall_before": dictify(orig_overall),
        "overall_after": dictify(shuf_overall),
        "overall_delta": dictify(delta_overall),
        "changed_crews_count": len(changed_crews),
        "changed_crews": changed_crews,
    }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print("Wrote diff to:", OUT)
    print("Overall before:", dictify(orig_overall))
    print("Overall after:", dictify(shuf_overall))
    print("Changed crews:", len(changed_crews))


if __name__ == '__main__':
    main()
