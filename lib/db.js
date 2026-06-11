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

-- PARTE 1 — contas WhatsApp por usuário (apelido + credenciais).
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  apelido TEXT NOT NULL,
  icone TEXT,
  cor TEXT,
  numero TEXT,
  phone_number_id TEXT,
  waba_id TEXT,
  token TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wa_accounts_user ON whatsapp_accounts(user_id);

-- PARTE 5 — cada linha do CSV do run com status próprio, pra pausar/retomar e
-- gerar o CSV de pendentes (row_json = valores ORIGINAIS crus da linha).
CREATE TABLE IF NOT EXISTS run_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  phone TEXT,
  parametros TEXT,
  row_json TEXT,
  status TEXT DEFAULT 'pending',   -- pending | sent | failed | skipped
  wamid TEXT,
  motivo TEXT,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_rows_run ON run_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_run_rows_run_status ON run_rows(run_id, status);
`);

// ---------- Migrações idempotentes (bancos antigos) ----------
function tableHasColumn(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === col);
}
function ensureColumn(table, col, type) {
  if (!tableHasColumn(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}
ensureColumn("run_results", "delivery_status", "TEXT");
ensureColumn("run_results", "delivery_error", "TEXT");
// índice em wamid pra lookup rápido quando webhook chega
db.exec(`CREATE INDEX IF NOT EXISTS idx_run_results_wamid ON run_results(wamid)`);

// Colunas novas em runs (multi-run + apelido + pausa em N + persistência).
ensureColumn("runs", "user_id", "TEXT");
ensureColumn("runs", "account_id", "INTEGER");
ensureColumn("runs", "pulados", "INTEGER DEFAULT 0");
ensureColumn("runs", "dispatched", "INTEGER DEFAULT 0");
ensureColumn("runs", "pause_at", "INTEGER");
ensureColumn("runs", "pause_reason", "TEXT");
ensureColumn("runs", "csv_filename", "TEXT");
ensureColumn("runs", "csv_headers", "TEXT"); // JSON array
ensureColumn("runs", "csv_delimiter", "TEXT");
ensureColumn("runs", "var_cols", "TEXT"); // JSON array
ensureColumn("runs", "template_name", "TEXT");
ensureColumn("runs", "language", "TEXT");
ensureColumn("runs", "concurrency", "INTEGER");
ensureColumn("runs", "skip_duplicates", "INTEGER");

// ---------- Helpers: config ----------
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

// ---------- Helpers: dedupe (enviados) ----------
export function isAlreadySent(phone) {
  return !!db.prepare("SELECT 1 FROM enviados WHERE phone = ?").get(phone);
}

export function markSent(phone, wamid, template) {
  db.prepare(
    "INSERT INTO enviados (phone, wamid, template) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET wamid=excluded.wamid, sent_at=CURRENT_TIMESTAMP"
  ).run(phone, wamid || null, template || null);
}

// ---------- Helpers: contas WhatsApp (PARTE 1) ----------
export function listAccounts(userId) {
  return db
    .prepare("SELECT * FROM whatsapp_accounts WHERE user_id = ? ORDER BY id")
    .all(userId);
}

export function getAccount(id) {
  return db.prepare("SELECT * FROM whatsapp_accounts WHERE id = ?").get(id);
}

// Conta que pertence a esse user (isolamento — um user não usa conta de outro).
export function getAccountForUser(id, userId) {
  return db
    .prepare("SELECT * FROM whatsapp_accounts WHERE id = ? AND user_id = ?")
    .get(id, userId);
}

export function createAccount(userId, a) {
  const info = db
    .prepare(
      `INSERT INTO whatsapp_accounts
        (user_id, apelido, icone, cor, numero, phone_number_id, waba_id, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      a.apelido,
      a.icone || null,
      a.cor || null,
      a.numero || null,
      a.phone_number_id || null,
      a.waba_id || null,
      a.token || null
    );
  return getAccount(info.lastInsertRowid);
}

export function updateAccount(id, userId, a) {
  // token = COALESCE(?, token): se vier null (campo vazio no form), MANTÉM o
  // token atual — assim editar apelido/cor sem redigitar o token não apaga ele.
  db.prepare(
    `UPDATE whatsapp_accounts SET
       apelido = ?, icone = ?, cor = ?, numero = ?,
       phone_number_id = ?, waba_id = ?, token = COALESCE(?, token),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  ).run(
    a.apelido,
    a.icone || null,
    a.cor || null,
    a.numero || null,
    a.phone_number_id || null,
    a.waba_id || null,
    a.token || null,
    id,
    userId
  );
  return getAccount(id);
}

export function deleteAccount(id, userId) {
  const info = db
    .prepare("DELETE FROM whatsapp_accounts WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return info.changes > 0;
}

// ---------- Helpers: runs ----------
// createRun aceita um objeto com todo o contexto do disparo (multi-run + pausa).
export function createRun(opts = {}) {
  const info = db
    .prepare(
      `INSERT INTO runs
        (total, user_id, account_id, pause_at, csv_filename, csv_headers,
         csv_delimiter, var_cols, template_name, language, concurrency,
         skip_duplicates, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`
    )
    .run(
      opts.total || 0,
      opts.userId || null,
      opts.accountId || null,
      opts.pauseAt || null,
      opts.csvFilename || null,
      opts.csvHeaders ? JSON.stringify(opts.csvHeaders) : null,
      opts.csvDelimiter || null,
      opts.varCols ? JSON.stringify(opts.varCols) : null,
      opts.templateName || null,
      opts.language || null,
      opts.concurrency || null,
      opts.skipDuplicates ? 1 : 0
    );
  return info.lastInsertRowid;
}

// Atualiza contadores agregados + dispatched (quantas linhas já foram consumidas).
export function updateRunProgress(runId, { enviados, falhas, pulados, dispatched }) {
  db.prepare(
    "UPDATE runs SET enviados = ?, falhas = ?, pulados = ?, dispatched = ? WHERE id = ?"
  ).run(enviados, falhas, pulados, dispatched, runId);
}

// Compat: usado em pontos que só mexem enviados/falhas.
export function updateRunCounters(runId, { enviados, falhas }) {
  db.prepare("UPDATE runs SET enviados = ?, falhas = ? WHERE id = ?").run(
    enviados,
    falhas,
    runId
  );
}

export function setRunPaused(runId, pauseReason, pauseAt) {
  db.prepare(
    "UPDATE runs SET status = 'paused', pause_reason = ?, pause_at = ? WHERE id = ?"
  ).run(pauseReason || null, pauseAt ?? null, runId);
}

export function setRunStatus(runId, status) {
  db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, runId);
}

export function finishRun(runId, status, motivo) {
  db.prepare(
    "UPDATE runs SET finished_at = CURRENT_TIMESTAMP, status = ?, motivo = ? WHERE id = ?"
  ).run(status, motivo || null, runId);
}

export function getRun(runId) {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
}

// Run + dados da conta (apelido/icone/cor + técnicos) numa query só.
export function getRunWithAccount(runId) {
  return db
    .prepare(
      `SELECT r.*,
              a.apelido    AS acc_apelido,
              a.icone      AS acc_icone,
              a.cor        AS acc_cor,
              a.numero     AS acc_numero,
              a.phone_number_id AS acc_phone_number_id,
              a.waba_id    AS acc_waba_id
       FROM runs r
       LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
       WHERE r.id = ?`
    )
    .get(runId);
}

export function listRuns(limit = 50, userId = null) {
  if (userId) {
    // Isolamento estrito por user. Runs legados (user_id NULL) são atribuídos ao
    // operador principal no boot (backfillRunOwners), então não há mais NULL.
    return db
      .prepare(
        `SELECT r.*, a.apelido AS acc_apelido, a.icone AS acc_icone, a.cor AS acc_cor
         FROM runs r LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
         WHERE r.user_id = ?
         ORDER BY r.started_at DESC LIMIT ?`
      )
      .all(userId, limit);
  }
  return db
    .prepare(
      `SELECT r.*, a.apelido AS acc_apelido, a.icone AS acc_icone, a.cor AS acc_cor
       FROM runs r LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
       ORDER BY r.started_at DESC LIMIT ?`
    )
    .all(limit);
}

// Runs pausados desse user — pra banner "você tem disparos pausados".
export function listPausedRuns(userId) {
  return db
    .prepare(
      `SELECT r.*, a.apelido AS acc_apelido, a.icone AS acc_icone, a.cor AS acc_cor
       FROM runs r LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
       WHERE r.status = 'paused' AND r.user_id = ?
       ORDER BY r.started_at DESC`
    )
    .all(userId);
}

// Atribui runs órfãos (user_id NULL, de antes da feature multi-user) ao operador
// principal — fecha o vazamento de isolamento sem perder o histórico antigo.
export function backfillRunOwners(defaultUser) {
  if (!defaultUser) return 0;
  const info = db
    .prepare("UPDATE runs SET user_id = ? WHERE user_id IS NULL")
    .run(defaultUser);
  return info.changes;
}

// ---------- Helpers: run_results (log de entrega, alimenta relatório + webhook) ----------
export function addRunResult(runId, phone, status, wamid, motivo) {
  db.prepare(
    "INSERT INTO run_results (run_id, phone, status, wamid, motivo) VALUES (?, ?, ?, ?, ?)"
  ).run(runId, phone, status, wamid || null, motivo || null);
}

export function getRunResults(runId, limit = 5000) {
  return db
    .prepare("SELECT * FROM run_results WHERE run_id = ? ORDER BY id LIMIT ?")
    .all(runId, limit);
}

// Atualiza o delivery_status (sent/delivered/read/failed) pelo wamid.
export function updateDeliveryStatusByWamid(wamid, deliveryStatus, deliveryError) {
  if (!wamid) return 0;
  const info = db
    .prepare(
      "UPDATE run_results SET delivery_status = ?, delivery_error = ? WHERE wamid = ?"
    )
    .run(deliveryStatus || null, deliveryError || null, wamid);
  return info.changes;
}

// ---------- Helpers: run_rows (fila de trabalho do run, PARTE 5) ----------
// Insere todas as linhas do snapshot de uma vez (status inicial pending).
export function insertRunRows(runId, rows) {
  const stmt = db.prepare(
    "INSERT INTO run_rows (run_id, idx, phone, parametros, row_json, status) VALUES (?, ?, ?, ?, ?, 'pending')"
  );
  const tx = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  tx.run();
  try {
    for (const r of rows) {
      stmt.run(
        runId,
        r.idx,
        r.phone || null,
        JSON.stringify(r.parametros || []),
        JSON.stringify(r.rowOriginal || {})
      );
    }
    commit.run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
}

export function getRunRowByIdx(runId, idx) {
  return db
    .prepare("SELECT * FROM run_rows WHERE run_id = ? AND idx = ?")
    .get(runId, idx);
}

export function updateRunRowStatus(runId, idx, status, wamid, motivo) {
  db.prepare(
    "UPDATE run_rows SET status = ?, wamid = ?, motivo = ?, ts = CURRENT_TIMESTAMP WHERE run_id = ? AND idx = ?"
  ).run(status, wamid || null, motivo || null, runId, idx);
}

export function getPendingRows(runId) {
  return db
    .prepare(
      "SELECT * FROM run_rows WHERE run_id = ? AND status = 'pending' ORDER BY idx"
    )
    .all(runId);
}

export function getAllRunRows(runId) {
  return db
    .prepare("SELECT * FROM run_rows WHERE run_id = ? ORDER BY idx")
    .all(runId);
}

export function countRunRows(runId) {
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) AS c FROM run_rows WHERE run_id = ? GROUP BY status"
    )
    .all(runId);
  const out = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.c;
    out.total += r.c;
  }
  return out;
}
