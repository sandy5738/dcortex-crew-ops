import Database from 'better-sqlite3';
import path from 'path';

// Store DB in the node folder
const dbPath = path.resolve(__dirname, '../airline.db');

export function getDb() {
  // better-sqlite3 is fully synchronous and very fast!
  return new Database(dbPath);
}
