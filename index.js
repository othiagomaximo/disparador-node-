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
  getDeliveryCounts,
  getErrorBreakdown,
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
  recoverRunningRuns,
  dbInfo,
  dbReady,
} from "./lib/db.js";
import {
  normalizePhoneDetailed,
  forceAdd55,
  forceRemove55,
  cleanPhone,
} from "./lib/normalize.js";
import { requireAuth } from "./lib/auth-middleware.js";
import { CATEGORIAS } from "./lib/meta-errors.js";
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
    cookie: { maxAge: 1000 * 60 * 60 * 24, httpOnly: true, sameSite: "lax" },
  })
);

const upload = multer({ dest: "./uploads/", limits: { fileSize: 30 * 1024 * 1024 } });

const safeParse = (s, fb) => {
  if (typeof s !== "string" || s === "") return fb;
  try {
    const v = JSON.parse(s);
    return v == null ? fb : v;
  } catch {
    return fb;
  }
};

// Wrapper que captura erros de handlers async e devolve 500 (em vez de pendurar).
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- AUTH ----------
app.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/");
  res.sendFile(join(__dirname, "views", "login.html"));
});

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
    if (plain) users.push({ user, secret: plain, isHash: false });
    else if (hash) users.push({ user, secret: hash, isHash: true });
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

app.post("/login", (req, res) => {
  const { user, password } = req.body || {};
  const users = getConfiguredUsers();
  if (!users.length) return res.status(500).send("Nenhum usuário configurado");
  const match = users.find((u) => {
    if (u.user !== user) return false;
    if (u.isHash) return bcrypt.compareSync(password || "", u.secret);
    return password === u.secret;
  });
  if (!match) return res.status(401).sendFile(join(__dirname, "views", "login-fail.html"));
  req.session.user = user;
  res.redirect("/");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---------- WEBHOOK META (público — verify token) ----------
app.get("/api/webhook", (req, res) => {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (!expected) return res.status(500).send("WHATSAPP_VERIFY_TOKEN não configurado no servidor");
  if (mode === "subscribe" && token === expected) return res.status(200).send(String(challenge ?? ""));
  return res.sendStatus(403);
});

// Atualizações de status (sent/delivered/read/failed). Responde 200 IMEDIATO
// (Meta reenvia se não receber 200 rápido) e processa TODOS os statuses do
// batch em background. PARTE 4.1/4.2.
app.post("/api/webhook", (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const entries = req.body?.entry || [];
      for (const entry of entries) {
        for (const change of entry?.changes || []) {
          for (const st of change?.value?.statuses || []) {
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
            // try/catch POR status: um wamid que falha (ex.: hiccup do DB) não
            // pode parar o resto do batch — a Meta já recebeu o 200, não reenvia.
            try {
              await updateDeliveryStatusByWamid(wamid, status, deliveryError);
            } catch (e) {
              console.error(`webhook update ${wamid} falhou:`, e?.message || e);
            }
          }
        }
      }
    } catch (e) {
      console.error("webhook process error:", e?.message || e);
    }
  })();
});

// ---------- APP (protegido) ----------
app.use(requireAuth);

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(join(__dirname, "views", "app.html"));
});

// ---------- API: Config (template/idioma globais = FALLBACK; threads) ----------
app.get("/api/config", wrap(async (req, res) => {
  const cfg = await getAllConfig();
  res.json({
    template_name: cfg.template_name || "",
    language: cfg.language || "pt_BR",
    concurrency: cfg.concurrency || "10",
  });
}));

app.post("/api/config", wrap(async (req, res) => {
  for (const k of ["template_name", "language", "concurrency"]) {
    if (k in req.body) await setConfig(k, String(req.body[k] ?? ""));
  }
  res.json({ ok: true });
}));

// ---------- API de contas WhatsApp (por usuário) ----------
async function ensureAccountsForUser(user) {
  const existing = await listAccounts(user);
  if (existing.length) return existing;
  if (await getConfig(`acct_migrated_${user}`)) return existing;
  const cfg = await getAllConfig();
  if (cfg.access_token && cfg.phone_number_id) {
    await createAccount(user, {
      apelido: "Conta principal",
      icone: "📱",
      cor: "#25D366",
      numero: cfg.numero || "",
      phone_number_id: cfg.phone_number_id,
      waba_id: cfg.waba_id || "",
      token: cfg.access_token,
      template_name: cfg.template_name || "",
      language: cfg.language || "",
    });
    await setConfig(`acct_migrated_${user}`, "1");
    return await listAccounts(user);
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
      template_name: String(body.template_name ?? "").trim().slice(0, 120) || null,
      language: String(body.language ?? "").trim().slice(0, 20) || null,
    },
  };
}

app.get("/api/accounts", wrap(async (req, res) => {
  // NUNCA devolve o token Meta — só has_token. Editar sem redigitar preserva.
  const accounts = (await ensureAccountsForUser(req.session.user)).map(({ token, ...a }) => ({
    ...a,
    has_token: !!token,
  }));
  res.json(accounts);
}));

app.post("/api/accounts", wrap(async (req, res) => {
  const user = req.session.user;
  const v = validateAccount(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const id = req.body?.id ? Number(req.body.id) : null;
  if (id) {
    const owned = await getAccountForUser(id, user);
    if (!owned) return res.status(404).json({ error: "Conta não encontrada" });
    return res.json({ ok: true, account: await updateAccount(id, user, v.data) });
  }
  res.json({ ok: true, account: await createAccount(user, v.data) });
}));

app.delete("/api/accounts/:id", wrap(async (req, res) => {
  const ok = await deleteAccount(Number(req.params.id), req.session.user);
  if (!ok) return res.status(404).json({ error: "Conta não encontrada" });
  res.json({ ok: true });
}));

// ---------- API: CSV upload (buffer POR USUÁRIO, em memória) ----------
const CSV_BUFFERS = new Map();
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

// Resolve template/idioma de um disparo: o da CONTA tem prioridade; senão o
// global (config). PARTE 3.3.
async function resolveTemplate(account) {
  const cfg = await getAllConfig();
  return {
    template_name: account?.template_name || cfg.template_name || "",
    language: account?.language || cfg.language || "pt_BR",
  };
}

// ---------- API: Disparo ----------
app.get("/api/disparo/preview-first", wrap(async (req, res) => {
  const buf = getBuf(req);
  if (!buf || !buf.rows.length) return res.status(400).json({ error: "Suba CSV primeiro" });
  // Template da conta selecionada (fallback global) — PARTE 3.4.
  let account = null;
  if (req.query.accountId) account = await getAccountForUser(Number(req.query.accountId), req.session.user);
  const { template_name, language } = await resolveTemplate(account);
  const phoneCol = req.query.phoneCol || buf.phoneCol || guessPhoneCol(buf.headers);
  const varCols = req.query.varCols
    ? String(req.query.varCols).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const row = buf.rows[0];
  const phone = phoneCol ? cleanPhone(row[phoneCol]) : "";
  const variables = varCols.map((c, i) => ({ index: i + 1, column: c, value: row[c] ?? "" }));
  res.json({ phone, template_name: template_name || null, language, variables });
}));

app.post("/api/disparo/start", wrap(async (req, res) => {
  const user = req.session.user;
  const buf = getBuf(req);
  if (!buf) return res.status(400).json({ error: "Suba o CSV primeiro" });

  const { phoneCol, varCols, skipDuplicates, accountId, pauseAt } = req.body || {};
  if (!accountId) return res.status(400).json({ error: "Escolha a conta WhatsApp pra disparar" });
  const account = await getAccountForUser(Number(accountId), user);
  if (!account) return res.status(400).json({ error: "Conta inválida" });
  if (!account.token || !account.phone_number_id) {
    return res.status(400).json({ error: `A conta "${account.apelido}" está sem token ou Phone Number ID` });
  }
  // Template da conta (fallback global). PARTE 3.3.
  const { template_name, language } = await resolveTemplate(account);
  if (!template_name) {
    return res.status(400).json({ error: `Defina um template na conta "${account.apelido}" ou no template global (aba 1)` });
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
  const cfg = await getAllConfig();

  try {
    const { runId, snapshot } = await startDisparo(leads, {
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
      templateName: template_name,
      language,
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
}));

app.get("/api/disparo/active", (req, res) => {
  res.json({ runs: getUserRuns(req.session.user), maxParallel: MAX_PARALLEL_RUNS_PER_USER, dryRun: isDryRun() });
});

app.get("/api/disparo/my-paused-runs", wrap(async (req, res) => {
  res.json(await listPausedRuns(req.session.user));
}));

// SSE multiplexado: 1 conexão, eventos de todos os runs do user.
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

// Detalhe de um run (modal) — conta + stats + agregados de ENTREGA (webhook).
app.get("/api/disparo/run/:id", wrap(async (req, res) => {
  const user = req.session.user;
  const run = await getRunWithAccount(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).json({ error: "Run não encontrado" });
  const [counts, results, deliveryCounts, rawBreakdown] = await Promise.all([
    countRunRows(run.id),
    getRunResults(run.id),
    getDeliveryCounts(run.id),
    getErrorBreakdown(run.id),
  ]);
  const live = getRunSnapshot(user, run.id);
  // PARTE 3: breakdown agrupado das falhas + alerta de limite.
  const errorBreakdown = rawBreakdown.map((b) => ({
    categoria: b.categoria,
    label: (CATEGORIAS[b.categoria] || CATEGORIAS.outro).label,
    short: (CATEGORIAS[b.categoria] || CATEGORIAS.outro).short,
    emoji: (CATEGORIAS[b.categoria] || CATEGORIAS.outro).emoji,
    count: Number(b.c),
  }));
  const totalFalhas = errorBreakdown.reduce((s, b) => s + b.count, 0);
  const limiteCount = errorBreakdown.find((b) => b.categoria === "limite")?.count || 0;
  const limitAlert =
    limiteCount >= 20 || (totalFalhas > 0 && limiteCount / totalFalhas >= 0.3);
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
      template_name: run.template_name,
      motivo: run.motivo,
      account_id: run.account_id,
      apelido: run.acc_apelido,
      icone: run.acc_icone,
      cor: run.acc_cor,
      numero: run.acc_numero,
      phone_number_id: run.acc_phone_number_id,
      waba_id: run.acc_waba_id,
    },
    counts,
    deliveryCounts,
    errorBreakdown,
    limitAlert: { ativo: limitAlert, limiteCount, totalFalhas },
    results,
  });
}));

app.post("/api/disparo/run/:id/pause", wrap(async (req, res) => {
  try {
    res.json({ ok: true, snapshot: await pauseRun(req.session.user, Number(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post("/api/disparo/run/:id/abort", wrap(async (req, res) => {
  try {
    res.json({ ok: true, ...(await abortRun(req.session.user, Number(req.params.id))) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post("/api/disparo/run/:id/resume", wrap(async (req, res) => {
  try {
    const { count } = req.body || {};
    res.json({ ok: true, snapshot: await resumeRun(req.session.user, Number(req.params.id), count) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// CSV dos NÃO disparados — idêntico ao import, valores ORIGINAIS, só pendentes.
app.get("/api/disparo/run/:id/pending.csv", wrap(async (req, res) => {
  const user = req.session.user;
  const run = await getRun(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).send("Not found");
  const headers = safeParse(run.csv_headers, []);
  const delim = run.csv_delimiter || ",";
  const rows = (await getPendingRows(run.id)).map((r) => safeParse(r.row_json, {}));
  const csv = buildDelimitedCsv(headers, rows, delim);
  const base = safeFilename(run.csv_filename, run.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}_pendentes.csv"`);
  res.send("\uFEFF" + csv);
}));

app.get("/api/disparo/run/:id/all.csv", wrap(async (req, res) => {
  const user = req.session.user;
  const run = await getRun(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).send("Not found");
  const headers = safeParse(run.csv_headers, []);
  const delim = run.csv_delimiter || ",";
  const rows = (await getAllRunRows(run.id)).map((r) => safeParse(r.row_json, {}));
  const csv = buildDelimitedCsv(headers, rows, delim);
  const base = safeFilename(run.csv_filename, run.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}_completo.csv"`);
  res.send("\uFEFF" + csv);
}));

function safeFilename(rawName, runId) {
  const base = String(rawName || `run_${runId}`)
    .replace(/\.csv$/i, "")
    .replace(/[^\w\-. ]+/g, "_")
    .slice(0, 100)
    .trim();
  return base || `run_${runId}`;
}

// PARTE 1 (prompt 27) — CORTE MANUAL.
// N conta a POSIÇÃO entre os ENVIADOS (status 'sent'), na ordem do CSV (idx).
// Acha o idx da N-ésima linha enviada → idxCorte (inclusive). rows já vem por idx.
//  - N vazio  → default = total de enviados (corte no último enviado).
//  - N < 1    → erro.
//  - N ≥ enviados → idxCorte = idx do último enviado.
//  - 0 enviados → idxCorte = -1 (nada disparou: sent vazio, resend = tudo).
function computeIdxCorte(rows, nRaw) {
  const enviados = rows.filter((r) => r.status === "sent"); // já em ordem de idx
  let n;
  if (nRaw == null || String(nRaw).trim() === "") {
    n = enviados.length; // default
  } else {
    n = parseInt(nRaw, 10);
    if (!Number.isFinite(n) || n < 1) return { error: "Informe um número >= 1" };
  }
  let idxCorte;
  if (enviados.length === 0) {
    idxCorte = -1;
  } else {
    const k = Math.min(n, enviados.length); // se N ≥ enviados, pega o último
    idxCorte = enviados[k - 1].idx;
  }
  return { idxCorte, enviadosCount: enviados.length, n };
}

// Os que DISPARARAM (1 a N): linhas 'sent' com idx <= idxCorte.
app.get("/api/disparo/run/:id/sent.csv", wrap(async (req, res) => {
  const user = req.session.user;
  const run = await getRun(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).send("Not found");
  const allRows = await getAllRunRows(run.id);
  const cut = computeIdxCorte(allRows, req.query.upto);
  if (cut.error) return res.status(400).json({ error: cut.error });
  const headers = safeParse(run.csv_headers, []);
  const delim = run.csv_delimiter || ",";
  const rows = allRows
    .filter((r) => r.status === "sent" && r.idx <= cut.idxCorte)
    .map((r) => safeParse(r.row_json, {}));
  const csv = buildDelimitedCsv(headers, rows, delim);
  const base = safeFilename(run.csv_filename, run.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}_disparados_1-a-${cut.n}.csv"`);
  res.send("\uFEFF" + csv);
}));

// Os que NÃO dispararam (N+1 em diante): TODAS as linhas com idx > idxCorte.
app.get("/api/disparo/run/:id/resend.csv", wrap(async (req, res) => {
  const user = req.session.user;
  const run = await getRun(Number(req.params.id));
  if (!run || run.user_id !== user) return res.status(404).send("Not found");
  const allRows = await getAllRunRows(run.id);
  const cut = computeIdxCorte(allRows, req.query.after);
  if (cut.error) return res.status(400).json({ error: cut.error });
  const headers = safeParse(run.csv_headers, []);
  const delim = run.csv_delimiter || ",";
  const rows = allRows
    .filter((r) => r.idx > cut.idxCorte)
    .map((r) => safeParse(r.row_json, {}));
  const csv = buildDelimitedCsv(headers, rows, delim);
  const base = safeFilename(run.csv_filename, run.id);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${base}_reenviar_apos-${cut.n}.csv"`);
  res.send("\uFEFF" + csv);
}));

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
app.get("/api/runs", wrap(async (req, res) => {
  res.json(await listRuns(50, req.session.user));
}));

app.get("/api/runs/:id", wrap(async (req, res) => {
  const run = await getRunWithAccount(Number(req.params.id));
  if (!run || run.user_id !== req.session.user) {
    return res.status(404).json({ error: "Run não encontrada" });
  }
  const results = await getRunResults(run.id);
  res.json({ run, results });
}));

app.get("/api/runs/:id/download", wrap(async (req, res) => {
  const run = await getRun(Number(req.params.id));
  if (!run || run.user_id !== req.session.user) return res.status(404).send("Not found");
  const results = await getRunResults(run.id);
  const lines = ["telefone;status;wamid;motivo;delivery_status;delivery_error;ts"];
  const clean = (s) => (s || "").replace(/[\r\n;|]/g, " ");
  for (const r of results) {
    lines.push(
      `${r.phone};${r.status};${r.wamid || ""};${clean(r.motivo)};${r.delivery_status || ""};${clean(r.delivery_error)};${r.ts}`
    );
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="relatorio_run_${run.id}.csv"`);
  res.send(lines.join("\n"));
}));

// ---------- Health ----------
app.get("/healthz", (req, res) =>
  res.json({ ok: true, backend: dbInfo().backend, ts: new Date().toISOString() })
);

// Handler de erro padrão (handlers async que rejeitam caem aqui).
app.use((err, req, res, next) => {
  console.error("route error:", err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Erro interno" });
});

// ---------- Boot ----------
(async () => {
  // Espera o schema do banco ficar pronto (promessa deferida — sem top-level
  // await em db.js, pra Hostinger/LiteSpeed conseguir require() o index.js).
  try {
    await dbReady;
  } catch (e) {
    console.error("[boot] db não inicializou:", e?.message || e);
  }
  // Atribui runs órfãos (user_id NULL) ao operador principal (isolamento).
  const primary = process.env.LOGIN_USER || HARDCODED_CLIENTS[0]?.user;
  let moved = 0;
  let recovered = 0;
  try {
    moved = await backfillRunOwners(primary);
    recovered = await recoverRunningRuns(); // runs órfãos 'running' → 'paused'
  } catch (e) {
    console.error("boot recovery error:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log(`\n  🚀 Disparador Node rodando em http://localhost:${PORT}`);
    console.log(`  🗄️  Banco: ${dbInfo().backend.toUpperCase()}${dbInfo().backend === "postgres" ? " (Supabase — persiste deploy)" : " (SQLite local — efêmero)"}`);
    if (isDryRun()) console.log(`  🧪 DRY-RUN ligado (DISPARO_DRY_RUN=1) — não envia de verdade`);
    if (moved) console.log(`  🔒 ${moved} run(s) legado(s) atribuído(s) a "${primary}"`);
    if (recovered) console.log(`  ♻️  ${recovered} run(s) órfão(s) 'running' → 'paused' (recuperáveis)`);
    const users = getConfiguredUsers();
    if (!users.length) console.log(`  ⚠️  Nenhum usuário configurado!\n`);
    else {
      console.log(`  👤 Usuários autorizados (${users.length}):`);
      for (const u of users) console.log(`     - ${u.user}`);
      console.log("");
    }
  });
})();
