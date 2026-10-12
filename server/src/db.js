import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routes (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  service_date  TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL,
  depot_lat     REAL,
  depot_lng     REAL,
  return_to_depot INTEGER NOT NULL DEFAULT 0,
  geometry      TEXT NOT NULL DEFAULT '[]',
  distance_m    REAL NOT NULL DEFAULT 0,
  duration_s    REAL,
  road_snapped  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stops (
  id         INTEGER PRIMARY KEY,
  route_id   INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'picked_up', 'not_out')),
  status_at  TEXT,
  note       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS stops_by_route ON stops (route_id, seq);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
