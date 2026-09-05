-- Intelligent SQLite queries for Crew Ops dataset
-- Assumes a SQLite DB containing tables derived from the JSON files.
-- Tables assumed (recommended schema names):
--   crew(crew_id, name, rank, base, ratings TEXT JSON, status, reachability_minutes, seniority)
--   duty_clocks(crew_id, duty_hours_7d, flight_hours_28d, last_rest_ended, daily_history JSON)
--   flights(flight_id, flight_no, date, dep_station, arr_station, dep_utc, arr_utc, block_hours, aircraft_type, seats)
--   pairings(pairing_id, aircraft)
--   pairing_days(pairing_id, date, report_utc, release_utc)
--   pairing_crew(pairing_id, crew_id, role)
--   reserve_pool(crew_id, base, oncall_start TEXT, oncall_end TEXT) -- times as HH:MM
--   certifications(crew_id, cert_type, valid_from, valid_to)
--   costs(...)
-- NOTE: adapt column/table names to your actual ingest schema if different.

-- 1) Top N crew by duty (7-day) or flight (28-day) hours
-- Params: :limit (integer)
SELECT c.crew_id, c.name, dc.duty_hours_7d, dc.flight_hours_28d
FROM duty_clocks dc
JOIN crew c USING(crew_id)
ORDER BY dc.duty_hours_7d DESC, dc.flight_hours_28d DESC
LIMIT :limit;

-- 2) Projected 7-day duty check for a candidate assignment
-- Returns whether assigning :new_duty_hours would breach the 60h/7d rule for :crew_id
-- Params: :crew_id, :new_duty_hours
SELECT dc.crew_id, dc.duty_hours_7d AS current_7d, :new_duty_hours AS new_duty,
       dc.duty_hours_7d + :new_duty_hours AS projected_7d,
       CASE WHEN dc.duty_hours_7d + :new_duty_hours > 60.0 THEN 1 ELSE 0 END AS breaches_60h
FROM duty_clocks dc
WHERE dc.crew_id = :crew_id;

-- 3) Available reserves whose on-call window covers a required report timestamp
-- Params: :required_report_utc (ISO datetime), :required_date (YYYY-MM-DD)
-- Assumes oncall_start/oncall_end are HH:MM on the same date, inclusive.
SELECT r.crew_id, r.base, r.oncall_start, r.oncall_end
FROM reserve_pool r
WHERE :required_report_utc >= datetime(:required_date || 'T' || r.oncall_start || 'Z')
  AND :required_report_utc <= datetime(:required_date || 'T' || r.oncall_end || 'Z')
  AND EXISTS(SELECT 1 FROM crew c WHERE c.crew_id = r.crew_id AND c.status = 'active');

-- 4) Crew rated for a given aircraft type and NOT rostered on a specific date
-- Params: :aircraft_type, :date (YYYY-MM-DD)
SELECT c.crew_id, c.name, c.rank, c.base
FROM crew c
JOIN json_each(c.ratings) r ON r.value = :aircraft_type
WHERE c.status = 'active'
  AND c.crew_id NOT IN (
    SELECT pc.crew_id
    FROM pairing_crew pc
    JOIN pairing_days pd ON pc.pairing_id = pd.pairing_id
    WHERE pd.date = :date
  );

-- 5) Flights that would become uncrewed if a given crew member is unavailable on a date
-- Params: :crew_id, :date
SELECT f.flight_id, f.flight_no, f.dep_station, f.arr_station, f.dep_utc, f.arr_utc, f.seats
FROM flights f
WHERE f.flight_id IN (
  SELECT pd_f.flight_id
  FROM pairing_days pd
  JOIN (
    -- explode pairing_days flights if your schema stores flights as a separate table 'pairing_day_flights'
    -- otherwise joining via a lookup table is expected. Here we assume pairing_day_flights(pairing_id,date,flight_id)
    SELECT pdf.pairing_id, pdf.date, pdf.flight_id
    FROM pairing_day_flights pdf
  ) pd_f ON pd.pairing_id = pd_f.pairing_id AND pd.date = pd_f.date
  JOIN pairing_crew pc ON pc.pairing_id = pd_f.pairing_id
  WHERE pc.crew_id = :crew_id AND pd_f.date = :date
);

-- 6) Estimate deadhead + callout cost to position a crew from their base to a required departure
-- Params: :crew_id, :required_dep_station, :required_date (YYYY-MM-DD)
-- Assumes a costs table with columns: reserve_callout_pilot, reserve_callout_cabin, positioning_cost_per_km, delay_cost_per_duty_hour
SELECT c.crew_id, c.base,
       CASE WHEN c.base = :required_dep_station THEN 0
            ELSE coalesce(cs.deadhead_cost, 0) + coalesce(cs.callout_cost, 0)
       END AS estimated_positioning_cost
FROM crew c
LEFT JOIN (
  SELECT :required_dep_station AS dest, -- placeholder join for costs; replace with your real cost calc
         (SELECT value FROM costs WHERE key = 'deadhead_base_to_dest' LIMIT 1) AS deadhead_cost,
         (SELECT value FROM costs WHERE key = 'callout_pilot' LIMIT 1) AS callout_cost
) cs ON 1=1
WHERE c.crew_id = :crew_id;

-- 7) Crew certifications expiring within the next N days (useful for Tier-1 checks)
-- Params: :as_of (YYYY-MM-DD), :days (integer)
SELECT cert.crew_id, cert.cert_type, cert.valid_to
FROM certifications cert
WHERE date(cert.valid_to) <= date(:as_of, '+' || :days || ' days')
ORDER BY date(cert.valid_to) ASC;

-- 8) Identify pairings/days that violate FDP limits (13h - 0.5h per extra sector >2)
-- Params: none (scans all pairings)
SELECT pd.pairing_id, pd.date,
       (julianday(pd.release_utc)-julianday(pd.report_utc))*24.0 AS duty_hours,
       COUNT(pdf.flight_id) AS num_sectors,
       (13.0 - 0.5 * MAX(0, COUNT(pdf.flight_id) - 2)) AS allowed_fdp
FROM pairing_days pd
JOIN pairing_day_flights pdf ON pd.pairing_id = pdf.pairing_id AND pd.date = pdf.date
GROUP BY pd.pairing_id, pd.date
HAVING duty_hours > allowed_fdp;

-- 9) Crew who would breach 100h/28d flight-hour limit if assigned extra block hours
-- Params: :extra_block_hours
SELECT dc.crew_id, dc.flight_hours_28d, dc.flight_hours_28d + :extra_block_hours AS projected_28d
FROM duty_clocks dc
WHERE dc.flight_hours_28d + :extra_block_hours > 100.0;

-- 10) Average and total passengers at risk for uncrewed flights (flights without assigned crew)
-- Params: none
SELECT COUNT(f.flight_id) AS uncrewed_flights, SUM(f.seats) AS total_passengers_at_risk,
       AVG(f.seats) AS avg_passengers_per_uncrewed_flight
FROM flights f
LEFT JOIN (
  SELECT pdf.flight_id FROM pairing_day_flights pdf
) assigned ON assigned.flight_id = f.flight_id
WHERE assigned.flight_id IS NULL;

-- End of queries
