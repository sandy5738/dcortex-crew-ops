import fs from 'fs';
import path from 'path';
import { getDb } from './db';

const DATA_DIR = path.resolve(__dirname, '../data');

function initDb(db: any) {
  console.log("Creating tables...");
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS crew (
        crew_id TEXT PRIMARY KEY,
        name TEXT,
        rank TEXT,
        base TEXT,
        ratings TEXT,
        seniority INTEGER,
        reachability_minutes INTEGER
    );
    CREATE TABLE IF NOT EXISTS duty_clocks (
        crew_id TEXT PRIMARY KEY,
        duty_hours_7d REAL,
        flight_hours_28d REAL,
        last_rest_ended TEXT,
        FOREIGN KEY(crew_id) REFERENCES crew(crew_id)
    );
    CREATE TABLE IF NOT EXISTS flights (
        flight_id TEXT PRIMARY KEY,
        flight_no TEXT,
        date TEXT,
        dep_station TEXT,
        arr_station TEXT,
        dep_utc TEXT,
        arr_utc TEXT,
        block_hours REAL,
        aircraft TEXT,
        aircraft_type TEXT,
        seats INTEGER
    );
    CREATE TABLE IF NOT EXISTS certifications (
        crew_id TEXT,
        cert_type TEXT,
        valid_to TEXT,
        FOREIGN KEY(crew_id) REFERENCES crew(crew_id)
    );
    CREATE TABLE IF NOT EXISTS reserve_pool (
        crew_id TEXT,
        base TEXT,
        date TEXT,
        oncall_start TEXT,
        oncall_end TEXT,
        FOREIGN KEY(crew_id) REFERENCES crew(crew_id)
    );
    CREATE TABLE IF NOT EXISTS pairings (
        pairing_id TEXT PRIMARY KEY,
        aircraft TEXT,
        json_data TEXT
    );
  `);
}

function ingestData(db: any) {
  // Crew
  const crew = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'crew.json'), 'utf-8'));
  const insertCrew = db.prepare(`INSERT OR REPLACE INTO crew (crew_id, name, rank, base, ratings, seniority, reachability_minutes) VALUES (@crew_id, @name, @rank, @base, @ratings, @seniority, @reachability_minutes)`);
  
  // Duty Clocks
  const clocks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'duty_clocks.json'), 'utf-8'));
  const insertClocks = db.prepare(`INSERT OR REPLACE INTO duty_clocks (crew_id, duty_hours_7d, flight_hours_28d, last_rest_ended) VALUES (@crew_id, @duty_hours_7d, @flight_hours_28d, @last_rest_ended)`);

  // Flights
  const flights = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'flights.json'), 'utf-8'));
  const insertFlights = db.prepare(`INSERT OR REPLACE INTO flights (flight_id, flight_no, date, dep_station, arr_station, dep_utc, arr_utc, block_hours, aircraft, aircraft_type, seats) VALUES (@flight_id, @flight_no, @date, @dep_station, @arr_station, @dep_utc, @arr_utc, @block_hours, @aircraft, @aircraft_type, @seats)`);

  // Certifications
  const certs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'certifications.json'), 'utf-8'));
  db.exec('DELETE FROM certifications');
  const insertCerts = db.prepare(`INSERT INTO certifications (crew_id, cert_type, valid_to) VALUES (@crew_id, @cert_type, @valid_to)`);

  // Reserve Pool
  const reserves = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reserve_pool.json'), 'utf-8'));
  db.exec('DELETE FROM reserve_pool');
  const insertReserves = db.prepare(`INSERT INTO reserve_pool (crew_id, base, date, oncall_start, oncall_end) VALUES (@crew_id, @base, @date, @oncall_start, @oncall_end)`);

  // Rosters (Pairings)
  const rosters = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rosters.json'), 'utf-8'));
  const insertPairings = db.prepare(`INSERT OR REPLACE INTO pairings (pairing_id, aircraft, json_data) VALUES (@pairing_id, @aircraft, @json_data)`);

  const runAll = db.transaction(() => {
    for (const c of crew) insertCrew.run({ ...c, ratings: JSON.stringify(c.ratings || []) });
    for (const dc of clocks) insertClocks.run(dc);
    for (const f of flights) insertFlights.run(f);
    for (const c of certs) insertCerts.run(c);
    
    // Flatten reserve pool dates
    for (const r of reserves) {
        for (const date of r.dates) {
            insertReserves.run({
                crew_id: r.crew_id,
                base: r.base,
                date: date,
                oncall_start: r.oncall_window_utc.start,
                oncall_end: r.oncall_window_utc.end
            });
        }
    }

    for (const p of rosters.pairings) {
        insertPairings.run({
            pairing_id: p.pairing_id,
            aircraft: p.aircraft,
            json_data: JSON.stringify(p)
        });
    }
  });

  runAll();
  console.log(`Ingested ${crew.length} crew, ${flights.length} flights, ${rosters.pairings.length} pairings.`);
}

function main() {
  const db = getDb();
  try {
    initDb(db);
    ingestData(db);
    console.log("Data ingestion complete!");
  } catch (err) {
    console.error("Error during ingestion:", err);
  } finally {
    db.close();
  }
}

main();
