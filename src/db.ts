import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Store DB in the node folder. It is a build artifact, not a committed file:
// `npm run ingest` rebuilds it from data/*.json in well under a second.
export const DB_PATH = path.resolve(__dirname, '../airline.db');
export const DATA_DIR = path.resolve(__dirname, '../data');

let cached: Database.Database | null = null;

/**
 * The shared read connection.
 *
 * Memoised on purpose. Every rule check used to call `new Database(...)` and
 * `db.close()`, so enumerating one rank cost roughly 28 crew x 7 rules = 196
 * connection opens. Now that RULE-DUTY-02 and RULE-FLT-03 sum a 7- or 28-row
 * window instead of reading one cached column, that per-call open would be
 * doing real work for no reason.
 *
 * Callers must NOT close this handle. better-sqlite3 is synchronous, and the
 * process holding one read handle for its lifetime is the intended usage.
 */
export function getDb(): Database.Database {
  if (cached) return cached;

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(
      `${DB_PATH} not found. The database is a build artifact - build it with ` +
      `\`npm run ingest\`.`
    );
  }

  cached = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  cached.pragma('foreign_keys = ON');
  return cached;
}

/** Drop the cached handle. Used by the ingest, which needs write access. */
export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/**
 * A writable handle, for the ingest only.
 *
 * `at` lets the ingest build into a temp path and rename it over DB_PATH on
 * success, so a failed rebuild leaves the previous database intact.
 */
export function openForWrite(at: string = DB_PATH): Database.Database {
  closeDb();
  return new Database(at);
}
