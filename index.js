import "dotenv/config";
import express from "express";
import session from "express-session";
import createMemoryStore from "memorystore";
import multer from "multer";
import bcrypt from "bcryptjs";
import { parse } from "csv-parse/sync";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import {
  setConfig,
  getConfig,
  getAllConfig,
  listRuns,
  getRun,
  getRunWithAccount,
  getRunResults,
  updateDeliveryStatusByWamid,
  listAccounts,
  getAccount,
  getAccountForUser,
  createAccount,
  updateAccount,
  deleteAccount,
  listPausedRuns,
  getPendingRows,
  getAllRunRows,
  countRunRows,
  backfillRunOwners,
} from "./lib/db.js";
import {
  normalizePhoneDetailed,
  forceAdd55,
  forceRemove55,
  cleanPhone,
} from "./lib/normalize.js";
import { requireAuth } from "./lib/auth-middleware.js";
import {
  startDisparo,
  getUserRuns,
  getRunSnapshot,
  pauseRun,
  abortRun,
  resumeRun,
  BUS,
  MAX_PARALLEL_RUNS_PER_USER,
  isDryRun,
} from "./lib/disparo-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

mkdirSync("./data", { recursive: true });
mkdirSync("./uploads", { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const MemoryStore = createMemoryStore(session);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
// no-cache nos assets estáticos (app.js, style.css): força o browser a
// revalidar a cada load. Sem isso, após um deploy o navegador pode rodar
// um app.js ANTIGO em cima do app.html NOVO — handlers órfãos quebram a
// página inteira (regressão de cache, não de código). 304 quando inalterado.
app.use(
  express.static(join(__dirname, "public"), {
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

app.use(
  session({
    store: new MemoryStore({ checkPeriod: 1000 * 60 * 60 * 12 }),
    secret: process.env.SESSION_SECRET || "dev-secret-troque-em-producao",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 24h
      httpOnly: true,
      sameSite: "lax",
    },
  })
);

const upload = multer({ dest: "./uploads/", limits: { fileSize: 30 * 1024 * 1024 } });

const safeParse = (s, fb) => {
  try {
    return JSON.parse(s);
  } catch {
    return fb;
  }
};

// ---------- AUTH ----------
app.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/");
  res.sendFile(join(__dirname, "views", "login.html"));
});

// Lê todos os usuários configurados em env vars + clientes fixos no código.
const HARDCODED_CLIENTS = [
  { user: "cliente1", secret: "Cliente1@2026", isHash: false },
  { user: "cliente2", secret: "Cliente2@2026", isHash: false },
  { user: "cliente3", secret: "Cliente3@2026", isHash: false },
];

function getConfiguredUsers() {
  const users = [];
  function pushIf(userKey, passKey, hashKey) {
    const user = process.env[userKey];
    const plain = process.env[passKey];
    const hash = process.env[hashKey];
    if (!user) return;
    if (plain) {
      users.push({ user, secret: plain, isHash: false });
    } else if (hash) {
      users.push({ user, secret: hash, isHash: true });
    }
  }
  pushIf("LOGIN_USER", "LOGIN_PASSWORD", "LOGIN_PASSWORD_HASH");
  for (let i = 2; i <= 10; i++) {
    pushIf(`LOGIN_USER_${i}`, `LOGIN_PASSWORD_${i}`, `LOGIN_PASSWORD_HASH_${i}`);
  }
  for (const c of HARDCODED_CLIENTS) {
    if (!users.find((u) => u.user === c.user)) users.push(c);
  }
  return users;
}

app.post("/login", async (req, res) => {
  const { user, password } = req.body || {};
  const users = getConfiguredUsers();
  if (!users.length) {
    return res.status(500).send("Nenhum usuário configurado");
  }
  const match = users.find((u) => {
    if (u.user !== user) return false;
    if (u.isHash) return bcrypt.compareSync(password || "", u.secret);
    return password === u.secret;
  });
  if (!match) {
    return res.status(401).sendFile(join(__dirname, "views", "login-fail.html"));
  }
  req.session.user = user;
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------- WEBHOOK META (público — autenticado por verify token) ----------
app.get("/api/webhook", (req, res) => {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (!expected) {
    return res.status(500).send("WHATSAPP_VERIFY_TOKEN não configurado no servidor");
  }
  if (mode === "subscribe" && token === expected) {
    return res.status(200).send(String(challenge ?? ""));
  }
  return res.sendStatus(403);
});

// Recebe atualizações de status (sent/delivered/read/failed) e atualiza
// run_results pelo wamid. Sempre responde 200 — a Meta retenta em loop se não.
app.post("/api/webhook", (req, res) => {
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        const statuses = change?.value?.statuses || [];
        for (const st of statuses) {
          const wamid = st?.id;
          const status = st?.status; // sent | delivered | read | failed
          if (!wamid || !status) continue;
          let deliveryError = null;
          if (status === "failed") {
            const e0 = st?.errors?.[0];
            if (e0) {
              const code = e0.code ?? "?";
              const title = e0.title || e0.message || "";
              deliveryError = `${code}: ${title}`.slice(0, 200);
            }
          }
          updateDeliveryStatusByWamid(wamid, status, deliveryError);
        }
      }
    }
  } catch (e) {
    console.error("webhook parse error:", e?.message || e);
  }
  res.sendStatus(200);
});

// ---------- APP (protegido) ----------
app.use(requireAuth);

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(join(__dirname, "views", "app.html"));
});

// ---------- API: Config (template/idioma/threads — credenciais agora em contas) ----------
app.get("/api/config", (req, res) => {
  const cfg = getAllConfig();
  // Só expõe as chaves de envio (não credenciais legadas/markers internos).
  res.json({
    template_name: cfg.template_name || "",
    language: cfg.language || "pt_BR",
    concurrency: cfg.concurrency || "10",
  });
});

app.post("/api/config", (req, res) => {
  const allowed = ["template_name", "language", "concurrency"];
  for (const k of allowed) {
    if (k in req.body) setConfig(k, String(req.body[k] ?? ""));
  }
  res.json({ ok: true });
});

// ---------- PARTE 1: API de contas WhatsApp (por usuário) ----------
// Migração: user sem contas + config legada (token+phone globais) ganha uma
// "Conta principal" automaticamente, pra ninguém logar e ver a config sumida.
function ensureAccountsForUser(user) {
  const existing = listAccounts(user);
  if (existing.length) return existing;
  if (getConfig(`acct_migrated_${user}`)) return existing; // já migrou antes
  const cfg = getAllConfig();
  if (cfg.access_token && cfg.phone_number_id) {
    createAccount(user, {
      apelido: "Conta principal",
      icone: "📱",
      cor: "#25D366",
      numero: cfg.numero || "",
      phone_number_id: cfg.phone_number_id,
      waba_id: cfg.waba_id || "",
      token: cfg.access_token,
    });
    setConfig(`acct_migrated_${user}`, "1");
    return listAccounts(user);
  }
  return existing;
}

function validateAccount(body) {
  const apelido = String(body?.apelido ?? "").trim();
  if (!apelido) return { error: "Apelido é obrigatório" };
  if (apelido.length > 60) return { error: "Apelido deve ter no máximo 60 caracteres" };
  return {
    data: {
      apelido,
      icone: String(body.icone ?? "").replace(/[<>"&]/g, "").trim().slice(0, 8) || null,
      cor: String(body.cor ?? "").replace(/[^#\w(),.% ]/g, "").trim().slice(0, 20) || null,
      numero: String(body.numero ?? "").trim().slice(0, 40) || null,
      phone_number_id: String(body.phone_number_id ?? "").trim().slice(0, 60) || null,
      waba_id: String(body.waba_id ?? "").trim().slice(0, 60) || null,
      token: String(body.token ?? "").trim() || null,
    },
  };
}

app.get("/api/accounts", (req, res) => {
  // NUNCA devolve o token Meta pro cliente — só sinaliza se já está preenchido
  // (has_token). Editar a conta sem redigitar o token preserva (COALESCE no DB).
  const accounts = ensureAccountsForUser(req.session.user).map(({ token, ...a }) => ({
    ...a,
    has_token: !!token,
  }));
  res.json(accounts);
});

app.post("/api/accounts", (req, res) => {
  const user = req.session.user;
  const v = validateAccount(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const id = req.body?.id ? Number(req.body.id) : null;
  if (id) {
    const owned = getAccountForUser(id, user);
    if (!owned) return res.status(404).json({ error: "Conta não encontrada" });
    return res.json({ ok: true, account: updateAccount(id, user, v.data) });
  }
  res.json({ ok: true, account: createAccount(user, v.data) });
});

app.delete("/api/accounts/:id", (req, res) => {
  const ok = deleteAccount(Number(req.params.id), req.session.user);
  if (!ok) return res.status(404).json({ error: "Conta não encontrada" });
  res.json({ ok: true });
});

// ---------- API: CSV upload + parse (PARTE 3.6: buffer POR USUÁRIO) ----------
const CSV_BUFFERS = new Map(); // key: userId → buffer (1 por user/sessão)
const getBuf = (req) => CSV_BUFFERS.get(req.session.user) || null;

function guessPhoneCol(headers) {
  return headers.find((h) => /celular|telefone|phone|whatsapp|fone|tel\b/i.test(h)) || null;
}

function applyNormalization(buf, phoneCol) {
  if (!buf) return;
  buf.rows = buf.rowsOriginal.map((r) => ({ ...r }));
  buf.phoneCol = phoneCol;
  for (const row of buf.rows) {
    const original = row[phoneCol] ?? "";
    const d = normalizePhoneDetailed(original);
    row.__phoneOriginal = original;
    row[phoneCol] = d.normalized;
    row.__norm = { changed: d.changed, reason: d.reason };
  }
}

function applyBulk(buf, phoneCol, action) {
  if (!buf) return;
  buf.rows = buf.rowsOriginal.map((r) => ({ ...r }));
  buf.phoneCol = phoneCol;
  for (const row of buf.rows) {
    const original = row[phoneCol] ?? "";
    const after = action === "add55" ? forceAdd55(original) : forceRemove55(original);
    row.__phoneOriginal = original;
    row[phoneCol] = after;
    const cleanedOrig = cleanPhone(original);
    row.__norm = {
      changed: after !== cleanedOrig,
      reason: action === "add55" ? "forced-add55" : "forced-remove55",
    };
  }
}

function buildNormPreview(buf, limit = 50) {
  const rows = buf?.rows || [];
  const stats = { total: rows.length, added55: 0, already55: 0, invalid: 0, empty: 0 };
  for (const row of rows) {
    const r = row.__norm?.reason;
    if (r === "added-55" || r === "forced-add55") stats.added55++;
    else if (r === "already-55") stats.already55++;
    else if (r === "invalid-length") stats.invalid++;
    else if (r === "empty") stats.empty++;
  }
  return {
    phoneCol: buf?.phoneCol || null,
    headers: buf?.headers || [],
    stats,
    total: rows.length,
    preview: rows.slice(0, limit),
  };
}

app.post("/api/csv/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo faltando" });
  try {
    const raw = require("node:fs").readFileSync(req.file.path, "utf-8");
    require("node:fs").unlinkSync(req.file.path);
    const firstLine = raw.split(/\r?\n/)[0] || "";
    const delim = (firstLine.match(/;/g)?.length || 0) >= (firstLine.match(/,/g)?.length || 0) ? ";" : ",";
    const rows = parse(raw, {
      delimiter: delim,
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
    });
    if (!rows.length) return res.status(400).json({ error: "CSV vazio" });
    const headers = Object.keys(rows[0]);
    const buf = {
      filename: req.file.originalname,
      headers,
      delimiter: delim,
      rows: rows.map((r) => ({ ...r })),
      rowsOriginal: rows.map((r) => ({ ...r })),
      phoneCol: null,
    };
    CSV_BUFFERS.set(req.session.user, buf);
    const phoneCol = guessPhoneCol(headers) || headers[0] || null;
    if (phoneCol) applyNormalization(buf, phoneCol);
    const np = buildNormPreview(buf);
    res.json({
      ok: true,
      filename: buf.filename,
      headers,
      phoneCol: np.phoneCol,
      stats: np.stats,
      preview: np.preview,
      total: rows.length,
      delimiter: delim,
    });
  } catch (e) {
    res.status(400).json({ error: `Erro lendo CSV: ${e.message}` });
  }
});

app.post("/api/csv/normalize", (req, res) => {
  const buf = getBuf(req);
  if (!buf) return res.status(400).json({ error: "Suba o CSV primeiro" });
  const { phoneCol } = req.body || {};
  if (!phoneCol || !buf.headers.includes(phoneCol)) {
    return res.status(400).json({ error: "Coluna de telefone inválida" });
  }
  applyNormalization(buf, phoneCol);
  res.json({ ok: true, ...buildNormPreview(buf) });
});

app.post("/api/normalize-bulk", (req, res) => {
  const buf = getBuf(req);
  if (!buf) return res.status(400).json({ error: "Suba o CSV primeiro" });
  const { action } = req.body || {};
  if (action !== "add55" && action !== "remove55") {
    return res.status(400).json({ error: "action deve ser 'add55' ou 'remove55'" });
  }
  const phoneCol = buf.phoneCol || guessPhoneCol(buf.headers);
  if (!phoneCol) return res.status(400).json({ error: "Coluna de telefone não definida" });
  applyBulk(buf, phoneCol, action);
  res.json({ ok: true, ...buildNormPreview(buf) });
});

app.get("/api/csv/current", (req, res) => {
  const buf = getBuf(req);
  if (!buf) return res.json({ loaded: false });
  const np = buildNormPreview(buf);
  res.json({
    loaded: true,
    filename: buf.filename,
    headers: buf.headers,
    phoneCol: np.phoneCol,
    stats: np.stats,
    preview: np.preview,
    total: buf.rows.length,
  });
});

// ---------- API: Disparo ----------
app.get("/api/disparo/preview-first", (req, res) => {
  const buf = getBuf(req);
  if (!buf || !buf.rows.length) {
    return res.status(400).json({ error: "Suba CSV primeiro" });
  }
  const cfg = getAllConfig();
  const phoneCol = req.query.phoneCol || buf.phoneCol || guessPhoneCol(buf.headers);
  const varCols = req.query.varCols
    ? String(req.query.varCols).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const row = buf.rows[0];
  const phone = phoneCol ? cleanPhone(row[phoneCol]) : "";
  const variables = varCols.map((c, i) => ({ index: i + 1, column: c, value: row[c] ?? "" }));
  res.json({
    phone,
    template_name: cfg.template_name || null,
    language: cfg.language || "pt_BR",
    variables,
  });
});

// Inicia um disparo. Faz SNAPSHOT do CSV do user (PARTE 3.6) — depois disso o
// run vive independente do CSV_BUFFER. Exige accountId (PARTE 1) e aceita
// pauseAt opcional (PARTE 5).
app.post("/api/disparo/start", (req, res) => {
  const user = req.session.user;
  const buf = getBuf(req);
  if (!buf) return res.status(400).json({ error: "Suba o CSV primeiro" });
  const cfg = getAllConfig();
  if (!cfg.template_name) return res.status(400).json({ error: "Configure o nome do template (aba 1)" });

  const { phoneCol, varCols, skipDuplicates, accountId, pauseAt } = req.body || {};
  if (!accountId) return res.status(400).json({ error: "Escolha a conta WhatsApp pra disparar" });
  const account = getAccountForUser(Number(accountId), user);
  if (!account) return res.status(400).json({ error: "Conta inválida" });
  if (!account.token || !account.phone_number_id) {
    return res.status(400).json({ error: `A conta "${account.apelido}" está sem token ou Phone Number ID` });
  }
  if (!phoneCol) return res.status(400).json({ error: "Mapeie a coluna do telefone" });
  const skip = skipDuplicates === undefined || skipDuplicates === null ? true : !!skipDuplicates;

  if (buf.phoneCol !== phoneCol) applyNormalization(buf, phoneCol);

  const leads = [];
  let invalidos = 0;
  for (let i = 0; i < buf.rows.length; i++) {
    const row = buf.rows[i];
    const phone = cleanPhone(row[phoneCol]);
    if (!phone || phone.length < 10) {
      invalidos++;
      continue;
    }
    const parametros = (varCols || []).map((c) => row[c] ?? "");
    leads.push({ phone, parametros, rowOriginal: buf.rowsOriginal[i] || {} });
  }
  if (!leads.length) return res.status(400).json({ error: "Nenhum telefone válido no CSV" });

  const paNum = parseInt(pauseAt, 10);
  const pauseAtVal = Number.isFinite(paNum) && paNum > 0 ? paNum : null;

  try {
    const { runId, snapshot } = startDisparo(leads, {
      userId: user,
      account: {
        id: account.id,
        apelido: account.apelido,
        icone: account.icone,
        cor: account.cor,
        numero: account.numero,
        phone_number_id: account.phone_number_id,
        waba_id: account.waba_id,
        token: account.token,
      },
      templateName: cfg.template_name,
      language: cfg.language || "pt_BR",
      concurrency: Number(cfg.concurrency) || 10,
      skipDuplicates: skip,
      pauseAt: pauseAtVal,
      csvFilename: buf.filename,
      csvHeaders: buf.headers,
      csvDelimiter: buf.delimiter || ",",
      varCols: varCols || [],
    });
    res.json({ ok: true, runId, total: leads.length, invalidos, skipDuplicates: skip, pauseAt: pauseAtVal, snapshot });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Runs ativos (em memória) deste user — pra renderizar os cards no load.
app.get("/api/disparo/active", (req, res) => {
  res.json({ runs: getUserRuns(req.session.user), maxParallel: MAX_PARALLEL_RUNS_PER_USER, dryRun: isDryRun() });
});

// Runs pausados (do banco) — pra banner "você tem disparos pausados".
app.get("/api/disparo/my-paused-runs", (req, res) => {
  res.json(listPausedRuns(req.session.user));
});

// SSE multiplexado: 1 conexão, eventos de todos os runs do user (cada um com runId).
app.get("/api/disparo/stream", (req, res) => {
  const user = req.session.user;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  for (const s of getUserRuns(user)) {
    res.write(`data: ${JSON.stringify({ type: "status", runId: s.runId, stats: s })}\n\n`);
  }

  const onEvent = (e) => {
    if (e.userId === user) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  BUS.on("event", onEvent);

  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on("close", () => {
    clearInterval(ping);
    BUS.off("event", onEvent);
  });
});

// Detalhe de um run (modal de relatório / pausa) — inclui apelido/icone/cor +
// dados técnicos da conta + stats + últimos resultados.
app.get("/api/disparo/run/:id", (req, res) => {
  const user = req.session.user;
  const run = getRunWithAccount(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).json({ error: "Run não encontrado" });
  const counts = countRunRows(run.id);
  const results = getRunResults(run.id);
  const live = getRunSnapshot(user, run.id);
  res.json({
    run: {
      id: run.id,
      status: live?.status || run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      total: run.total,
      enviados: run.enviados,
      falhas: run.falhas,
      pulados: run.pulados,
      dispatched: run.dispatched,
      pending: counts.pending,
      pauseAt: run.pause_at,
      pauseReason: run.pause_reason,
      filename: run.csv_filename,
      motivo: run.motivo,
      apelido: run.acc_apelido,
      icone: run.acc_icone,
      cor: run.acc_cor,
      numero: run.acc_numero,
      phone_number_id: run.acc_phone_number_id,
      waba_id: run.acc_waba_id,
    },
    counts,
    results,
  });
});

app.post("/api/disparo/run/:id/pause", (req, res) => {
  try {
    res.json({ ok: true, snapshot: pauseRun(req.session.user, Number(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/disparo/run/:id/abort", (req, res) => {
  try {
    res.json({ ok: true, ...abortRun(req.session.user, Number(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/disparo/run/:id/resume", (req, res) => {
  try {
    const { count } = req.body || {};
    res.json({ ok: true, snapshot: resumeRun(req.session.user, Number(req.params.id), count) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// CSV dos NÃO disparados — header/colunas/separador idênticos ao importado,
// valores ORIGINAIS, filtrado pras linhas ainda pendentes. Pra reimportar.
app.get("/api/disparo/run/:id/pending.csv", (req, res) => {
  const user = req.session.user;
  const run = getRun(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).send("Not found");
  const headers = safeParse(run.csv_headers, []);
  const delim = run.csv_delimiter || ",";
  const rows = getPendingRows(run.id).map((r) => safeParse(r.row_json, {}));
  const csv = buildDelimitedCsv(headers, rows, delim);
  const base = safeFilename(run.csv_filename, run.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}_pendentes.csv"`);
  res.send("\uFEFF" + csv);
});

// CSV completo (todas as linhas originais do snapshot do run), mesmo formato.
app.get("/api/disparo/run/:id/all.csv", (req, res) => {
  const user = req.session.user;
  const run = getRun(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).send("Not found");
  const headers = safeParse(run.csv_headers, []);
  const delim = run.csv_delimiter || ",";
  const rows = getAllRunRows(run.id).map((r) => safeParse(r.row_json, {}));
  const csv = buildDelimitedCsv(headers, rows, delim);
  const base = safeFilename(run.csv_filename, run.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}_completo.csv"`);
  res.send("\uFEFF" + csv);
});

// Base de nome de arquivo seguro pro header Content-Disposition. O nome vem do
// upload (req.file.originalname, NÃO sanitizado por multer) — remove aspas,
// ponto-e-vírgula e quebras pra não injetar parâmetros no header.
function safeFilename(rawName, runId) {
  const base = String(rawName || `run_${runId}`)
    .replace(/\.csv$/i, "")
    .replace(/[^\w\-. ]+/g, "_")
    .slice(0, 100)
    .trim();
  return base || `run_${runId}`;
}

function buildDelimitedCsv(headers, rowsObjs, delimiter) {
  const delim = delimiter || ",";
  const esc = (v) => {
    const s = String(v ?? "");
    if (s.includes(delim) || s.includes('"') || /[\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.map(esc).join(delim)];
  for (const row of rowsObjs) lines.push(headers.map((h) => esc(row[h])).join(delim));
  return lines.join("\r\n");
}

// ---------- API: Relatórios ----------
app.get("/api/runs", (req, res) => {
  res.json(listRuns(50, req.session.user));
});

app.get("/api/runs/:id", (req, res) => {
  const run = getRunWithAccount(Number(req.params.id));
  if (!run || run.user_id !== req.session.user) {
    return res.status(404).json({ error: "Run não encontrada" });
  }
  const results = getRunResults(run.id);
  res.json({ run, results });
});

// CSV no formato de RELATÓRIO (telefone;status;wamid;...) — log de entrega.
app.get("/api/runs/:id/download", (req, res) => {
  const run = getRun(Number(req.params.id));
  if (!run || run.user_id !== req.session.user) return res.status(404).send("Not found");
  const results = getRunResults(run.id);
  const lines = ["telefone;status;wamid;motivo;delivery_status;delivery_error;ts"];
  const clean = (s) => (s || "").replace(/[\r\n;]/g, " ");
  for (const r of results) {
    lines.push(
      `${r.phone};${r.status};${r.wamid || ""};${clean(r.motivo)};${r.delivery_status || ""};${clean(r.delivery_error)};${r.ts}`
    );
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="relatorio_run_${run.id}.csv"`);
  res.send(lines.join("\n"));
});

// ---------- Health ----------
app.get("/healthz", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Atribui runs órfãos (user_id NULL, de antes do multi-user) ao operador
// principal — fecha o vazamento de isolamento sem perder histórico. Roda 1x no boot.
(() => {
  const primary = process.env.LOGIN_USER || HARDCODED_CLIENTS[0]?.user;
  const moved = backfillRunOwners(primary);
  if (moved) console.log(`  🔒 ${moved} run(s) legado(s) atribuído(s) a "${primary}"`);
})();

app.listen(PORT, () => {
  console.log(`\n  🚀 Disparador Node rodando em http://localhost:${PORT}`);
  console.log(`  📁 SQLite em ./data/app.db`);
  if (isDryRun()) console.log(`  🧪 DRY-RUN ligado (DISPARO_DRY_RUN=1) — não envia de verdade`);
  const users = getConfiguredUsers();
  if (!users.length) {
    console.log(`  ⚠️  Nenhum usuário configurado!\n`);
  } else {
    console.log(`  👤 Usuários autorizados (${users.length}):`);
    for (const u of users) console.log(`     - ${u.user}`);
    console.log("");
  }
});
