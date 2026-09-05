const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')) } catch(e){ console.error('ERR', f, e.message); return null }
}
const flights = read('flights.json') || [];
const crew = read('crew.json') || [];
const rosters = read('rosters.json') || {pairings: []};
const duty_clocks = read('duty_clocks.json') || [];
const reserves = read('reserve_pool.json') || [];
const certs = read('certifications.json') || [];
const risks = read('risk_signals.json') || [];
const scenarios = read('scenarios.json') || [];
const questions = read('questions.json') || [];
const costs = read('costs.json') || {};

console.log('=== High-level counts ===');
console.log('flights:', flights.length);
console.log('crew:', crew.length);
console.log('pairings:', rosters.pairings ? rosters.pairings.length : 0);
console.log('duty_clocks:', duty_clocks.length);
console.log('reserves:', reserves.length);
console.log('certifications:', certs.length);
console.log('scenarios:', scenarios.length);
console.log('questions:', questions.length);

const Counter = () => { const map = new Map(); return {
  add(k,v=1){ map.set(k, (map.get(k)||0)+v) },
  entries(){ return Array.from(map.entries()).sort((a,b)=>b[1]-a[1]) }
}};

const by_base = Counter();
const by_rank = Counter();
const ratings = Counter();
crew.forEach(c=>{ by_base.add(c.base); by_rank.add(c.rank); (c.ratings||[]).forEach(r=>ratings.add(r)) });
console.log('\n=== Crew distributions ===')
console.log('by base:', by_base.entries().slice(0,10));
console.log('by rank:', by_rank.entries());
console.log('ratings:', ratings.entries());

const d7 = duty_clocks.map(c=>c.duty_hours_7d||0).filter(x=>typeof x==='number');
const f28 = duty_clocks.map(c=>c.flight_hours_28d||0).filter(x=>typeof x==='number');
const stats = arr=>({min: Math.min(...arr), max: Math.max(...arr), mean: arr.reduce((a,b)=>a+b,0)/arr.length});
if(d7.length) console.log('\n=== Duty/Flight hours ===\n', stats(d7));
if(f28.length) console.log(stats(f28));

const route_counts = Counter(); const route_seats = new Map();
flights.forEach(f=>{ const r = f.dep_station+'->'+f.arr_station; route_counts.add(r); route_seats.set(r, (route_seats.get(r)||0)+ (f.seats||0)) });
console.log('\n=== Top routes ==='); console.log(route_counts.entries().slice(0,10).map(([r,c])=>[r,c, route_seats.get(r)]));

// pairing stats
let pairing_sector_counts = [], pairing_duty_hours = [];
(rosters.pairings||[]).forEach(p=>{ p.days.forEach(d=>{ pairing_sector_counts.push(d.flights.length); try{ const rep = new Date(d.report_utc); const rel = new Date(d.release_utc); pairing_duty_hours.push((rel-rep)/3600000); }catch(e){} })});
if(pairing_sector_counts.length) console.log('\n=== Pairing stats ===\n avg sectors:', pairing_sector_counts.reduce((a,b)=>a+b,0)/pairing_sector_counts.length);
if(pairing_duty_hours.length) console.log('avg duty hours:', pairing_duty_hours.reduce((a,b)=>a+b,0)/pairing_duty_hours.length);

const as_of = new Date('2026-09-05');
const exp30 = certs.filter(c=>{ try{ return (new Date(c.valid_to)-as_of)/(1000*60*60*24) <=30 }catch(e){return false}});
const exp90 = certs.filter(c=>{ try{ return (new Date(c.valid_to)-as_of)/(1000*60*60*24) <=90 }catch(e){return false}});
console.log('\n=== Certs expiring ===\n<=30:', exp30.length, '\n<=90:', exp90.length, exp30.slice(0,5));

const start_hours = Counter();
reserves.forEach(r=>{ const s = (r.oncall_window_utc && r.oncall_window_utc.start) || r.oncall_start || r.oncall_start_time; if(s) start_hours.add(parseInt(s.split(':')[0],10)) });
console.log('\n=== Reserve start hours ===', start_hours.entries());

const risk_by_flight = Counter(); risks.forEach(r=>{ if(r.flight_id) risk_by_flight.add(r.flight_id, r.score||1) });
console.log('\n=== Risk signals sample ===', risk_by_flight.entries().slice(0,10));

const tiers = Counter(); questions.forEach(q=>tiers.add(q.tier)); console.log('\n=== Question tiers ===', tiers.entries());

const engineered = ['C-1042','C-2087','C-2210','C-3305','C-3310'].filter(id=> crew.some(c=>c.crew_id===id));
console.log('\n=== Engineered IDs present ===', engineered);

// heuristics
let blr_count = flights.filter(f=>f.dep_station==='BLR' || f.arr_station==='BLR').length;
if(blr_count/flights.length>0.6) console.log('\nPattern: BLR hub dominates schedule (>60% flights)');
const ac = new Map(); flights.forEach(f=> ac.set(f.aircraft_type, (ac.get(f.aircraft_type)||0)+1)); console.log('Aircraft mix:', Array.from(ac.entries()));

console.log('\nAnalysis complete.');
