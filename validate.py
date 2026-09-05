#!/usr/bin/env python3
"""
Crew Ops Advisor dataset validator.
Independently re-verifies dataset consistency from the JSON files alone
(no shared code with the generator). Run:  python3 validate.py [data_dir]
"""
import json, sys, os
from datetime import datetime, timedelta, date
from collections import defaultdict

DATA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "data")

def load(name):
    with open(os.path.join(DATA, name)) as fh:
        return json.load(fh)

flights = load("flights.json")
crew = {c["crew_id"]: c for c in load("crew.json")}
rosters = load("rosters.json")
clocks = {c["crew_id"]: c for c in load("duty_clocks.json")}
reserves = load("reserve_pool.json")
certs = load("certifications.json")
rules = load("rules.json")
costsj = load("costs.json")
risks = load("risk_signals.json")
scen = load("scenarios.json")
questions = load("questions.json")

P = lambda s: datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
FBY = {f["flight_id"]: f for f in flights}
FLAGGED = {(x["crew_id"], x["date"]) for x in rosters.get("flagged_exceptions", [])}
errors, warns = [], []
def err(m): errors.append(m)

# ---- 1. flights: schedule continuity per aircraft ----
by_ac = defaultdict(list)
for f in flights:
    by_ac[f["aircraft"]].append(f)
for ac, fs in by_ac.items():
    fs.sort(key=lambda f: f["dep_utc"])
    for a, b in zip(fs, fs[1:]):
        if a["arr_station"] != b["dep_station"]:
            err(f"aircraft {ac}: {a['flight_id']} arrives {a['arr_station']} but {b['flight_id']} departs {b['dep_station']}")
        if P(b["dep_utc"]) < P(a["arr_utc"]):
            err(f"aircraft {ac}: {b['flight_id']} departs before {a['flight_id']} arrives")
    for f in fs:
        blk = (P(f["arr_utc"]) - P(f["dep_utc"])).total_seconds() / 3600
        if abs(blk - f["block_hours"]) > 0.02:
            err(f"{f['flight_id']}: block_hours {f['block_hours']} != computed {round(blk,2)}")

# ---- 2. rosters: coverage, complements, continuity ----
COMP = {"A320": {"Captain": 1, "First Officer": 1, "Senior Cabin Crew": 1, "Cabin Crew": 3},
        "ATR72": {"Captain": 1, "First Officer": 1, "Senior Cabin Crew": 1, "Cabin Crew": 1}}
covered = set()
crew_days = defaultdict(list)  # cid -> [(report, release, pairing, date, duty_h, flight_h)]
for p in rosters["pairings"]:
    roles = defaultdict(int)
    for m in p["crew"]:
        if m["crew_id"] not in crew:
            err(f"{p['pairing_id']}: unknown crew {m['crew_id']}")
        roles[m["role"]] += 1
        if crew[m["crew_id"]]["rank"] != m["role"]:
            err(f"{p['pairing_id']}: {m['crew_id']} role {m['role']} != rank {crew[m['crew_id']]['rank']}")
    for day in p["days"]:
        rep, rel = P(day["report_utc"]), P(day["release_utc"])
        legs = [FBY[fid] for fid in day["flights"]]
        for fid in day["flights"]:
            if fid not in FBY:
                err(f"{p['pairing_id']}: unknown flight {fid}")
            covered.add(fid)
        actype = legs[0]["aircraft_type"]
        if dict(roles) != COMP[actype]:
            err(f"{p['pairing_id']}: complement {dict(roles)} != required {COMP[actype]}")
        legs.sort(key=lambda f: f["dep_utc"])
        # report/release brackets, ground continuity within the day
        if rep > P(legs[0]["dep_utc"]) - timedelta(minutes=59):
            err(f"{p['pairing_id']} {day['date']}: report not >=60min before first dep")
        if rel < P(legs[-1]["arr_utc"]):
            err(f"{p['pairing_id']} {day['date']}: release before last arrival")
        for a, b in zip(legs, legs[1:]):
            if a["arr_station"] != b["dep_station"]:
                err(f"{p['pairing_id']} {day['date']}: leg discontinuity {a['flight_id']}->{b['flight_id']}")
        fh = sum(l["block_hours"] for l in legs)
        dh = (rel - rep).total_seconds() / 3600
        # FDP rule
        lim = 13.0 - 0.5 * max(0, len(legs) - 2)
        if dh > lim + 1e-6:
            err(f"{p['pairing_id']} {day['date']}: FDP {round(dh,2)} > limit {lim}")
        for m in p["crew"]:
            crew_days[m["crew_id"]].append((rep, rel, p["pairing_id"], day["date"], dh, fh))
    # multi-day pairing: crew position continuity across days
    for d1, d2 in zip(p["days"], p["days"][1:]):
        last = FBY[sorted(d1["flights"], key=lambda x: FBY[x]["dep_utc"])[-1]]
        first = FBY[sorted(d2["flights"], key=lambda x: FBY[x]["dep_utc"])[0]]
        if last["arr_station"] != first["dep_station"]:
            err(f"{p['pairing_id']}: overnight discontinuity {last['arr_station']} -> {first['dep_station']}")

uncov = [f["flight_id"] for f in flights if f["flight_id"] not in covered]
if uncov:
    err(f"{len(uncov)} flights with no crew: {uncov[:5]}")

# ---- 3. per-crew: overlaps, rest, ratings, certs ----
CERTMAP = defaultdict(dict)
for c in certs:
    CERTMAP[c["crew_id"]][c["cert_type"]] = date.fromisoformat(c["valid_to"])
for cid, duties in crew_days.items():
    duties.sort()
    for a, b in zip(duties, duties[1:]):
        if b[0] < a[1]:
            err(f"{cid}: overlapping duties {a[2]}/{b[2]}")
        elif (b[0] - a[1]).total_seconds() / 3600 < 12 - 1e-6:
            err(f"{cid}: rest {(b[0]-a[1])} < 12h between {a[2]} and {b[2]}")
    for (rep, rel, pid, dstr, dh, fh) in duties:
        d = date.fromisoformat(dstr)
        actype = None
        for p in rosters["pairings"]:
            if p["pairing_id"] == pid:
                actype = FBY[p["days"][0]["flights"][0]]["aircraft_type"]
        if actype not in crew[cid]["ratings"]:
            err(f"{cid}: not rated {actype} for {pid}")
        bad = [t for t, v in CERTMAP[cid].items() if v < d]
        if bad and (cid, dstr) not in FLAGGED:
            err(f"{cid}: certs {bad} invalid on {dstr} (not flagged)")
        if not bad and (cid, dstr) in FLAGGED:
            err(f"{cid}/{dstr} flagged but certs look valid")

# ---- 4. duty windows: 60h/7d, 100h/28d incl history ----
hist = {}
for cid, c in clocks.items():
    hist[cid] = {date.fromisoformat(x["date"]): (x["duty_hours"], x["flight_hours"]) for x in c["daily_history"]}
    if len(c["daily_history"]) != 28:
        err(f"{cid}: history has {len(c['daily_history'])} days, expected 28")
week = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
for cid, duties in crew_days.items():
    for (rep, rel, pid, dstr, dh, fh) in duties:
        d = date.fromisoformat(dstr)
        week[cid][d][0] += dh
        week[cid][d][1] += fh
def wsum(cid, end, days, k):
    s = 0.0
    start = end - timedelta(days=days - 1)
    for d, v in hist.get(cid, {}).items():
        if start <= d <= end: s += v[k]
    for d, v in week[cid].items():
        if start <= d <= end: s += v[k]
    return s
for cid in crew:
    for d, v in sorted(week[cid].items()):
        if wsum(cid, d, 7, 0) > 60 + 1e-6:
            err(f"{cid}: 60h/7d exceeded on {d} ({round(wsum(cid,d,7,0),2)}h)")
        if wsum(cid, d, 28, 1) > 100 + 1e-6:
            err(f"{cid}: 100h/28d exceeded on {d} ({round(wsum(cid,d,28,1),2)}h)")
    # clock summary fields
    c = clocks[cid]
    d7 = round(sum(v[0] for d, v in hist[cid].items() if date(2026,9,8) <= d <= date(2026,9,14))
               + sum(v[0] for d, v in week[cid].items() if date(2026,9,8) <= d <= date(2026,9,14)), 2)
    if abs(d7 - c["duty_hours_7d"]) > 0.05:
        err(f"{cid}: duty_hours_7d {c['duty_hours_7d']} != recomputed {d7}")

# ---- 5. reserves / status sanity ----
for r in reserves:
    if r["crew_id"] not in crew:
        err(f"reserve {r['crew_id']} unknown")
    elif crew[r["crew_id"]]["status"] != "active":
        err(f"reserve {r['crew_id']} not active")
onleave = [cid for cid, c in crew.items() if c["status"] != "active" and crew_days.get(cid)]
for cid in onleave:
    err(f"{cid} is {crew[cid]['status']} but rostered")

# ---- 6. scenarios / questions referential integrity ----
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("crew_id",) and isinstance(v, str) and v.startswith("C-") and v not in crew:
                err(f"scenario/question references unknown crew {v}")
            if k in ("flight_id",) and isinstance(v, str) and v not in FBY:
                err(f"unknown flight {v}")
            walk(v)
    elif isinstance(o, list):
        for x in o:
            if isinstance(x, str) and x.startswith("DX4") and "-2026-" in x and x not in FBY:
                err(f"unknown flight ref {x}")
            walk(x)
walk(scen); walk(questions)
tiers = defaultdict(int)
for qq in questions: tiers[qq["tier"]] += 1

print(f"flights={len(flights)} crew={len(crew)} pairings={len(rosters['pairings'])} "
      f"reserves={len(reserves)} certs={len(certs)} scenarios={len(scen)} questions={len(questions)} tiers={dict(tiers)}")
if errors:
    print(f"\nFAIL — {len(errors)} error(s):")
    for e in errors[:40]: print(" -", e)
    sys.exit(1)
print("PASS — dataset is internally consistent (schedule continuity, complements, "
      "FDP/duty/flight-hour windows, rest, ratings, certifications, clocks, references).")
