import json, os, statistics
from collections import Counter, defaultdict
from datetime import datetime, date

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')

files = [
    'flights.json','crew.json','rosters.json','duty_clocks.json',
    'reserve_pool.json','certifications.json','rules.json','costs.json',
    'risk_signals.json','scenarios.json','questions.json'
]

def load(fname):
    p = os.path.join(DATA_DIR, fname)
    try:
        with open(p) as fh:
            return json.load(fh)
    except Exception as e:
        print(f"ERROR loading {fname}: {e}")
        return None

flights = load('flights.json') or []
crew = load('crew.json') or []
rosters = load('rosters.json') or {"pairings": []}
duty_clocks = load('duty_clocks.json') or []
reserves = load('reserve_pool.json') or []
certs = load('certifications.json') or []
rules = load('rules.json') or {}
costs = load('costs.json') or {}
risks = load('risk_signals.json') or []
scenarios = load('scenarios.json') or []
questions = load('questions.json') or []

print('=== High-level counts ===')
print('flights:', len(flights))
print('crew:', len(crew))
print('pairings:', len(rosters.get('pairings', [])))
print('duty_clocks:', len(duty_clocks))
print('reserves:', len(reserves))
print('certifications:', len(certs))
print('scenarios:', len(scenarios))
print('questions:', len(questions))

# Crew distributions
by_base = Counter(c.get('base') for c in crew)
by_rank = Counter(c.get('rank') for c in crew)
ratings_counter = Counter()
for c in crew:
    for r in c.get('ratings', []): ratings_counter[r]+=1

print('\n=== Crew distributions ===')
print('by base:', by_base.most_common())
print('by rank:', by_rank.most_common())
print('ratings counts:', ratings_counter.most_common())

# Duty clocks stats
d7 = [c.get('duty_hours_7d',0.0) for c in duty_clocks]
f28 = [c.get('flight_hours_28d',0.0) for c in duty_clocks]
if d7:
    print('\n=== Duty/Flight hours (7d/28d) ===')
    print('duty 7d: min', min(d7), 'max', max(d7), 'mean', round(statistics.mean(d7),2))
if f28:
    print('flight 28d: min', min(f28), 'max', max(f28), 'mean', round(statistics.mean(f28),2))

# Top busiest routes
route_counts = Counter()
route_seats = Counter()
for f in flights:
    route = f['dep_station'] + '->' + f['arr_station']
    route_counts[route]+=1
    route_seats[route]+= f.get('seats',0)
print('\n=== Top routes ===')
for r,cnt in route_counts.most_common(10):
    print(r, 'flights=', cnt, 'total_seats=', route_seats[r])

# Pairing lengths and FDP
pairing_days = rosters.get('pairings', [])
pairing_sector_counts = []
pairing_duty_hours = []
for p in pairing_days:
    for d in p.get('days', []):
        num_sectors = len(d.get('flights', []))
        pairing_sector_counts.append(num_sectors)
        # compute duty hours if present
        try:
            rep = datetime.strptime(d['report_utc'], '%Y-%m-%dT%H:%M:%SZ')
            rel = datetime.strptime(d['release_utc'], '%Y-%m-%dT%H:%M:%SZ')
            dh = (rel - rep).total_seconds()/3600.0
            pairing_duty_hours.append(dh)
        except:
            pass

print('\n=== Pairing stats ===')
print('avg sectors per pairing-day:', round(statistics.mean(pairing_sector_counts),2) if pairing_sector_counts else 0)
print('avg duty hours per pairing-day:', round(statistics.mean(pairing_duty_hours),2) if pairing_duty_hours else 0)

# Certifications expiring soon relative to today
as_of = date(2026,9,5)
expiring_30 = []
expiring_90 = []
for c in certs:
    try:
        vt = datetime.fromisoformat(c['valid_to']).date()
        days = (vt - as_of).days
        if days <= 30:
            expiring_30.append((c['crew_id'], c['cert_type'], c['valid_to']))
        if days <= 90:
            expiring_90.append((c['crew_id'], c['cert_type'], c['valid_to']))
    except:
        pass
print('\n=== Certifications expiring ===')
print('<=30 days:', len(expiring_30))
print('<=90 days:', len(expiring_90))
if expiring_30:
    print('sample expiring <=30d:', expiring_30[:5])

# Reserve on-call window start times distribution
start_hours = Counter()
for r in reserves:
    try:
        s = r.get('oncall_window_utc', {}).get('start') or r.get('oncall_start') or r.get('oncall_start_time')
        if s:
            h = int(s.split(':')[0])
            start_hours[h]+=1
    except:
        pass
print('\n=== Reserve on-call window start hour distribution ===')
print(start_hours.most_common())

# Risk signals: top-risk flights or pairings
risk_by_flight = Counter()
for r in risks:
    if 'flight_id' in r:
        risk_by_flight[r['flight_id']]+= r.get('score',1)
print('\n=== Risk signals ===')
print('top risky flights sample:', risk_by_flight.most_common(10)[:10])

# Questions tiers distribution
tiers = Counter(q.get('tier') for q in questions)
print('\n=== Questions by tier ===')
print(dict(tiers))

# Engineered edge cases detection
engineered = [cid for cid in ('C-1042','C-2087','C-2210','C-3305','C-3310') if any(c.get('crew_id')==cid for c in crew)]
print('\n=== Engineered/known IDs present ===')
print(engineered)

# simple heuristic patterns
patterns = []
# 1. Many flights originate/terminate at BLR
blr_count = sum(1 for f in flights if f['dep_station']=='BLR' or f['arr_station']=='BLR')
if blr_count / max(1,len(flights)) > 0.6:
    patterns.append('BLR hub dominates schedule (>60% flights)')
# 2. A320 vs ATR proportions
ac_types = Counter(f.get('aircraft_type') for f in flights)
patterns.append('Aircraft mix: ' + ', '.join(f"{k}:{v}" for k,v in ac_types.items()))

print('\n=== Discovered patterns (heuristic) ===')
for p in patterns:
    print('-', p)

print('\nAnalysis complete.')
