// Usa node:sqlite (built-in no Node 22.5+/24) — sem compilação nativa
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/app.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS enviados (
  phone TEXT PRIMARY KEY,
  wamid TEXT,
  template TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  total INTEGER DEFAULT 0,
  enviados INTEGER DEFAULT 0,
  falhas INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  motivo TEXT
);

CREATE TABLE IF NOT EXISTS run_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  wamid TEXT,
  motivo TEXT,
  ts TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_run_results_run_id ON run_results(run_id);
`);

// ---------- Helpers ----------
export function getConfig(key) {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setConfig(key, value) {
  db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getAllConfig() {
  const rows = db.prepare("SELECT key, value FROM config").all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

export function isAlreadySent(phone) {
  return !!db.prepare("SELECT 1 FROM enviados WHERE phone = ?").get(phone);
}

export function markSent(phone, wamid, template) {
  db.prepare(
    "INSERT INTO enviados (phone, wamid, template) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET wamid=excluded.wamid, sent_at=CURRENT_TIMESTAMP"
  ).run(phone, wamid || null, template || null);
}

export function createRun(total) {
  const info = db.prepare("INSERT INTO runs (total) VALUES (?)").run(total);
  return info.lastInsertRowid;
}

export function updateRunCounters(runId, { enviados, falhas }) {
  db.prepare("UPDATE runs SET enviados = ?, falhas = ? WHERE id = ?").run(
    enviados,
    falhas,
    runId
  );
}

export function finishRun(runId, status, motivo) {
  db.prepare(
    "UPDATE runs SET finished_at = CURRENT_TIMESTAMP, status = ?, motivo = ? WHERE id = ?"
  ).run(status, motivo || null, runId);
}

export function addRunResult(runId, phone, status, wamid, motivo) {
  db.prepare(
    "INSERT INTO run_results (run_id, phone, status, wamid, motivo) VALUES (?, ?, ?, ?, ?)"
  ).run(runId, phone, status, wamid || null, motivo || null);
}

export function getRun(runId) {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
}

export function getRunResults(runId, limit = 5000) {
  return db
    .prepare("SELECT * FROM run_results WHERE run_id = ? ORDER BY id LIMIT ?")
    .all(runId, limit);
}

export function listRuns(limit = 50) {
  return db
    .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
    .all(limit);
}
