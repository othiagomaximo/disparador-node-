// ───────────────────────────────────────────────────────────────────────────
// Camada de banco com 2 backends (prompt 25):
//   - DATABASE_URL setada  → Postgres (Supabase) via `pg` Pool. PERSISTE deploy.
//   - sem DATABASE_URL      → node:sqlite local (dev), mesmo comportamento de antes.
//
// TODAS as funções exportadas são ASYNC (mesmo no SQLite, que é síncrono por baixo)
// — os call sites em index.js e disparo-engine.js usam await.
//
// Placeholders: as queries são escritas com `?` (estilo SQLite); pro Postgres um
// helper converte `?` → `$1..$n`. O SCHEMA é escrito 2x (um bloco por dialeto),
// porque os tipos divergem (AUTOINCREMENT vs IDENTITY, TEXT vs TIMESTAMPTZ).
// ───────────────────────────────────────────────────────────────────────────
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

// ⚠️⚠️ CRÍTICO — SEM TOP-LEVEL AWAIT NESTE ARQUIVO ⚠️⚠️
// A Hostinger (LiteSpeed / lsnode.js) carrega o index.js via require(). Um require()
// NÃO consegue carregar um grafo ESM que tenha top-level await — lança
// ERR_REQUIRE_ASYNC_MODULE e o processo NEM SOBE (503 mudo, log de execução vazio).
// Por isso: pg é carregado via createRequire (síncrono, é CJS), node:sqlite via
// import estático, e o schema é inicializado de forma DEFERIDA (promessa dbReady),
// nunca com `await` no nível do módulo.
const require = createRequire(import.meta.url);

let USE_PG = !!process.env.DATABASE_URL;

let pool = null; // pg
let sqlite = null; // node:sqlite

console.log(`[boot] camada de banco: ${USE_PG ? "POSTGRES (Supabase)" : "SQLITE local"}`);

function initSqliteBackend() {
  const DB_PATH = process.env.DB_PATH || "./data/app.db";
  mkdirSync(dirname(DB_PATH), { recursive: true });
  sqlite = new DatabaseSync(DB_PATH);
}

function initPgBackend() {
  const pg = require("pg"); // CJS, require síncrono — sem top-level await
  // int8/bigint volta como STRING por padrão no node-pg — converte pra number
  // (ids cabem em 2^53), pra bater com o comportamento do SQLite.
  pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase exige TLS
    max: 10,
    // Sem isso, um Postgres inacessível deixaria a 1ª query pendurada.
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (e) => console.error("[pg] pool error:", e?.message || e));
}

if (USE_PG) initPgBackend();
else initSqliteBackend();

// ---------- low-level (async em ambos os backends) ----------
// ⚠️ Converte `?` → `$1..$n` por posição. NÃO entende string literal — portanto
// NUNCA escreva um `?` literal dentro de aspas numa query (use sempre como
// placeholder). Hoje nenhuma query tem `?` literal; mantenha assim.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Garante schema pronto antes de qualquer query pública (initSchema NÃO passa por
// aqui — usa pool/sqlite direto — então não há recursão com dbReady).
let _schemaReady = false;
async function ensureReady() {
  if (_schemaReady) return;
  await dbReady;
  _schemaReady = true;
}

async function rawAll(sql, params = []) {
  await ensureReady();
  if (USE_PG) return (await pool.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}
async function rawGet(sql, params = []) {
  await ensureReady();
  if (USE_PG) return (await pool.query(toPg(sql), params)).rows[0];
  return sqlite.prepare(sql).get(...params);
}
async function rawRun(sql, params = []) {
  await ensureReady();
  if (USE_PG) {
    const res = await pool.query(toPg(sql), params);
    return { changes: res.rowCount };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
}
// INSERT que precisa do id gerado (pg via RETURNING, sqlite via lastInsertRowid).
async function rawInsert(sql, params = [], idCol = "id") {
  await ensureReady();
  if (USE_PG) {
    const res = await pool.query(toPg(sql) + ` RETURNING ${idCol}`, params);
    return { id: res.rows[0][idCol], changes: res.rowCount };
  }
  const info = sqlite.prepare(sql).run(...params);
  return { id: Number(info.lastInsertRowid), changes: info.changes };
}

// ---------- Schema ----------
const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS enviados (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone TEXT NOT NULL,
  account_id BIGINT,
  wamid TEXT,
  template TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS enviados_phone_acct ON enviados(phone, account_id);

CREATE TABLE IF NOT EXISTS runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  total INTEGER DEFAULT 0,
  enviados INTEGER DEFAULT 0,
  falhas INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  motivo TEXT,
  user_id TEXT,
  account_id BIGINT,
  pulados INTEGER DEFAULT 0,
  dispatched INTEGER DEFAULT 0,
  pause_at INTEGER,
  pause_reason TEXT,
  csv_filename TEXT,
  csv_headers TEXT,
  csv_delimiter TEXT,
  var_cols TEXT,
  template_name TEXT,
  language TEXT,
  concurrency INTEGER,
  skip_duplicates INTEGER
);

CREATE TABLE IF NOT EXISTS run_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  wamid TEXT,
  motivo TEXT,
  ts TIMESTAMPTZ DEFAULT now(),
  delivery_status TEXT,
  delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_results_run_id ON run_results(run_id);
CREATE INDEX IF NOT EXISTS idx_run_results_wamid ON run_results(wamid);

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  apelido TEXT NOT NULL,
  icone TEXT,
  cor TEXT,
  numero TEXT,
  phone_number_id TEXT,
  waba_id TEXT,
  token TEXT,
  template_name TEXT,
  language TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_accounts_user ON whatsapp_accounts(user_id);

CREATE TABLE IF NOT EXISTS run_rows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id BIGINT NOT NULL,
  idx INTEGER NOT NULL,
  phone TEXT,
  parametros TEXT,
  row_json TEXT,
  status TEXT DEFAULT 'pending',
  wamid TEXT,
  motivo TEXT,
  ts TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_run_rows_run ON run_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_run_rows_run_status ON run_rows(run_id, status);

-- Prompt 31: valor de vendas POR DIA (dia = 'YYYY-MM-DD' no fuso America/Sao_Paulo).
CREATE TABLE IF NOT EXISTS daily_sales (
  user_id TEXT NOT NULL,
  dia TEXT NOT NULL,
  valor NUMERIC(14,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, dia)
);
`;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS enviados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  account_id INTEGER,
  wamid TEXT,
  template TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS enviados_phone_acct ON enviados(phone, account_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  total INTEGER DEFAULT 0,
  enviados INTEGER DEFAULT 0,
  falhas INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  motivo TEXT,
  user_id TEXT,
  account_id INTEGER,
  pulados INTEGER DEFAULT 0,
  dispatched INTEGER DEFAULT 0,
  pause_at INTEGER,
  pause_reason TEXT,
  csv_filename TEXT,
  csv_headers TEXT,
  csv_delimiter TEXT,
  var_cols TEXT,
  template_name TEXT,
  language TEXT,
  concurrency INTEGER,
  skip_duplicates INTEGER
);

CREATE TABLE IF NOT EXISTS run_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL,
  wamid TEXT,
  motivo TEXT,
  ts TEXT DEFAULT CURRENT_TIMESTAMP,
  delivery_status TEXT,
  delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_results_run_id ON run_results(run_id);
CREATE INDEX IF NOT EXISTS idx_run_results_wamid ON run_results(wamid);

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
  template_name TEXT,
  language TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wa_accounts_user ON whatsapp_accounts(user_id);

CREATE TABLE IF NOT EXISTS run_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  phone TEXT,
  parametros TEXT,
  row_json TEXT,
  status TEXT DEFAULT 'pending',
  wamid TEXT,
  motivo TEXT,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_rows_run ON run_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_run_rows_run_status ON run_rows(run_id, status);

-- Prompt 31: valor de vendas POR DIA (dia = 'YYYY-MM-DD' no fuso America/Sao_Paulo).
CREATE TABLE IF NOT EXISTS daily_sales (
  user_id TEXT NOT NULL,
  dia TEXT NOT NULL,
  valor REAL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, dia)
);
`;

// Adiciona coluna de forma idempotente (bancos antigos do prompt 24).
async function ensureColumn(table, col, typeSqlite, typePg) {
  if (USE_PG) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${typePg}`);
  } else {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeSqlite}`);
    }
  }
}

async function initSchema() {
  if (USE_PG) {
    await pool.query(SCHEMA_PG);
  } else {
    // SQLite dev: se a tabela `enviados` veio do schema antigo (phone PK, sem
    // account_id), recria com a forma nova. Dados de dev são descartáveis.
    const tbl = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='enviados'")
      .get();
    if (tbl) {
      const cols = sqlite.prepare("PRAGMA table_info(enviados)").all();
      if (!cols.some((c) => c.name === "account_id")) {
        sqlite.exec("DROP TABLE enviados");
      }
    }
    sqlite.exec(SCHEMA_SQLITE);
  }
  // Colunas adicionadas depois (idempotente). template/language por conta (PARTE 3),
  // account_id em enviados (PARTE 2) — caso a tabela já existisse na forma certa.
  await ensureColumn("whatsapp_accounts", "template_name", "TEXT", "TEXT");
  await ensureColumn("whatsapp_accounts", "language", "TEXT", "TEXT");
  await ensureColumn("enviados", "account_id", "INTEGER", "BIGINT");
  // PARTE 1.2 (prompt 26): categoria do erro da Meta, pro breakdown agrupado.
  await ensureColumn("run_results", "erro_categoria", "TEXT", "TEXT");
  // PARTE 1 (prompt 28): categoria do erro também no run_rows, pro failed.csv?cat=.
  await ensureColumn("run_rows", "erro_categoria", "TEXT", "TEXT");
  // Prompt 31: arquivar run = só OCULTA da lista (recuperável). Nunca deleta.
  // INTEGER nos 2 dialetos (0/1) pra comparação idêntica; linhas antigas = 0.
  await ensureColumn("runs", "archived", "INTEGER DEFAULT 0", "INTEGER DEFAULT 0");
}

// Inicialização DEFERIDA do schema (SEM top-level await — ver aviso no topo).
// `dbReady` é uma PROMESSA criada agora; o index.js faz `await dbReady` dentro do
// boot async (não no nível do módulo). Toda função pública abaixo também aguarda
// `dbReady` antes de tocar no banco, então uma query que chegue cedo espera o
// schema sem quebrar.
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref?.()),
  ]);
}

async function bootDb() {
  console.log("[boot] inicializando schema do banco...");
  try {
    await withTimeout(initSchema(), 20000, "timeout de 20s ao conectar/inicializar o banco");
    console.log("[boot] schema OK");
  } catch (e) {
    console.error("[boot] ❌ ERRO inicializando o banco:", e?.message || e);
    if (USE_PG) {
      // Postgres inacessível deste servidor → cai pro SQLite efêmero pro site
      // continuar no ar (histórico não persiste, mas não fica 503 mudo).
      console.error("[boot] ⚠️⚠️ FALLBACK: Postgres (DATABASE_URL) INACESSÍVEL deste servidor.");
      console.error("[boot] ⚠️⚠️ Subindo com SQLite local (EFÊMERO — histórico morre em deploy).");
      console.error("[boot] ⚠️⚠️ Verifique DATABASE_URL/firewall e redeploye pra voltar pro Postgres.");
      try {
        pool?.end?.().catch(() => {});
      } catch {}
      pool = null;
      USE_PG = false;
      initSqliteBackend();
      await initSchema();
      console.log("[boot] schema OK (SQLite fallback)");
    } else {
      throw e;
    }
  }
}

// Promessa única — criada SEM await (não é top-level await).
export const dbReady = bootDb();
// Não derruba o processo se a promessa rejeitar antes de alguém dar await nela.
dbReady.catch(() => {});

// ---------- Helpers: config ----------
export async function getConfig(key) {
  const row = await rawGet("SELECT value FROM config WHERE key = ?", [key]);
  return row?.value ?? null;
}
export async function setConfig(key, value) {
  await rawRun(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}
export async function getAllConfig() {
  const rows = await rawAll("SELECT key, value FROM config", []);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

// ---------- Helpers: dedupe (enviados) — POR CONTA (PARTE 2) ----------
export async function isAlreadySent(phone, accountId) {
  const row = await rawGet("SELECT 1 AS x FROM enviados WHERE phone = ? AND account_id = ?", [
    phone,
    accountId ?? null,
  ]);
  return !!row;
}
export async function markSent(phone, accountId, wamid, template) {
  await rawRun(
    `INSERT INTO enviados (phone, account_id, wamid, template) VALUES (?, ?, ?, ?)
     ON CONFLICT (phone, account_id) DO UPDATE SET wamid = excluded.wamid, template = excluded.template, sent_at = CURRENT_TIMESTAMP`,
    [phone, accountId ?? null, wamid || null, template || null]
  );
}

// ---------- Helpers: contas WhatsApp ----------
export async function listAccounts(userId) {
  return rawAll("SELECT * FROM whatsapp_accounts WHERE user_id = ? ORDER BY id", [userId]);
}
export async function getAccount(id) {
  return rawGet("SELECT * FROM whatsapp_accounts WHERE id = ?", [id]);
}
export async function getAccountForUser(id, userId) {
  return rawGet("SELECT * FROM whatsapp_accounts WHERE id = ? AND user_id = ?", [id, userId]);
}
export async function createAccount(userId, a) {
  const { id } = await rawInsert(
    `INSERT INTO whatsapp_accounts
       (user_id, apelido, icone, cor, numero, phone_number_id, waba_id, token, template_name, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      a.apelido,
      a.icone || null,
      a.cor || null,
      a.numero || null,
      a.phone_number_id || null,
      a.waba_id || null,
      a.token || null,
      a.template_name || null,
      a.language || null,
    ]
  );
  return getAccount(id);
}
export async function updateAccount(id, userId, a) {
  // token = COALESCE(?, token): campo vazio MANTÉM o token atual.
  await rawRun(
    `UPDATE whatsapp_accounts SET
       apelido = ?, icone = ?, cor = ?, numero = ?,
       phone_number_id = ?, waba_id = ?, token = COALESCE(?, token),
       template_name = ?, language = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`,
    [
      a.apelido,
      a.icone || null,
      a.cor || null,
      a.numero || null,
      a.phone_number_id || null,
      a.waba_id || null,
      a.token || null,
      a.template_name || null,
      a.language || null,
      id,
      userId,
    ]
  );
  return getAccount(id);
}
export async function deleteAccount(id, userId) {
  const info = await rawRun("DELETE FROM whatsapp_accounts WHERE id = ? AND user_id = ?", [id, userId]);
  return info.changes > 0;
}

// ---------- Helpers: runs ----------
export async function createRun(opts = {}) {
  const { id } = await rawInsert(
    `INSERT INTO runs
       (total, user_id, account_id, pause_at, csv_filename, csv_headers,
        csv_delimiter, var_cols, template_name, language, concurrency,
        skip_duplicates, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
    [
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
      opts.skipDuplicates ? 1 : 0,
    ]
  );
  return id;
}

export async function updateRunProgress(runId, { enviados, falhas, pulados, dispatched }) {
  await rawRun("UPDATE runs SET enviados = ?, falhas = ?, pulados = ?, dispatched = ? WHERE id = ?", [
    enviados,
    falhas,
    pulados,
    dispatched,
    runId,
  ]);
}
export async function updateRunCounters(runId, { enviados, falhas }) {
  await rawRun("UPDATE runs SET enviados = ?, falhas = ? WHERE id = ?", [enviados, falhas, runId]);
}
export async function setRunPaused(runId, pauseReason, pauseAt) {
  await rawRun("UPDATE runs SET status = 'paused', pause_reason = ?, pause_at = ? WHERE id = ?", [
    pauseReason || null,
    pauseAt ?? null,
    runId,
  ]);
}
export async function setRunStatus(runId, status) {
  await rawRun("UPDATE runs SET status = ? WHERE id = ?", [status, runId]);
}
export async function finishRun(runId, status, motivo) {
  await rawRun("UPDATE runs SET finished_at = CURRENT_TIMESTAMP, status = ?, motivo = ? WHERE id = ?", [
    status,
    motivo || null,
    runId,
  ]);
}
export async function getRun(runId) {
  return rawGet("SELECT * FROM runs WHERE id = ?", [runId]);
}
export async function getRunWithAccount(runId) {
  return rawGet(
    `SELECT r.*,
            a.apelido AS acc_apelido, a.icone AS acc_icone, a.cor AS acc_cor,
            a.numero AS acc_numero, a.phone_number_id AS acc_phone_number_id,
            a.waba_id AS acc_waba_id
     FROM runs r LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
     WHERE r.id = ?`,
    [runId]
  );
}
// delivered_cnt = entregues (delivered + read); read_cnt = lidas. Subqueries
// correlacionadas (indexadas por run_id) — pro resuminho 📬/👁 na lista (PARTE 4.5).
const RUN_LIST_COLS = `r.*, a.apelido AS acc_apelido, a.icone AS acc_icone, a.cor AS acc_cor,
  (SELECT COUNT(*) FROM run_results rr WHERE rr.run_id = r.id AND rr.delivery_status IN ('delivered','read')) AS delivered_cnt,
  (SELECT COUNT(*) FROM run_results rr WHERE rr.run_id = r.id AND rr.delivery_status = 'read') AS read_cnt,
  (SELECT COUNT(*) FROM run_results rr WHERE rr.run_id = r.id AND rr.erro_categoria = 'limite') AS limite_cnt`;

// Filtros da lista do Relatório (prompt 31):
//   status: 'completed' | 'paused' | 'aborted' | 'running' | 'erro'
//     'erro' = runs com falhas > 0 (qualquer status) — o critério mais útil pra
//     achar o que precisa reenviar; um run concluído com falha aparece em
//     "Concluídos" E em "Com erro".
//   archived: false (default) esconde os arquivados; true lista SÓ os arquivados.
function runFilterSql(filters = {}) {
  const where = [];
  const params = [];
  where.push("COALESCE(r.archived, 0) = ?");
  params.push(filters.archived ? 1 : 0);
  if (filters.status === "erro") {
    where.push("r.falhas > 0");
  } else if (["completed", "paused", "aborted", "running"].includes(filters.status)) {
    where.push("r.status = ?");
    params.push(filters.status);
  }
  return { where, params };
}

export async function listRuns(limit = 50, userId = null, filters = {}) {
  const { where, params } = runFilterSql(filters);
  if (userId) {
    where.unshift("r.user_id = ?");
    params.unshift(userId);
  }
  return rawAll(
    `SELECT ${RUN_LIST_COLS}
     FROM runs r LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
     WHERE ${where.join(" AND ")}
     ORDER BY r.started_at DESC LIMIT ?`,
    [...params, limit]
  );
}
// Contadores das sub-abas do Relatório (uma query só, isolada por user).
export async function countRunsByTab(userId) {
  const row = await rawGet(
    `SELECT
       SUM(CASE WHEN COALESCE(archived,0) = 0 AND status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN COALESCE(archived,0) = 0 AND status = 'paused' THEN 1 ELSE 0 END) AS paused,
       SUM(CASE WHEN COALESCE(archived,0) = 0 AND falhas > 0 THEN 1 ELSE 0 END) AS erro,
       SUM(CASE WHEN COALESCE(archived,0) = 1 THEN 1 ELSE 0 END) AS archived
     FROM runs WHERE user_id = ?`,
    [userId]
  );
  return {
    completed: Number(row?.completed || 0),
    paused: Number(row?.paused || 0),
    erro: Number(row?.erro || 0),
    archived: Number(row?.archived || 0),
  };
}
// Arquivar/desarquivar com isolamento por user. NUNCA deleta. Retorna false se o
// run não for do user (→ 404 na rota).
export async function setRunArchived(runId, userId, archived) {
  const info = await rawRun("UPDATE runs SET archived = ? WHERE id = ? AND user_id = ?", [
    archived ? 1 : 0,
    runId,
    userId,
  ]);
  return info.changes > 0;
}
export async function listPausedRuns(userId) {
  return rawAll(
    `SELECT r.*, a.apelido AS acc_apelido, a.icone AS acc_icone, a.cor AS acc_cor
     FROM runs r LEFT JOIN whatsapp_accounts a ON a.id = r.account_id
     WHERE r.status = 'paused' AND r.user_id = ? AND COALESCE(r.archived, 0) = 0
     ORDER BY r.started_at DESC`,
    [userId]
  );
}

// ---------- Helpers: painel do dia (prompt 31) ----------
// "dia" = 'YYYY-MM-DD' no fuso America/Sao_Paulo.
// Simplificação: o run conta INTEIRO no dia em que COMEÇOU (started_at). Um run
// pausado ontem e retomado hoje soma tudo em ontem.
// Conversão de fuso:
//   - Postgres: started_at é TIMESTAMPTZ → AT TIME ZONE 'America/Sao_Paulo'.
//   - SQLite: started_at é TEXT em UTC (CURRENT_TIMESTAMP) → date(started_at,
//     '-3 hours'). Exato porque o Brasil não tem horário de verão desde 2019.
// Arquivados CONTAM (arquivar só esconde da lista; o disparo aconteceu).
export async function getDayStats(userId, dia) {
  const dayExpr = USE_PG
    ? "to_char(started_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD')"
    : "date(started_at, '-3 hours')";
  const row = await rawGet(
    `SELECT COUNT(*) AS runs,
            COALESCE(SUM(enviados), 0) AS disparados,
            COALESCE(SUM(falhas), 0) AS falhas,
            COALESCE(SUM(pulados), 0) AS pulados
     FROM runs WHERE user_id = ? AND ${dayExpr} = ?`,
    [userId, dia]
  );
  return {
    runs: Number(row?.runs || 0),
    disparados: Number(row?.disparados || 0),
    falhas: Number(row?.falhas || 0),
    pulados: Number(row?.pulados || 0),
  };
}
export async function getDailySales(userId, dia) {
  const row = await rawGet("SELECT valor FROM daily_sales WHERE user_id = ? AND dia = ?", [userId, dia]);
  return Number(row?.valor || 0); // pg NUMERIC volta string → Number
}
export async function setDailySales(userId, dia, valor) {
  await rawRun(
    `INSERT INTO daily_sales (user_id, dia, valor, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, dia) DO UPDATE SET valor = excluded.valor, updated_at = CURRENT_TIMESTAMP`,
    [userId, dia, valor]
  );
  return getDailySales(userId, dia);
}
export async function backfillRunOwners(defaultUser) {
  if (!defaultUser) return 0;
  const info = await rawRun("UPDATE runs SET user_id = ? WHERE user_id IS NULL", [defaultUser]);
  return info.changes;
}

// No boot, qualquer run com status 'running' é órfão (o processo que o rodava
// morreu — runs ativos só vivem em memória). Converte pra 'paused' pra virar
// recuperável (aparece no banner, retomável do run_rows). Com Postgres isso
// recupera disparos interrompidos por crash/deploy. ⚠️ Assume 1 instância só.
export async function recoverRunningRuns() {
  // Também reconcilia os contadores agregados a partir do run_rows (fonte da
  // verdade) — o throttle de progresso pode ter deixado runs.dispatched/enviados
  // defasados no momento do crash. Subqueries correlacionadas (pg + sqlite).
  const info = await rawRun(
    `UPDATE runs SET
       status = 'paused',
       pause_reason = 'interrompido-por-restart',
       dispatched = (SELECT COUNT(*) FROM run_rows WHERE run_rows.run_id = runs.id AND run_rows.status <> 'pending'),
       enviados   = (SELECT COUNT(*) FROM run_rows WHERE run_rows.run_id = runs.id AND run_rows.status = 'sent'),
       falhas     = (SELECT COUNT(*) FROM run_rows WHERE run_rows.run_id = runs.id AND run_rows.status = 'failed'),
       pulados    = (SELECT COUNT(*) FROM run_rows WHERE run_rows.run_id = runs.id AND run_rows.status = 'skipped')
     WHERE status = 'running'`,
    []
  );
  return info.changes;
}

// ---------- Helpers: run_results (log de entrega) ----------
export async function addRunResult(runId, phone, status, wamid, motivo, categoria = null) {
  await rawRun(
    "INSERT INTO run_results (run_id, phone, status, wamid, motivo, erro_categoria) VALUES (?, ?, ?, ?, ?, ?)",
    [runId, phone, status, wamid || null, motivo || null, categoria || null]
  );
}
export async function getRunResults(runId, limit = 5000) {
  return rawAll("SELECT * FROM run_results WHERE run_id = ? ORDER BY id LIMIT ?", [runId, limit]);
}
// Breakdown agrupado das FALHAS por categoria de erro (PARTE 3.1). GROUP BY no
// banco — eficiente mesmo em listas grandes. Runs antigos (categoria NULL) caem
// em 'outro'. Ordenado desc por contagem.
export async function getErrorBreakdown(runId) {
  return rawAll(
    `SELECT COALESCE(erro_categoria, 'outro') AS categoria, COUNT(*) AS c
     FROM run_results
     WHERE run_id = ? AND status LIKE 'FALHA%'
     GROUP BY COALESCE(erro_categoria, 'outro')
     ORDER BY c DESC`,
    [runId]
  );
}
export async function updateDeliveryStatusByWamid(wamid, deliveryStatus, deliveryError) {
  if (!wamid) return 0;
  const info = await rawRun(
    "UPDATE run_results SET delivery_status = ?, delivery_error = ? WHERE wamid = ?",
    [deliveryStatus || null, deliveryError || null, wamid]
  );
  return info.changes;
}
// Agregados de ENTREGA por run (PARTE 4.3) — vindos do webhook da Meta.
export async function getDeliveryCounts(runId) {
  const rows = await rawAll(
    "SELECT delivery_status, COUNT(*) AS c FROM run_results WHERE run_id = ? GROUP BY delivery_status",
    [runId]
  );
  const out = { accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, hasWebhook: false };
  for (const r of rows) {
    const k = r.delivery_status;
    const c = Number(r.c);
    if (k && k in out) {
      out[k] = c;
      out.hasWebhook = true;
    }
  }
  // accepted = ENVIADO ainda sem nenhum status de entrega do webhook.
  const acc = await rawGet(
    "SELECT COUNT(*) AS c FROM run_results WHERE run_id = ? AND status = 'ENVIADO' AND (delivery_status IS NULL OR delivery_status = '')",
    [runId]
  );
  out.accepted = Number(acc?.c || 0);
  return out;
}

// ---------- Helpers: run_rows (fila de trabalho do run) ----------
export async function insertRunRows(runId, rows) {
  if (!rows.length) return;
  if (USE_PG) {
    // Insert em LOTE multi-values (PARTE 1.4) — NÃO 2700 round-trips. Chunk de
    // 1000 linhas/query pra ficar bem abaixo do teto de params do Postgres.
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let p = 0;
      for (const r of slice) {
        values.push(`($${++p},$${++p},$${++p},$${++p},$${++p},'pending')`);
        params.push(
          runId,
          r.idx,
          r.phone || null,
          JSON.stringify(r.parametros || []),
          JSON.stringify(r.rowOriginal || {})
        );
      }
      await pool.query(
        `INSERT INTO run_rows (run_id, idx, phone, parametros, row_json, status) VALUES ${values.join(",")}`,
        params
      );
    }
  } else {
    const stmt = sqlite.prepare(
      "INSERT INTO run_rows (run_id, idx, phone, parametros, row_json, status) VALUES (?, ?, ?, ?, ?, 'pending')"
    );
    sqlite.exec("BEGIN");
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
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  }
}
export async function getRunRowByIdx(runId, idx) {
  return rawGet("SELECT * FROM run_rows WHERE run_id = ? AND idx = ?", [runId, idx]);
}
export async function updateRunRowStatus(runId, idx, status, wamid, motivo, categoria = null) {
  await rawRun(
    "UPDATE run_rows SET status = ?, wamid = ?, motivo = ?, erro_categoria = ?, ts = CURRENT_TIMESTAMP WHERE run_id = ? AND idx = ?",
    [status, wamid || null, motivo || null, categoria || null, runId, idx]
  );
}
export async function getPendingRows(runId) {
  return rawAll("SELECT * FROM run_rows WHERE run_id = ? AND status = 'pending' ORDER BY idx", [runId]);
}
// Linhas que FALHARAM (status 'failed'), opcionalmente filtradas por categoria de
// erro (prompt 28). Sem cat = todas. cat sem match (runs antigos sem categoria) = vazio.
export async function getFailedRows(runId, cat = null) {
  if (cat) {
    return rawAll(
      "SELECT * FROM run_rows WHERE run_id = ? AND status = 'failed' AND erro_categoria = ? ORDER BY idx",
      [runId, cat]
    );
  }
  return rawAll("SELECT * FROM run_rows WHERE run_id = ? AND status = 'failed' ORDER BY idx", [runId]);
}
export async function getAllRunRows(runId) {
  return rawAll("SELECT * FROM run_rows WHERE run_id = ? ORDER BY idx", [runId]);
}
export async function countRunRows(runId) {
  const rows = await rawAll(
    "SELECT status, COUNT(*) AS c FROM run_rows WHERE run_id = ? GROUP BY status",
    [runId]
  );
  const out = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = Number(r.c);
    out.total += Number(r.c);
  }
  return out;
}

// Diagnóstico simples (usado no boot/log).
export function dbInfo() {
  return { backend: USE_PG ? "postgres" : "sqlite" };
}
