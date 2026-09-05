#!/usr/bin/env python3
"""
Crew Ops Advisor - synthetic dataset generator (dCortex hackathon).
Deterministic: seed=42. All times UTC. Week: 2026-09-14 .. 2026-09-20.
Snapshot (data cut): 2026-09-14T18:00:00Z. Hackathon day: 2026-09-15.
"""
import json, random, os
from datetime import datetime, timedelta, date

random.seed(42)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
INTERNAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "internal")

D0 = date(2026, 9, 14)
DATES = [D0 + timedelta(days=i) for i in range(7)]          # Sep 14..20
HIST_START = date(2026, 8, 18)                               # 28 days before Sep 14 inclusive window handling
SNAPSHOT = "2026-09-14T18:00:00Z"

def dt(d, hm):
    h, m = map(int, hm.split(":"))
    return datetime(d.year, d.month, d.day, h, m)

def iso(x): return x.strftime("%Y-%m-%dT%H:%M:%SZ")
def hrs(td): return round(td.total_seconds() / 3600.0, 2)

STATIONS = {
  "BLR": "Bengaluru", "DEL": "Delhi", "BOM": "Mumbai", "MAA": "Chennai",
  "HYD": "Hyderabad", "CCU": "Kolkata", "COK": "Kochi", "GOI": "Goa",
}
SEATS = {"A320": 162, "ATR72": 72}

# ---------------- flight patterns ----------------
# (flight_no, dep, arr, dep_hm, arr_hm)
PAT = {
  "VT-DXA": {"type": "A320", "days": "all", "legs": [
      ("DX401", "BLR", "DEL", "02:30", "05:15"),
      ("DX402", "DEL", "BLR", "06:00", "08:45"),
      ("DX403", "BLR", "MAA", "09:30", "10:30"),
      ("DX404", "MAA", "BLR", "11:15", "12:15")]},
  "VT-DXB": {"type": "A320", "days": "all", "legs": [
      ("DX421", "BLR", "CCU", "03:00", "05:30"),
      ("DX422", "CCU", "BLR", "06:15", "08:45"),
      ("DX423", "BLR", "HYD", "09:30", "10:45"),
      ("DX424", "HYD", "BLR", "11:30", "12:45")]},
  "VT-DXC1": {"type": "A320", "days": "odd", "legs": [      # day-1 of 2-day pairing (15,17,19)
      ("DX412", "BLR", "BOM", "07:00", "08:45"),
      ("DX413", "BOM", "BLR", "09:30", "11:15"),
      ("DX588", "BLR", "DEL", "12:15", "15:00")]},
  "VT-DXC2": {"type": "A320", "days": "even", "legs": [     # day-2 (14,16,18,20)
      ("DX589", "DEL", "BLR", "05:00", "07:45"),
      ("DX590", "BLR", "CCU", "08:30", "11:00"),
      ("DX591", "CCU", "BLR", "11:45", "14:15")]},
  "VT-DXD": {"type": "A320", "days": "all", "legs": [
      ("DX431", "BLR", "BOM", "03:30", "05:15"),
      ("DX432", "BOM", "BLR", "06:00", "07:45"),
      ("DX433", "BLR", "GOI", "08:30", "09:45"),
      ("DX434", "GOI", "BLR", "10:30", "11:45")]},
  "VT-DXE": {"type": "ATR72", "days": "all", "legs": [
      ("DX451", "BLR", "COK", "04:00", "05:15"),
      ("DX452", "COK", "BLR", "06:00", "07:15"),
      ("DX453", "BLR", "MAA", "08:00", "09:00"),
      ("DX454", "MAA", "BLR", "09:45", "10:45")]},
  "VT-DXF": {"type": "ATR72", "days": "all", "legs": [
      ("DX461", "BLR", "HYD", "05:00", "06:30"),
      ("DX462", "HYD", "BLR", "07:15", "08:45")]},
}
ODD = [date(2026, 9, d) for d in (15, 17, 19)]
EVEN = [date(2026, 9, d) for d in (14, 16, 18, 20)]

flights = []
for tail, p in PAT.items():
    days = DATES if p["days"] == "all" else (ODD if p["days"] == "odd" else EVEN)
    ac = tail if not tail.startswith("VT-DXC") else "VT-DXC"
    for d in days:
        for (no, dep, arr, t1, t2) in p["legs"]:
            flights.append({
                "flight_id": f"{no}-{d.isoformat()}",
                "flight_no": no, "date": d.isoformat(),
                "dep_station": dep, "arr_station": arr,
                "dep_utc": iso(dt(d, t1)), "arr_utc": iso(dt(d, t2)),
                "block_hours": hrs(dt(d, t2) - dt(d, t1)),
                "aircraft": ac, "aircraft_type": p["type"],
                "seats": SEATS[p["type"]],
            })
flights.sort(key=lambda f: (f["date"], f["dep_utc"], f["flight_no"]))

# ---------------- crew ----------------
FIRST = ["Arjun","Priya","Rahul","Sneha","Vikram","Ananya","Karthik","Divya","Rohan","Meera",
         "Aditya","Kavya","Suresh","Lakshmi","Nikhil","Pooja","Manoj","Ritika","Sanjay","Isha",
         "Varun","Neha","Deepak","Shruti","Amit","Tanvi","Rajesh","Anjali","Kiran","Swathi",
         "Harish","Nandini","Gaurav","Preethi","Sameer","Aishwarya","Vinay","Sonal","Prakash","Ramya"]
LAST = ["Nair","Sharma","Iyer","Reddy","Menon","Kapoor","Rao","Pillai","Verma","Krishnan",
        "Gupta","Das","Shetty","Bose","Malhotra","Naidu","Joshi","Sen","Kulkarni","Chandra"]

used_ids, used_names = set(), set()
def new_id():
    while True:
        i = f"C-{random.randint(1000, 5999)}"
        if i not in used_ids:
            used_ids.add(i); return i
def new_name():
    while True:
        n = f"{random.choice(FIRST)[0]}. {random.choice(LAST)}"
        if n not in used_names:
            used_names.add(n); return n

crew = {}
def add_crew(cid, rank, base, ratings, name=None, reach=None, status="active"):
    if cid is None: cid = new_id()
    used_ids.add(cid)
    crew[cid] = {
        "crew_id": cid, "name": name or new_name(), "rank": rank, "base": base,
        "ratings": ratings, "seniority": random.randint(2, 22),
        "reachability_minutes": reach if reach is not None else random.choice([45, 60, 75, 90]),
        "status": status,
    }
    return cid

COMP = {"A320": ["Captain", "First Officer", "Senior Cabin Crew", "Cabin Crew", "Cabin Crew", "Cabin Crew"],
        "ATR72": ["Captain", "First Officer", "Senior Cabin Crew", "Cabin Crew"]}

# --- engineered crew (must match the problem-statement doc) ---
add_crew("C-1042", "Captain", "BLR", ["A320"], name="A. Nair", reach=90)          # flagship sick captain
add_crew("C-2087", "Captain", "BLR", ["A320"], name="R. Iyer", reach=60)          # duty-limit trap
add_crew("C-2210", "Captain", "DEL", ["A320"], name="S. Kapoor", reach=60)        # DEL deadhead reserve
add_crew("C-3305", "Captain", "BLR", ["A320"], name="V. Menon", reach=45)         # early-window reserve
add_crew("C-3310", "Captain", "BLR", ["A320"], name="D. Reddy", reach=45)         # main reserve
add_crew("C-3311", "First Officer", "BLR", ["A320"], name="K. Rao", reach=45)
add_crew("C-3312", "First Officer", "BLR", ["A320"], name="P. Sharma", reach=60)
add_crew("C-3315", "Captain", "BLR", ["ATR72"], name="M. Pillai", reach=45)
add_crew("C-3316", "First Officer", "BLR", ["ATR72"], name="N. Verma", reach=45)
add_crew("C-2091", "Captain", "BLR", ["ATR72"], name="H. Naidu", reach=75)        # ATR-only unassigned (QUAL-05 teaching case)

# --- line crew sets ---
# lines with single-day duties rotate 3 sets: set s works dates where (day-14)%3==s
line_sets = {}   # (line, set_idx) -> [crew_ids by role]
def build_set(actype, base="BLR"):
    return [add_crew(None, r, base, [actype]) for r in COMP[actype]]

SINGLE_LINES = {"VT-DXA": "A320", "VT-DXB": "A320", "VT-DXD": "A320", "VT-DXE": "ATR72", "VT-DXF": "ATR72"}
for line, t in SINGLE_LINES.items():
    for s in range(3):
        line_sets[(line, s)] = build_set(t)

# DXC 2-day pairing crews: c0 (day-2 only, 14th; pairing started 13th), c1=(15,16) incl C-1042, c2=(17,18), c3=(19,20)
dxc_crews = []
for i in range(4):
    if i == 1:
        members = ["C-1042"] + [add_crew(None, r, "BLR", ["A320"]) for r in COMP["A320"][1:]]
    else:
        members = build_set("A320")
    dxc_crews.append(members)

# --- reserve pool (window = callout must fall inside; active all 7 dates) ---
reserve_defs = [
    ("C-3305", "00:00", "05:30"), ("C-3310", "06:00", "18:00"),
    ("C-3311", "06:00", "18:00"), ("C-3312", "00:00", "12:00"),
    ("C-3315", "03:00", "15:00"), ("C-3316", "03:00", "15:00"),
    ("C-2210", "03:00", "15:00"),
]
for _ in range(2):
    reserve_defs.append((add_crew(None, "Senior Cabin Crew", "BLR", ["A320", "ATR72"]), "04:00", "16:00"))
cc_windows = [("04:00","16:00"),("04:00","16:00"),("04:00","16:00"),("00:00","12:00")]
for w in cc_windows:
    reserve_defs.append((add_crew(None, "Cabin Crew", "BLR", ["A320", "ATR72"]), w[0], w[1]))
reserve_defs.append((add_crew(None, "First Officer", "DEL", ["A320"]), "03:00", "15:00"))
reserve_defs.append((add_crew(None, "Senior Cabin Crew", "DEL", ["A320"]), "03:00", "15:00"))
reserve_defs.append((add_crew(None, "Cabin Crew", "DEL", ["A320"]), "03:00", "15:00"))

reserve_pool = [{"crew_id": cid, "base": crew[cid]["base"],
                 "dates": [d.isoformat() for d in DATES],
                 "oncall_window_utc": {"start": w1, "end": w2},
                 "note": "Callout time must fall inside the on-call window (RULE-BASE-07 applies for base)."}
                for (cid, w1, w2) in reserve_defs]
RESERVE_IDS = {r["crew_id"] for r in reserve_pool}

# --- unassigned pool (leave / training / office / spare) ---
unassigned = ["C-2087", "C-2091"]
for _ in range(3):  # spare A320 captains on planned leave this week
    unassigned.append(add_crew(None, "Captain", "BLR", ["A320"], status="leave"))
for _ in range(6):
    unassigned.append(add_crew(None, "First Officer", random.choice(["BLR", "BLR", "DEL"]), ["A320"], status=random.choice(["active", "active", "training"])))
for _ in range(4):
    unassigned.append(add_crew(None, "Senior Cabin Crew", "BLR", ["A320", "ATR72"], status="active"))
while len(crew) < 150:
    unassigned.append(add_crew(None, "Cabin Crew", random.choice(["BLR", "BLR", "BLR", "DEL"]), ["A320", "ATR72"],
                               status=random.choice(["active", "active", "active", "leave"])))

# ---------------- rosters (pairings) ----------------
pairings = []
pid_counter = 2200
def report_release(d, legs):
    rep = dt(d, legs[0][3]) - timedelta(minutes=60)
    rel = dt(d, legs[-1][4]) + timedelta(minutes=30)
    return rep, rel

def add_pairing(pid, aircraft, days, members):
    pairings.append({
        "pairing_id": pid, "aircraft": aircraft,
        "days": days,
        "crew": [{"crew_id": m, "role": crew[m]["rank"]} for m in members],
    })

for line in SINGLE_LINES:
    legs = PAT[line]["legs"]
    for d in DATES:
        s = (d.day - 14) % 3
        rep, rel = report_release(d, legs)
        pid_counter += 1
        add_pairing(f"P-{pid_counter}", line, [{
            "date": d.isoformat(),
            "flights": [f"{no}-{d.isoformat()}" for (no, *_ ) in legs],
            "report_utc": iso(rep), "release_utc": iso(rel),
        }], line_sets[(line, s)])

# DXC pairings
def dxc_day(d, which):
    legs = PAT["VT-DXC1" if which == 1 else "VT-DXC2"]["legs"]
    rep, rel = report_release(d, legs)
    return {"date": d.isoformat(),
            "flights": [f"{no}-{d.isoformat()}" for (no, *_ ) in legs],
            "report_utc": iso(rep), "release_utc": iso(rel)}

add_pairing("P-2289", "VT-DXC", [dxc_day(date(2026, 9, 14), 2)], dxc_crews[0])           # tail of pairing started 13 Sep
add_pairing("P-2291", "VT-DXC", [dxc_day(date(2026, 9, 15), 1), dxc_day(date(2026, 9, 16), 2)], dxc_crews[1])
add_pairing("P-2293", "VT-DXC", [dxc_day(date(2026, 9, 17), 1), dxc_day(date(2026, 9, 18), 2)], dxc_crews[2])
add_pairing("P-2295", "VT-DXC", [dxc_day(date(2026, 9, 19), 1), dxc_day(date(2026, 9, 20), 2)], dxc_crews[3])

# per-crew current-week duty index: crew_id -> list of (date, report_dt, release_dt, duty_h, flight_h, pairing_id)
week_duties = {cid: [] for cid in crew}
for p in pairings:
    for day in p["days"]:
        d = date.fromisoformat(day["date"])
        rep = datetime.strptime(day["report_utc"], "%Y-%m-%dT%H:%M:%SZ")
        rel = datetime.strptime(day["release_utc"], "%Y-%m-%dT%H:%M:%SZ")
        fh = sum(f["block_hours"] for f in flights if f["flight_id"] in day["flights"])
        for m in p["crew"]:
            week_duties[m["crew_id"]].append((d, rep, rel, hrs(rel - rep), round(fh, 2), p["pairing_id"]))
for v in week_duties.values():
    v.sort(key=lambda x: x[0])

# ---------------- duty history (Aug 18 - Sep 14) ----------------
HDAYS = [HIST_START + timedelta(days=i) for i in range((D0 - HIST_START).days + 1)]  # 28 entries incl Sep 14

ENGINEERED_HIST = {
    # C-2087: window Sep 9..15 must sum 51.83 so +9.5h duty on the 15th exceeds 60 by 1h20m
    "C-2087": {date(2026,9,9): (11.0, 7.7), date(2026,9,10): (10.5, 7.4), date(2026,9,11): (8.0, 0.0),
               date(2026,9,12): (12.0, 8.4), date(2026,9,13): (6.0, 0.0), date(2026,9,14): (4.33, 0.0)},
    # C-3305: legal for P-2291 day 1 (win 9..15 = 59.5+? see notes) but breaches on day 2
    "C-3305": {date(2026,9,9): (2.0, 0.0), date(2026,9,10): (11.0, 7.7), date(2026,9,11): (11.0, 7.7),
               date(2026,9,12): (10.0, 7.0), date(2026,9,13): (9.0, 6.3), date(2026,9,14): (7.0, 4.9)},
}

def gen_history(cid):
    c = crew[cid]
    hist = {}
    if cid in ENGINEERED_HIST:
        for d in HDAYS:
            hist[d] = ENGINEERED_HIST[cid].get(d, (0.0, 0.0))
        # light background before Sep 9 for realism, kept small
        for d in HDAYS:
            if d < date(2026, 9, 9) and random.random() < 0.30:
                hist[d] = (round(random.uniform(4, 7), 2), 0.0)
        return hist
    if cid in RESERVE_IDS:
        for d in HDAYS:
            if random.random() < 0.15:
                dh = round(random.uniform(5, 9), 2); hist[d] = (dh, round(dh * 0.7, 2))
            else:
                hist[d] = (0.0, 0.0)
        return hist
    # line crew: same every-3rd-day cadence backward; unassigned: light duties
    on_line = any(cid in members for members in list(line_sets.values()) + dxc_crews)
    for d in HDAYS:
        if on_line and (d.toordinal() % 3 == hash(cid) % 3) and random.random() < 0.9:
            dh = round(random.uniform(8.0, 11.0), 2); hist[d] = (dh, round(dh * 0.72, 2))
        elif not on_line and random.random() < 0.25:
            dh = round(random.uniform(3.5, 6.5), 2); hist[d] = (dh, 0.0)
        else:
            hist[d] = (0.0, 0.0)
    return hist

history = {cid: gen_history(cid) for cid in crew}

def win_sum(cid, end_d, days, include_week=True, kind=0):
    """sum duty(0)/flight(1) hours over calendar window of `days` days ending end_d inclusive.
    Uses history for dates <= Sep 14 and current-week planned duties after."""
    start = end_d - timedelta(days=days - 1)
    tot = 0.0
    for d, v in history[cid].items():
        if start <= d <= end_d:
            tot += v[kind]
    if include_week:
        for (dd, rep, rel, dh, fh, pid) in week_duties[cid]:
            if start <= dd <= end_d:
                tot += dh if kind == 0 else fh
    return round(tot, 2)

# sanity guard: keep everyone legal across the planned week (60h/7d, 100h/28d)
for cid in crew:
    for (dd, rep, rel, dh, fh, pid) in week_duties[cid]:
        d7 = win_sum(cid, dd, 7); d28 = win_sum(cid, dd, 28, kind=1)
        assert d7 <= 60.001, f"{cid} 7d breach {d7} on {dd}"
        assert d28 <= 100.001, f"{cid} 28d breach {d28} on {dd}"

duty_clocks = []
for cid, c in crew.items():
    hist_sorted = sorted(history[cid].items())
    last_duty_end = None
    for (dd, rep, rel, dh, fh, pid) in week_duties[cid]:
        if dd <= D0:
            last_duty_end = rel
    if last_duty_end is None:
        past = [d for d, v in hist_sorted if v[0] > 0]
        if past:
            last_duty_end = dt(past[-1], "14:00")
    duty_clocks.append({
        "crew_id": cid,
        "as_of_utc": SNAPSHOT,
        "duty_hours_7d": win_sum(cid, D0, 7),
        "flight_hours_28d": win_sum(cid, D0, 28, kind=1),
        "last_rest_ended": iso(last_duty_end + timedelta(hours=12)) if last_duty_end else None,
        "daily_history": [{"date": d.isoformat(), "duty_hours": v[0], "flight_hours": v[1]}
                          for d, v in hist_sorted],
    })

print("flights", len(flights), "crew", len(crew), "pairings", len(pairings))
# ============ PART 2 (appended to gen1.py) ============

# ---------------- certifications ----------------
CERT_TYPES = [("licence", 900, 2000), ("medical_class1", 200, 500),
              ("recurrent_training", 90, 360), ("dangerous_goods", 120, 700)]
certifications = []
cert_expiring_soon = []
SCEN5_CC = dxc = None
# scenario-5 target: a cabin crew on VT-DXB set-2 (works 16,19): recurrent expires Sep 17
scen5_cc = [m for m in line_sets[("VT-DXB", 2)] if crew[m]["rank"] == "Cabin Crew"][0]

for cid in crew:
    for (ct, lo, hi) in CERT_TYPES:
        exp = D0 + timedelta(days=random.randint(lo, hi))
        certifications.append({"crew_id": cid, "cert_type": ct, "valid_from": (exp - timedelta(days=730)).isoformat(),
                               "valid_to": exp.isoformat()})
# engineered expiries
def set_cert(cid, ct, valid_to):
    for c in certifications:
        if c["crew_id"] == cid and c["cert_type"] == ct:
            c["valid_to"] = valid_to.isoformat(); return
set_cert(scen5_cc, "recurrent_training", date(2026, 9, 17))
# a handful expiring within 30 days for the Tier-1 question (crew NOT rostered on days after expiry)
soon_pool = [cid for cid in unassigned if crew[cid]["status"] == "active"][:5]
for i, cid in enumerate(soon_pool):
    set_cert(cid, ["licence", "medical_class1", "dangerous_goods", "recurrent_training", "medical_class1"][i],
             date(2026, 9, 18) + timedelta(days=i * 5))
CERT = {}
for c in certifications:
    CERT.setdefault(c["crew_id"], {})[c["cert_type"]] = date.fromisoformat(c["valid_to"])

def certs_ok(cid, on_date):
    return all(v >= on_date for v in CERT[cid].values())
# guard: everyone rostered must be cert-valid on their duty dates, except scen5 target on 19th (that's the scenario, not the base roster)
for cid, duties in week_duties.items():
    for (dd, *_ ) in duties:
        if cid == scen5_cc and dd == date(2026, 9, 19):
            continue
        if not certs_ok(cid, dd):
            for c in certifications:
                if c["crew_id"] == cid and date.fromisoformat(c["valid_to"]) < dd:
                    c["valid_to"] = (dd + timedelta(days=random.randint(60, 300))).isoformat()
            CERT[cid] = {c["cert_type"]: date.fromisoformat(c["valid_to"]) for c in certifications if c["crew_id"] == cid}
# scen5_cc IS rostered on the 19th with an expired cert -> this is the one flagged exception
FLAGGED = [{"crew_id": scen5_cc, "date": "2026-09-19", "rule": "RULE-CERT-06",
            "note": "recurrent_training expires 2026-09-17; assignment on 2026-09-19 is illegal and must be resolved (see scenario S5)."}]

# ---------------- rules / costs ----------------
rules = {
  "time_convention": "All times UTC. Duty windows use calendar days (UTC dates), inclusive of the duty date.",
  "definitions": {
    "duty_period": "report_utc to release_utc. Report = first departure minus 60 min; release = last arrival plus 30 min.",
    "fdp": "Flight Duty Period = duty period length in hours.",
    "sector": "One flight leg.",
    "reserve_callout": "A reserve may be called out only if the callout time falls inside their on-call window. Once assigned, they operate as line crew (window no longer applies).",
  },
  "rules": [
    {"rule_id": "RULE-FDP-01", "text": "Max flight duty period 13h, reduced 0.5h per sector beyond the 2nd.",
     "params": {"base_fdp_hours": 13.0, "reduction_per_extra_sector_hours": 0.5, "free_sectors": 2}},
    {"rule_id": "RULE-DUTY-02", "text": "Max 60 duty hours in any 7 consecutive calendar days (inclusive of duty date).",
     "params": {"max_duty_hours": 60, "window_days": 7}},
    {"rule_id": "RULE-FLT-03", "text": "Max 100 flight (block) hours in any 28 consecutive calendar days.",
     "params": {"max_flight_hours": 100, "window_days": 28}},
    {"rule_id": "RULE-REST-04", "text": "Min 12h rest between release and next report.",
     "params": {"min_rest_hours": 12}},
    {"rule_id": "RULE-QUAL-05", "text": "Crew must hold a valid rating for the assigned aircraft type."},
    {"rule_id": "RULE-CERT-06", "text": "All certifications must be valid on the duty date."},
    {"rule_id": "RULE-BASE-07", "text": "Reserve callout from own base only; covering from another base requires deadhead positioning (cost applies)."},
  ],
}
costs = {
  "currency": "INR",
  "reserve_callout_pilot": 18500, "reserve_callout_cabin": 9500,
  "dayoff_callout_pilot": 24000, "dayoff_callout_cabin": 12500,
  "deadhead_positioning": 6500,
  "delay_cost_per_duty_hour": 5400,
  "cancellation_per_flight": 250000,
  "hotel_overnight": 4200,
  "notes": "delay_cost_per_duty_hour is charged per hour the duty's first departure is delayed. Cancellation is per flight leg.",
}

# ---------------- risk signals ----------------
risk_signals = []
HIGH = {"C-1042": (0.78, ["short-rest pattern over last 14 days", "two fatigue reports this month"]),
        line_sets[("VT-DXA", 1)][0]: (0.71, ["elevated sick-call likelihood: cluster pattern at base"]),
        line_sets[("VT-DXB", 1)][0]: (0.69, ["elevated sick-call likelihood: cluster pattern at base"]),
        scen5_cc: (0.64, ["certification lapse risk: recurrent_training expiring"])}
for cid in crew:
    if cid in HIGH:
        sc, reasons = HIGH[cid]
    else:
        sc = round(min(0.55, max(0.02, random.gauss(0.15, 0.1))), 2)
        reasons = ["baseline"] if sc < 0.35 else ["moderate recent duty load"]
    risk_signals.append({"crew_id": cid, "as_of_utc": SNAPSHOT, "disruption_risk_score": sc, "drivers": reasons})

# ---------------- resolver ----------------
FBY = {f["flight_id"]: f for f in flights}
def pairing_by_id(pid): return next(p for p in pairings if p["pairing_id"] == pid)
def duty_len(day): 
    rep = datetime.strptime(day["report_utc"], "%Y-%m-%dT%H:%M:%SZ")
    rel = datetime.strptime(day["release_utc"], "%Y-%m-%dT%H:%M:%SZ")
    return hrs(rel - rep), rep, rel

def fdp_limit(n_sectors): return 13.0 - 0.5 * max(0, n_sectors - 2)

def check_cover(cid, pdays, exclude_pairing=None, delay_h=0.0):
    """Can cid legally cover the given pairing days (list of day dicts)? Returns (ok, reasons[])."""
    c = crew[cid]; issues = []
    actype = FBY[pdays[0]["flights"][0]]["aircraft_type"]
    if actype not in c["ratings"]:
        return False, [f"RULE-QUAL-05: no {actype} rating"]
    # simulate: their existing week duties minus excluded pairing, plus the new days
    own = [wd for wd in week_duties[cid] if wd[5] != exclude_pairing]
    sim = list(own)
    for day in pdays:
        dl, rep, rel = duty_len(day)
        rep = rep + timedelta(hours=delay_h); rel = rel + timedelta(hours=delay_h)
        d = date.fromisoformat(day["date"])
        if not certs_ok(cid, d):
            issues.append(f"RULE-CERT-06: certification invalid on {d}")
        nsec = len(day["flights"])
        if hrs(rel - rep) > fdp_limit(nsec) + 1e-6:
            issues.append(f"RULE-FDP-01: FDP {hrs(rel-rep)}h > {fdp_limit(nsec)}h limit ({nsec} sectors)")
        sim.append((d, rep, rel, hrs(rel - rep), 0.0, "COVER"))
    sim.sort(key=lambda x: x[1])
    for a, b in zip(sim, sim[1:]):
        rest = hrs(b[1] - a[2])
        if rest < 12 - 1e-6:
            tag = "downstream" if b[5] != "COVER" and a[5] == "COVER" else "rest"
            issues.append(f"RULE-REST-04: only {rest}h rest before {b[5]} on {b[0]} ({tag} conflict)")
    # overlap check
    for a, b in zip(sim, sim[1:]):
        if b[1] < a[2]:
            issues.append(f"double-booked: {a[5]} overlaps {b[5]} on {b[0]}")
    # duty/flight windows for each simulated new day
    for day in pdays:
        d = date.fromisoformat(day["date"]); dl, _, _ = duty_len(day)
        base7 = win_sum(cid, d, 7)  # includes own week duties incl excluded? win_sum uses week_duties full
        # subtract excluded pairing duties in window, add cover days up to d
        for wd in week_duties[cid]:
            if wd[5] == exclude_pairing and d - timedelta(days=6) <= wd[0] <= d:
                base7 -= wd[3]
        add = sum(duty_len(x)[0] for x in pdays if date.fromisoformat(x["date"]) <= d)
        tot7 = round(base7 + add, 2)
        if tot7 > 60 + 1e-6:
            excess = tot7 - 60
            hh = int(excess); mm = int(round((excess - hh) * 60))
            issues.append(f"RULE-DUTY-02: would exceed 60h/7d by {hh}h{mm:02d}m on {d} (total {tot7}h)")
    ok = not issues
    return ok, issues

def cover_options(pdays, role, sick_cid, exclude_pairing, callout_dt):
    """Enumerate candidates to cover pairing days for a role; return ranked options + excluded."""
    options, excluded = [], []
    base_needed = FBY[pdays[0]["flights"][0]]["dep_station"]
    pilot = role in ("Captain", "First Officer")
    for cid, c in crew.items():
        if cid == sick_cid or c["rank"] != role or c["status"] != "active":
            continue
        is_res = cid in RESERVE_IDS
        deadhead = c["base"] != base_needed
        delay_h = 0.0
        if deadhead:
            if c["base"] == "DEL" and base_needed == "BLR":
                # position on DX402 (arr 08:45Z) or DX589 (even days, arr 07:45Z);
                # new report = positioning arrival + 15 min transit; new dep = report + 60 min
                d = date.fromisoformat(pdays[0]["date"])
                arr = dt(d, "07:45") if d in EVEN else dt(d, "08:45")
                dep0 = datetime.strptime(FBY[pdays[0]["flights"][0]]["dep_utc"], "%Y-%m-%dT%H:%M:%SZ")
                delay_h = round(max(0.0, hrs((arr + timedelta(minutes=75)) - dep0)), 2)
            else:
                excluded.append({"crew_id": cid, "reason": "RULE-BASE-07: no same-day positioning flight from base"})
                continue
        # reserve window check: the required report time must fall inside the on-call window
        if is_res:
            r = next(x for x in reserve_pool if x["crew_id"] == cid)
            rep_req = datetime.strptime(pdays[0]["report_utc"], "%Y-%m-%dT%H:%M:%SZ") + timedelta(hours=delay_h)
            ws = dt(rep_req.date(), r["oncall_window_utc"]["start"])
            we = dt(rep_req.date(), r["oncall_window_utc"]["end"])
            if not (ws <= rep_req <= we):
                excluded.append({"crew_id": cid, "reason": f"reserve on-call window {r['oncall_window_utc']['start']}-{r['oncall_window_utc']['end']}Z does not cover required report {rep_req.strftime('%H:%M')}Z"})
                continue
        ok, issues = check_cover(cid, pdays, exclude_pairing=exclude_pairing, delay_h=delay_h)
        if not ok:
            excluded.append({"crew_id": cid, "reason": "; ".join(issues)})
            continue
        cost = 0
        if is_res:
            cost += costs["reserve_callout_pilot"] if pilot else costs["reserve_callout_cabin"]
        else:
            cost += costs["dayoff_callout_pilot"] if pilot else costs["dayoff_callout_cabin"]
        label = "reserve callout" if is_res else "day-off callout"
        if deadhead:
            cost += costs["deadhead_positioning"] + round(delay_h * costs["delay_cost_per_duty_hour"])
            label += f" + deadhead from {c['base']} (first departure delayed ~{delay_h}h)"
        options.append({"action": f"Assign {c['rank']} {cid} ({label})", "crew_id": cid,
                        "legal": True, "rules_checked": ["RULE-FDP-01", "RULE-DUTY-02", "RULE-FLT-03", "RULE-REST-04", "RULE-QUAL-05", "RULE-CERT-06", "RULE-BASE-07"],
                        "cost_inr": int(round(cost)), "delay_hours": delay_h})
    options.sort(key=lambda o: (o["cost_inr"], o["crew_id"]))
    cancel_cost = costs["cancellation_per_flight"] * sum(len(d["flights"]) for d in pdays)
    options.append({"action": f"Cancel all {sum(len(d['flights']) for d in pdays)} flights of the pairing", "crew_id": None,
                    "legal": True, "rules_checked": [], "cost_inr": cancel_cost, "delay_hours": 0.0})
    for i, o in enumerate(options): o["rank"] = i + 1
    return options, excluded
# ============ PART 3 (appended) ============

# ---------------- scenarios ----------------
scenarios = []

# --- S1 (easy): ATR captain sick, clean reserve cover ---
p_dxe_16 = next(p for p in pairings if p["aircraft"] == "VT-DXE" and p["days"][0]["date"] == "2026-09-16")
s1_sick = next(m["crew_id"] for m in p_dxe_16["crew"] if m["role"] == "Captain")
s1_call = datetime(2026, 9, 16, 1, 30)
opts1, exc1 = cover_options(p_dxe_16["days"], "Captain", s1_sick, p_dxe_16["pairing_id"], s1_call)
scenarios.append({
  "scenario_id": "S1", "difficulty": "easy", "title": "ATR captain sick call",
  "event": {"type": "SICK_CREW", "crew_id": s1_sick, "pairing_id": p_dxe_16["pairing_id"],
            "reported_utc": iso(s1_call),
            "narrative": f"Captain {s1_sick} calls in sick at 01:30Z on 16 Sep for pairing {p_dxe_16['pairing_id']} (VT-DXE, 4 legs)."},
  "answer_key": {"uncovered_flights": p_dxe_16["days"][0]["flights"],
                 "options": opts1, "excluded_candidates": exc1,
                 "expected_choice": opts1[0]}})

# --- S2 (flagship): C-1042 sick for 2-day pairing P-2291 ---
p2291 = pairing_by_id("P-2291")
s2_call = datetime(2026, 9, 15, 5, 0)
opts2, exc2 = cover_options(p2291["days"], "Captain", "C-1042", "P-2291", s2_call)
day1_flights = p2291["days"][0]["flights"]
pax = sum(FBY[f]["seats"] for f in day1_flights)
scenarios.append({
  "scenario_id": "S2", "difficulty": "medium", "title": "Flagship: Captain C-1042 sick — 2-day pairing",
  "event": {"type": "SICK_CREW", "crew_id": "C-1042", "pairing_id": "P-2291",
            "reported_utc": iso(s2_call),
            "narrative": "Captain C-1042 calls in sick at 05:00Z on 15 Sep for his 2-day pairing P-2291 (day 1: DX412/DX413/DX588; day 2: DX589/DX590/DX591). The cover must take the full remaining pairing (the aircraft overnights at DEL)."},
  "answer_key": {"uncovered_flights_day1": day1_flights,
                 "uncovered_flights_day2": p2291["days"][1]["flights"],
                 "passengers_at_risk_day1": pax,
                 "options": opts2, "excluded_candidates": exc2,
                 "expected_choice": opts2[0]}})

# --- S3 (medium): BLR closed 08:00-14:00 on 17 Sep ---
w_start, w_end = datetime(2026, 9, 17, 8, 0), datetime(2026, 9, 17, 14, 0)
affected = []
for f in flights:
    if f["date"] != "2026-09-17":
        continue
    depd = datetime.strptime(f["dep_utc"], "%Y-%m-%dT%H:%M:%SZ")
    arrd = datetime.strptime(f["arr_utc"], "%Y-%m-%dT%H:%M:%SZ")
    hit = (f["dep_station"] == "BLR" and w_start <= depd < w_end) or \
          (f["arr_station"] == "BLR" and w_start <= arrd < w_end)
    if hit:
        affected.append(f["flight_id"])
# per-flight action: delay to reopen +30min; recheck crew FDP for shifted duty end
per_flight = []
for fid in affected:
    f = FBY[fid]
    p = next(p for p in pairings for day in p["days"] if fid in day["flights"])
    day = next(day for day in p["days"] if fid in day["flights"])
    dl, rep, rel = duty_len(day)
    # shift: delay this and subsequent legs so the affected op happens at/after 14:30
    depd = datetime.strptime(f["dep_utc"], "%Y-%m-%dT%H:%M:%SZ")
    arrd = datetime.strptime(f["arr_utc"], "%Y-%m-%dT%H:%M:%SZ")
    anchor = depd if f["dep_station"] == "BLR" and w_start <= depd < w_end else arrd
    shift = hrs((w_end + timedelta(minutes=30)) - anchor)
    new_rel = rel + timedelta(hours=shift)
    new_fdp = hrs(new_rel - rep)
    lim = fdp_limit(len(day["flights"]))
    feasible = new_fdp <= lim
    per_flight.append({"flight_id": fid, "pairing_id": p["pairing_id"],
                       "min_delay_hours": round(shift, 2),
                       "crew_fdp_after_delay": round(new_fdp, 2), "fdp_limit": lim,
                       "action": "delay (crew legal)" if feasible else "delay exceeds crew FDP — re-crew tail legs from reserves or cancel"})
scenarios.append({
  "scenario_id": "S3", "difficulty": "medium", "title": "BLR station closure 08:00–14:00Z, 17 Sep",
  "event": {"type": "STATION_CLOSURE", "station": "BLR",
            "window_utc": {"start": iso(w_start), "end": iso(w_end)},
            "narrative": "BLR is closed to all departures and arrivals 08:00–14:00Z on 17 Sep (fuel-farm incident). Flights airborne may not land at BLR in the window."},
  "answer_key": {"affected_flights": affected, "per_flight_assessment": per_flight,
                 "note": "Delays are measured to reopen +30min turnaround. Where the extended duty exceeds RULE-FDP-01, tail legs need reserve re-crew or cancellation."}})

# --- S4 (medium-hard): 90-min tech delay on VT-DXA, 16 Sep -> FDP breach ---
p_dxa_16 = next(p for p in pairings if p["aircraft"] == "VT-DXA" and p["days"][0]["date"] == "2026-09-16")
day = p_dxa_16["days"][0]
dl, rep, rel = duty_len(day)
new_fdp = round(dl + 1.5, 2)
lim = fdp_limit(4)
# option A: original crew flies first 3 legs (recompute), reserve set takes DX404
rel3 = dt(date(2026, 9, 16), "10:30") + timedelta(hours=1.5) + timedelta(minutes=30)  # arr DX403 12:00 + 30
fdp3 = hrs(rel3 - (rep + timedelta(hours=1.5)))
res_cost = 2 * costs["reserve_callout_pilot"] + 4 * costs["reserve_callout_cabin"]
optA = {"rank": 1, "action": "Original crew operates DX401–DX403 (delayed); full reserve set (CPT, FO, SCC, 3 CC) operates DX404",
        "legal": True, "cost_inr": res_cost,
        "reasoning": f"Delayed 3-leg duty FDP {round(fdp3,2)}h vs {fdp_limit(3)}h limit — legal. Reserve set covers the last sector (callout window and 12h-rest all satisfied)."}
optB = {"rank": 2, "action": "Cancel DX404", "legal": True, "cost_inr": costs["cancellation_per_flight"],
        "reasoning": "Legal but ~3.3x more expensive than re-crewing one leg; 162 passengers stranded."}
scenarios.append({
  "scenario_id": "S4", "difficulty": "medium-hard", "title": "Tech delay cascades into an FDP breach",
  "event": {"type": "DELAY", "aircraft": "VT-DXA", "date": "2026-09-16", "delay_hours": 1.5,
            "narrative": "VT-DXA has a 90-minute technical delay before DX401 on 16 Sep. All four legs shift by 90 minutes."},
  "answer_key": {"fdp_after_delay": new_fdp, "fdp_limit": lim,
                 "breach": new_fdp > lim,
                 "breach_detail": f"RULE-FDP-01: delayed duty runs {new_fdp}h vs {lim}h limit (4 sectors) — the rostered crew cannot legally complete DX404.",
                 "options": [optA, optB], "expected_choice": optA}})

# --- S5 (medium): certification expiry grounds a cabin crew ---
p_dxb_19 = next(p for p in pairings if p["aircraft"] == "VT-DXB" and p["days"][0]["date"] == "2026-09-19")
s5_call = datetime(2026, 9, 18, 10, 0)
opts5, exc5 = cover_options(p_dxb_19["days"], "Cabin Crew", scen5_cc, p_dxb_19["pairing_id"], s5_call)
scenarios.append({
  "scenario_id": "S5", "difficulty": "medium", "title": "Certification lapse discovered pre-flight",
  "event": {"type": "CERT_EXPIRY", "crew_id": scen5_cc, "pairing_id": p_dxb_19["pairing_id"],
            "reported_utc": iso(s5_call),
            "narrative": f"Compliance flags at 10:00Z on 18 Sep that {scen5_cc}'s recurrent_training expired on 17 Sep. Their rostered duty on 19 Sep (VT-DXB) is now illegal under RULE-CERT-06."},
  "answer_key": {"illegal_assignment": {"crew_id": scen5_cc, "date": "2026-09-19", "rule": "RULE-CERT-06"},
                 "options": opts5, "excluded_candidates": exc5, "expected_choice": opts5[0]}})

# --- S6 (hard): two captains sick the same morning ---
p_dxa_18 = next(p for p in pairings if p["aircraft"] == "VT-DXA" and p["days"][0]["date"] == "2026-09-18")
p_dxb_18 = next(p for p in pairings if p["aircraft"] == "VT-DXB" and p["days"][0]["date"] == "2026-09-18")
capA = next(m["crew_id"] for m in p_dxa_18["crew"] if m["role"] == "Captain")
capB = next(m["crew_id"] for m in p_dxb_18["crew"] if m["role"] == "Captain")
s6_call = datetime(2026, 9, 18, 0, 30)
oA, eA = cover_options(p_dxa_18["days"], "Captain", capA, p_dxa_18["pairing_id"], s6_call)
oB, eB = cover_options(p_dxb_18["days"], "Captain", capB, p_dxb_18["pairing_id"], s6_call)
# joint assignment: pick pair of distinct crew (or cancel) minimizing total cost
best = None
cA = [o for o in oA if o["crew_id"]] + [oA[-1]]
cB = [o for o in oB if o["crew_id"]] + [oB[-1]]
for a in cA:
    for b in cB:
        if a["crew_id"] and a["crew_id"] == b["crew_id"]:
            continue
        tot = a["cost_inr"] + b["cost_inr"]
        if best is None or tot < best[0]:
            best = (tot, a, b)
scenarios.append({
  "scenario_id": "S6", "difficulty": "hard", "title": "Two simultaneous captain sick calls",
  "event": {"type": "MULTI_SICK",
            "events": [{"crew_id": capA, "pairing_id": p_dxa_18["pairing_id"], "reported_utc": iso(s6_call)},
                       {"crew_id": capB, "pairing_id": p_dxb_18["pairing_id"], "reported_utc": iso(s6_call)}],
            "narrative": f"At 00:30Z on 18 Sep, the captains of both VT-DXA ({capA}) and VT-DXB ({capB}) call in sick. One qualified reserve captain's window covers the early reports; the desk must allocate scarce cover across both pairings."},
  "answer_key": {"options_dxa": oA, "excluded_dxa": eA,
                 "options_dxb": oB, "excluded_dxb": eB,
                 "optimal_joint_plan": {"total_cost_inr": best[0],
                                        "assign_dxa": best[1], "assign_dxb": best[2]},
                 "note": "The same crew member cannot cover both pairings; the optimal plan minimises total cost across both. Equal-cost mirror assignments (swapping which pairing each candidate covers) are equally correct."}})

# --- held-out (internal only) ---
p_dxe_16b = p_dxe_16
s7_sick_fo = next(m["crew_id"] for m in p_dxe_16b["crew"] if m["role"] == "First Officer")
s7_call = datetime(2026, 9, 16, 2, 0)
o7, e7 = cover_options(p_dxe_16b["days"], "First Officer", s7_sick_fo, p_dxe_16b["pairing_id"], s7_call)
h_start, h_end = datetime(2026, 9, 19, 5, 0), datetime(2026, 9, 19, 9, 0)
aff8 = []
for f in flights:
    if f["date"] != "2026-09-19": continue
    depd = datetime.strptime(f["dep_utc"], "%Y-%m-%dT%H:%M:%SZ"); arrd = datetime.strptime(f["arr_utc"], "%Y-%m-%dT%H:%M:%SZ")
    if (f["dep_station"] == "HYD" and h_start <= depd < h_end) or (f["arr_station"] == "HYD" and h_start <= arrd < h_end):
        aff8.append(f["flight_id"])
held_out = [
  {"scenario_id": "H1", "title": "ATR First Officer sick, 16 Sep",
   "event": {"type": "SICK_CREW", "crew_id": s7_sick_fo, "pairing_id": p_dxe_16b["pairing_id"], "reported_utc": iso(s7_call)},
   "answer_key": {"options": o7, "excluded_candidates": e7, "expected_choice": o7[0]}},
  {"scenario_id": "H2", "title": "HYD closed 05:00–09:00Z, 19 Sep",
   "event": {"type": "STATION_CLOSURE", "station": "HYD", "window_utc": {"start": iso(h_start), "end": iso(h_end)}},
   "answer_key": {"affected_flights": aff8}},
]

# ---------------- questions ----------------
Q = []
def q(tier, prompt, answer, explanation, rules_ref=None):
    Q.append({"question_id": f"Q{len(Q)+1:02d}", "tier": tier, "prompt": prompt,
              "expected_answer": answer, "explanation": explanation,
              "rules_ref": rules_ref or []})

# Tier 1
res_blr_15 = [r["crew_id"] for r in reserve_pool if r["base"] == "BLR"]
q(1, "Who is on reserve at BLR on 2026-09-15, and what are their on-call windows?",
  [{ "crew_id": r["crew_id"], "rank": crew[r["crew_id"]]["rank"], "window": r["oncall_window_utc"]} for r in reserve_pool if r["base"] == "BLR"],
  "Read directly from reserve_pool.json filtered to base BLR (all reserves are active all week).")
c1042_7d = win_sum("C-1042", date(2026, 9, 15), 7) 
q(1, "As of the snapshot, how many duty hours has C-1042 accrued in the 7 calendar days ending 2026-09-14, and how much headroom does that leave under RULE-DUTY-02?",
  {"duty_hours_7d": win_sum("C-1042", D0, 7), "headroom_hours": round(60 - win_sum("C-1042", D0, 7), 2)},
  "Sum daily_history for Sep 8–14 (duty_clocks.json); headroom = 60 − that sum.", ["RULE-DUTY-02"])
dep_del_15 = [f["flight_no"] for f in flights if f["date"] == "2026-09-15" and f["dep_station"] == "DEL"]
q(1, "Which flights depart DEL on 2026-09-15?", dep_del_15,
  "Filter flights.json by date and dep_station. (DX589 runs only on VT-DXC's DEL-start days: 14/16/18/20 Sep.)")
exp30 = [{"crew_id": c["crew_id"], "cert_type": c["cert_type"], "valid_to": c["valid_to"]}
         for c in certifications if date(2026, 9, 15) <= date.fromisoformat(c["valid_to"]) <= date(2026, 10, 15)]
q(1, "List all certifications expiring within 30 days of 2026-09-15.", exp30,
  "Filter certifications.json on valid_to between 2026-09-15 and 2026-10-15.", ["RULE-CERT-06"])
q(1, "Which aircraft operates DX412 on 2026-09-15, and how many seats does it have?",
  {"aircraft": "VT-DXC", "aircraft_type": "A320", "seats": 162},
  "Lookup in flights.json.")
q(1, "What is C-3310's reserve on-call window and reachability?",
  {"window": next(r["oncall_window_utc"] for r in reserve_pool if r["crew_id"] == "C-3310"),
   "reachability_minutes": crew["C-3310"]["reachability_minutes"]},
  "Join reserve_pool.json with crew.json.")
q(1, "What is C-2210's base and rating?", {"base": "DEL", "ratings": ["A320"]}, "Lookup in crew.json.")
q(1, "Which crew are assigned to pairing P-2291, and in what roles?",
  [{"crew_id": m["crew_id"], "role": m["role"]} for m in p2291["crew"]],
  "Read rosters.json, pairing P-2291.")
blr_bom_17 = [f["flight_no"] for f in flights if f["date"] == "2026-09-17" and f["dep_station"] == "BLR" and f["arr_station"] == "BOM"]
q(1, "Which flights fly BLR→BOM on 2026-09-17?", blr_bom_17, "Filter flights.json.")
q(1, "How many flights operate on 2026-09-16 in total?",
  sum(1 for f in flights if f["date"] == "2026-09-16"), "Count flights.json rows for the date.")
q(1, "How many captains are based at DEL, and who are they?",
  [cid for cid, c in crew.items() if c["rank"] == "Captain" and c["base"] == "DEL"],
  "Filter crew.json by rank and base.")
q(1, "What is the longest block time in the schedule, and which flights have it?",
  {"block_hours": 2.75, "flights": sorted({f["flight_no"] for f in flights if abs(f["block_hours"] - 2.75) < 1e-6})},
  "Max block_hours in flights.json.")
q(1, "What is C-2087's rank, and total flight hours over the 28 days ending 2026-09-14?",
  {"rank": "Captain", "flight_hours_28d": win_sum("C-2087", D0, 28, kind=1)},
  "crew.json + duty_clocks.json. Note: C-2087 is a Captain.")
q(1, "Which stations does the network serve nonstop from BLR?",
  sorted({f["arr_station"] for f in flights if f["dep_station"] == "BLR"}),
  "Distinct arr_station where dep_station=BLR.")
q(1, "Who is the Senior Cabin Crew on VT-DXB's pairing on 2026-09-16?",
  next(m["crew_id"] for p in pairings if p["aircraft"] == "VT-DXB" and p["days"][0]["date"] == "2026-09-16" for m in p["crew"] if m["role"] == "Senior Cabin Crew"),
  "rosters.json for the date/aircraft.")
q(1, "What is the disruption-risk score for C-1042 and what drives it?",
  next({"score": r["disruption_risk_score"], "drivers": r["drivers"]} for r in risk_signals if r["crew_id"] == "C-1042"),
  "risk_signals.json — provided, not computed.")

# Tier 2
q(2, "Captain C-1042 calls in sick at 05:00Z on 15 Sep for pairing P-2291. Which flights are immediately uncrewed?",
  {"day1": day1_flights, "day2_also_at_risk": p2291["days"][1]["flights"], "passengers_day1": pax},
  "P-2291 is a 2-day pairing; day 1 legs lose their captain immediately and day 2 is at risk because the pairing overnights at DEL.", ["RULE-QUAL-05"])
okC, issC = check_cover("C-2087", p2291["days"], exclude_pairing="P-2291")
q(2, "If Captain C-2087 is assigned to cover P-2291 from 15 Sep, does any rule breach? Give the detail.",
  {"legal": okC, "issues": issC},
  "Simulate C-2087's 7-day duty window including the new duty; RULE-DUTY-02 is exceeded on day 1.", ["RULE-DUTY-02"])
q(2, "BLR is closed 08:00–14:00Z on 17 Sep. Which flights are affected?",
  affected, "Any flight departing or arriving BLR inside the window. See scenario S3 for per-flight assessment.", [])
q(2, "VT-DXA is delayed 90 minutes before DX401 on 16 Sep. Does the rostered crew breach any limit if they fly all four legs?",
  {"breach": True, "fdp_after_delay": new_fdp, "fdp_limit": lim},
  "FDP extends beyond the 4-sector limit of 12.0h.", ["RULE-FDP-01"])
okD, issD = check_cover("C-2210", p2291["days"], exclude_pairing="P-2291", delay_h=3.25)
q(2, "Can C-2210 (DEL base) legally cover P-2291 if positioned to BLR on the morning of 15 Sep? What is the operational consequence?",
  {"legal": okD, "consequence": "Deadhead positioning on DX402 (arr 08:45Z) delays the first departure by ~3h; RULE-BASE-07 deadhead cost applies."},
  "Legal on all duty/rest/qualification checks; the cost is positioning plus duty-start delay.", ["RULE-BASE-07", "RULE-REST-04"])
q(2, f"Can {scen5_cc} legally operate their rostered VT-DXB duty on 19 Sep?",
  {"legal": False, "rule": "RULE-CERT-06", "detail": "recurrent_training expired 2026-09-17"},
  "certifications.json vs duty date.", ["RULE-CERT-06"])
rel_dxc_d1 = p2291["days"][0]["release_utc"]
q(2, "A crew is released at 15:30Z on 16 Sep. What is the earliest they may report next?",
  "2026-09-17T03:30:00Z", "RULE-REST-04: release + 12h.", ["RULE-REST-04"])
ok5, iss5 = check_cover("C-3305", p2291["days"], exclude_pairing="P-2291")
q(2, "Can reserve C-3305 cover the FULL pairing P-2291 (both days)? Why or why not?",
  {"legal": ok5, "issues": iss5},
  "Day 1 fits, but the rolling 7-day duty window breaches on day 2 — a candidate must be legal for every day of the cover.", ["RULE-DUTY-02"])
q(2, "If DX404 on 16 Sep is cancelled, how many passengers are affected and what is the direct cancellation cost?",
  {"passengers": 162, "cost_inr": costs["cancellation_per_flight"]},
  "flights.json seats + costs.json.", [])
near = []
for cid in crew:
    h = win_sum(cid, date(2026, 9, 15), 7)
    if h >= 45:
        near.append({"crew_id": cid, "duty_hours_7d_incl_15sep_plan": h})
q(2, "Which crew have 45 or more duty hours in the 7 days ending 2026-09-15 (including any planned duty that day)?",
  sorted(near, key=lambda x: -x["duty_hours_7d_incl_15sep_plan"]),
  "Rolling window over daily_history plus the current-week roster.", ["RULE-DUTY-02"])
okE, issE = cover_options(p_dxe_16["days"], "Captain", s1_sick, p_dxe_16["pairing_id"], s1_call)
q(2, "The VT-DXE captain is sick on 16 Sep (called 01:30Z). Which reserve captains' on-call windows cover the callout, and are they qualified?",
  {"eligible": [o["crew_id"] for o in okE if o["crew_id"] and o["crew_id"] in RESERVE_IDS],
   "excluded_examples": [e for e in issE if e["crew_id"] in ("C-3310", "C-3305")][:2]},
  "Callout must fall in the window; ATR rating required (RULE-QUAL-05). C-3315 qualifies; A320-only reserves are excluded.", ["RULE-QUAL-05", "RULE-BASE-07"])
sA = line_sets[("VT-DXA", 0)][0]
okF, issF = check_cover(sA, p2291["days"], exclude_pairing=None)
q(2, f"Captain {sA} (VT-DXA line, works 14/17/20 Sep) is proposed to cover P-2291. Legal?",
  {"legal": okF, "issues": issF},
  "Covering the pairing collides with his own 17 Sep duty — a downstream rest/overlap conflict, not a same-day one.", ["RULE-REST-04"])
q(2, "Station HYD is closed 05:00–09:00Z on 19 Sep. Which flights are affected?",
  aff8, "Same window logic as S3 applied to HYD.", [])
q(2, "Which single flight leg has the most seats at risk if cancelled, and why?",
  {"flights": "any A320 leg (162 seats)", "vs": "ATR72 legs (72 seats)"},
  "Seats come from aircraft_type; A320 legs dominate.", [])

# Tier 3
q(3, "Captain C-1042 is out for pairing P-2291 (15–16 Sep). Produce ranked resolution options with costs and reasoning.",
  scenarios[1]["answer_key"]["options"],
  "See scenario S2: reserve C-3310 is cheapest and clean; C-2210 requires deadhead + ~3h delay; C-2087 and C-3305 are excluded on RULE-DUTY-02; cancellation is last resort.", ["RULE-DUTY-02", "RULE-BASE-07"])
q(3, "Both A320 captains (VT-DXA and VT-DXB) are sick at 00:30Z on 18 Sep. Give the optimal joint crewing plan.",
  scenarios[5]["answer_key"]["optimal_joint_plan"],
  "Enumerate legal candidates per pairing, forbid double-assignment, minimise total cost. See scenario S6.", ["RULE-BASE-07", "RULE-DUTY-02"])
q(3, "After the 90-minute delay to VT-DXA on 16 Sep, what should Crew Control do about the FDP breach?",
  scenarios[3]["answer_key"]["options"],
  "Original crew legally completes 3 legs; a reserve set takes DX404. Cancellation is legal but ~3x the cost. See scenario S4.", ["RULE-FDP-01"])
q(3, f"{scen5_cc}'s recurrent training lapsed. Resolve their 19 Sep assignment.",
  scenarios[4]["answer_key"]["options"][:3],
  "Cabin reserve callout is the clean fix; see scenario S5.", ["RULE-CERT-06"])
q(3, "BLR closes 08:00–14:00Z on 17 Sep. Outline the recovery plan across affected pairings.",
  scenarios[2]["answer_key"]["per_flight_assessment"],
  "Delay-to-reopen where crew FDP holds; re-crew or cancel tail legs where it doesn't. See scenario S3.", ["RULE-FDP-01"])
q(3, "Draft the callout notification to C-3310 for covering P-2291.",
  {"must_include": ["crew_id and pairing_id", "report time/place: 06:00Z 15 Sep, BLR crew room",
                    "flights day 1: DX412/DX413/DX588; overnight DEL (hotel arranged)",
                    "flights day 2: DX589/DX590/DX591, report 04:00Z at DEL",
                    "acknowledgement request with deadline", "contact for questions"]},
  "Judged on completeness, correctness of times from rosters.json, and clarity — not template wording.", [])
q(3, "What is the cheapest legal way to cover the VT-DXF First Officer on 20 Sep if they call sick at 03:30Z?",
  (lambda: (lambda o, e: o[0])(*cover_options(next(p for p in pairings if p["aircraft"] == "VT-DXF" and p["days"][0]["date"] == "2026-09-20")["days"], "First Officer",
       next(m["crew_id"] for p in pairings if p["aircraft"] == "VT-DXF" and p["days"][0]["date"] == "2026-09-20" for m in p["crew"] if m["role"] == "First Officer"),
       next(p["pairing_id"] for p in pairings if p["aircraft"] == "VT-DXF" and p["days"][0]["date"] == "2026-09-20"), datetime(2026, 9, 20, 3, 30))))(),
  "ATR-rated FO reserve C-3316 (window 03:00–15:00) is the clean cover.", ["RULE-QUAL-05"])
q(3, "If the desk wants a standing morning briefing, which three data points per aircraft line should it surface and why?",
  {"suggested": ["crew legality headroom (7d duty) for today's rostered crew",
                 "reserve availability by window and rating for the day",
                 "risk_signals for today's rostered crew (provided input)"],
   "note": "Open-ended; judged on operational reasoning, not exact match."},
  "Tier-3 open question — grading rubric style.", [])

# ---------------- write files ----------------
def dump(name, obj, folder=OUT):
    with open(os.path.join(folder, name), "w") as fh:
        json.dump(obj, fh, indent=1, default=str)

dump("flights.json", flights)
dump("crew.json", sorted(crew.values(), key=lambda c: c["crew_id"]))
dump("rosters.json", {"pairings": pairings,
                      "flagged_exceptions": FLAGGED,
                      "note": "Every assignment is legal under rules.json except the flagged exceptions listed here."})
dump("duty_clocks.json", duty_clocks)
dump("reserve_pool.json", reserve_pool)
dump("certifications.json", certifications)
dump("rules.json", rules)
dump("costs.json", costs)
dump("risk_signals.json", risk_signals)
dump("scenarios.json", scenarios)
dump("questions.json", Q)
dump("held_out_scenarios.json", held_out, folder=INTERNAL)

print("S2 options:", json.dumps(scenarios[1]["answer_key"]["options"][:3], indent=1))
print("S2 excluded (engineered):", [e for e in scenarios[1]["answer_key"]["excluded_candidates"] if e["crew_id"] in ("C-2087", "C-3305", "C-2091")])
print("questions:", len(Q), " tiers:", {t: sum(1 for x in Q if x['tier']==t) for t in (1,2,3)})
