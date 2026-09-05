#!/usr/bin/env python3
"""Consolidate all detailed per-crew impact JSONs into one file.

Writes `data/costs/impacts_consolidated.json` containing a list of all crew impact objects.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(__file__))
IMPACTS_DIR = os.path.join(ROOT, "data", "costs", "impacts_detailed")
OUT_PATH = os.path.join(ROOT, "data", "costs", "impacts_consolidated.json")


def main():
    items = []
    if not os.path.isdir(IMPACTS_DIR):
        print("No impacts_detailed directory found:", IMPACTS_DIR)
        return
    for fn in sorted(os.listdir(IMPACTS_DIR)):
        if not fn.endswith('.json'):
            continue
        with open(os.path.join(IMPACTS_DIR, fn), 'r', encoding='utf-8') as f:
            try:
                items.append(json.load(f))
            except Exception as e:
                print("Failed to load", fn, e)

    with open(OUT_PATH, 'w', encoding='utf-8') as out:
        json.dump(items, out, indent=2)

    print('Wrote consolidated impacts to:', OUT_PATH)


if __name__ == '__main__':
    main()
