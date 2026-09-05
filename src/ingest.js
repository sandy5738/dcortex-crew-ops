"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
const DATA_DIR = path_1.default.resolve(__dirname, '../data');
function initDb(db) {
    console.log("Creating tables...");
    db.exec(`
    CREATE TABLE IF NOT EXISTS crew (
        crew_id TEXT PRIMARY KEY,
        name TEXT,
        rank TEXT,
        base TEXT,
        ratings TEXT, -- Stored as JSON string
        seniority INTEGER,
        reachability_minutes INTEGER
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS duty_clocks (
        crew_id TEXT PRIMARY KEY,
        duty_hours_7d REAL,
        flight_hours_28d REAL,
        last_rest_ended TEXT,
        FOREIGN KEY(crew_id) REFERENCES crew(crew_id)
    )
  `);
}
function ingestCrew(db) {
    const filePath = path_1.default.join(DATA_DIR, 'crew.json');
    if (!fs_1.default.existsSync(filePath))
        return console.log("crew.json not found!");
    const data = JSON.parse(fs_1.default.readFileSync(filePath, 'utf-8'));
    console.log(`Ingesting ${data.length} crew members...`);
    const insert = db.prepare(`
    INSERT OR REPLACE INTO crew (crew_id, name, rank, base, ratings, seniority, reachability_minutes)
    VALUES (@crew_id, @name, @rank, @base, @ratings, @seniority, @reachability_minutes)
  `);
    // Use transactions for fast bulk inserts in SQLite
    const insertMany = db.transaction((crewList) => {
        for (const c of crewList) {
            insert.run({
                ...c,
                ratings: JSON.stringify(c.ratings || [])
            });
        }
    });
    insertMany(data);
}
function ingestDutyClocks(db) {
    const filePath = path_1.default.join(DATA_DIR, 'duty_clocks.json');
    if (!fs_1.default.existsSync(filePath))
        return console.log("duty_clocks.json not found!");
    const data = JSON.parse(fs_1.default.readFileSync(filePath, 'utf-8'));
    console.log(`Ingesting ${data.length} duty clocks...`);
    const insert = db.prepare(`
    INSERT OR REPLACE INTO duty_clocks (crew_id, duty_hours_7d, flight_hours_28d, last_rest_ended)
    VALUES (@crew_id, @duty_hours_7d, @flight_hours_28d, @last_rest_ended)
  `);
    const insertMany = db.transaction((clockList) => {
        for (const dc of clockList)
            insert.run(dc);
    });
    insertMany(data);
}
function main() {
    const db = (0, db_1.getDb)();
    try {
        initDb(db);
        ingestCrew(db);
        ingestDutyClocks(db);
        console.log("Data ingestion complete!");
    }
    catch (err) {
        console.error("Error during ingestion:", err);
    }
    finally {
        db.close();
    }
}
main();
