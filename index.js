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

import {
  setConfig,
  getAllConfig,
  listRuns,
  getRun,
  getRunResults,
  updateDeliveryStatusByWamid,
} from "./lib/db.js";
import { normalizePhone } from "./lib/normalize.js";
import { requireAuth } from "./lib/auth-middleware.js";
import { startDisparo, stopCurrent, getCurrent } from "./lib/disparo-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

mkdirSync("./data", { recursive: true });
mkdirSync("./uploads", { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
const MemoryStore = createMemoryStore(session);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static(join(__dirname, "public")));

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

// ---------- AUTH ----------
app.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/");
  res.sendFile(join(__dirname, "views", "login.html"));
});

// Lê todos os usuários configurados em env vars.
// Aceita SENHA EM TEXTO PURO via LOGIN_PASSWORD (mais simples, evita problema com $)
// OU hash bcrypt via LOGIN_PASSWORD_HASH (mais seguro).
// Múltiplos usuários: LOGIN_USER_2 / LOGIN_PASSWORD_2, etc até _10
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
// Verificação: Meta chama GET com hub.mode/hub.verify_token/hub.challenge.
// A gente devolve o challenge em texto puro se o token bater.
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
  res.sendFile(join(__dirname, "views", "app.html"));
});

// ---------- API: Config ----------
app.get("/api/config", (req, res) => {
  res.json(getAllConfig());
});

app.post("/api/config", (req, res) => {
  const allowed = [
    "access_token",
    "phone_number_id",
    "template_name",
    "language",
    "concurrency",
  ];
  for (const k of allowed) {
    if (k in req.body) setConfig(k, String(req.body[k] ?? ""));
  }
  res.json({ ok: true, config: getAllConfig() });
});

// Limpa todas as credenciais salvas (token, phone, template)
app.post("/api/config/clear", (req, res) => {
  const keys = ["access_token", "phone_number_id", "template_name", "language", "concurrency"];
  for (const k of keys) setConfig(k, "");
  res.json({ ok: true });
});

// ---------- API: CSV upload + parse ----------
let CSV_BUFFER = null; // memória, 1 arquivo por vez

app.post("/api/csv/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo faltando" });
  try {
    const raw = require("node:fs").readFileSync(req.file.path, "utf-8");
    require("node:fs").unlinkSync(req.file.path);
    // detecta delimitador (vírgula ou ponto-e-vírgula)
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
    CSV_BUFFER = {
      filename: req.file.originalname,
      headers: Object.keys(rows[0]),
      rows,
    };
    res.json({
      ok: true,
      filename: CSV_BUFFER.filename,
      headers: CSV_BUFFER.headers,
      preview: rows.slice(0, 5),
      total: rows.length,
      delimiter: delim,
    });
  } catch (e) {
    res.status(400).json({ error: `Erro lendo CSV: ${e.message}` });
  }
});

// Trick pra usar require em ES modules (só pra fs sync acima)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

app.get("/api/csv/current", (req, res) => {
  if (!CSV_BUFFER) return res.json({ loaded: false });
  res.json({
    loaded: true,
    filename: CSV_BUFFER.filename,
    headers: CSV_BUFFER.headers,
    preview: CSV_BUFFER.rows.slice(0, 5),
    total: CSV_BUFFER.rows.length,
  });
});

// ---------- API: Disparo ----------
let currentEvents = null;

app.post("/api/disparo/start", async (req, res) => {
  if (!CSV_BUFFER) return res.status(400).json({ error: "Suba o CSV primeiro" });
  const cfg = getAllConfig();
  if (!cfg.access_token || !cfg.phone_number_id || !cfg.template_name) {
    return res.status(400).json({ error: "Configure token, phone ID e template antes" });
  }
  const { phoneCol, varCols, skipDuplicates } = req.body || {};
  if (!phoneCol) return res.status(400).json({ error: "Mapeie a coluna do telefone" });
  // default true se não vier (ou vier null/undefined)
  const skip = skipDuplicates === undefined || skipDuplicates === null ? true : !!skipDuplicates;

  // Monta leads
  const leads = [];
  let invalidos = 0;
  for (const row of CSV_BUFFER.rows) {
    const phone = normalizePhone(row[phoneCol]);
    if (!phone) {
      invalidos++;
      continue;
    }
    const parametros = (varCols || []).map((c) => row[c] ?? "");
    leads.push({ phone, parametros });
  }
  if (!leads.length) return res.status(400).json({ error: "Nenhum telefone válido no CSV" });

  try {
    const { runId, events } = startDisparo(leads, {
      accessToken: cfg.access_token,
      phoneNumberId: cfg.phone_number_id,
      templateName: cfg.template_name,
      language: cfg.language || "pt_BR",
      concurrency: Number(cfg.concurrency) || 10,
      skipDuplicates: skip,
    });
    currentEvents = events;
    res.json({ ok: true, runId, total: leads.length, invalidos, skipDuplicates: skip });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/disparo/stop", (req, res) => {
  stopCurrent();
  res.json({ ok: true });
});

app.get("/api/disparo/status", (req, res) => {
  res.json(getCurrent());
});

app.get("/api/disparo/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendSnapshot = () => {
    const cur = getCurrent();
    if (cur) res.write(`data: ${JSON.stringify({ type: "status", stats: cur })}\n\n`);
  };
  sendSnapshot();

  const onEvent = (e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.type === "done") {
      res.end();
    }
  };

  if (currentEvents) {
    currentEvents.on("event", onEvent);
  }

  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);

  req.on("close", () => {
    clearInterval(ping);
    if (currentEvents) currentEvents.off("event", onEvent);
  });
});

// ---------- API: Relatórios ----------
app.get("/api/runs", (req, res) => {
  res.json(listRuns(50));
});

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ error: "Run não encontrada" });
  const results = getRunResults(run.id);
  res.json({ run, results });
});

app.get("/api/runs/:id/download", (req, res) => {
  const run = getRun(Number(req.params.id));
  if (!run) return res.status(404).send("Not found");
  const results = getRunResults(run.id);
  const lines = ["telefone;status;wamid;motivo;delivery_status;delivery_error;ts"];
  const clean = (s) => (s || "").replace(/[\r\n;]/g, " ");
  for (const r of results) {
    lines.push(
      `${r.phone};${r.status};${r.wamid || ""};${clean(r.motivo)};${r.delivery_status || ""};${clean(r.delivery_error)};${r.ts}`
    );
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="relatorio_run_${run.id}.csv"`
  );
  res.send(lines.join("\n"));
});

// ---------- Health ----------
app.get("/healthz", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n  🚀 Disparador Node rodando em http://localhost:${PORT}`);
  console.log(`  📁 SQLite em ./data/app.db`);
  const users = getConfiguredUsers();
  if (!users.length) {
    console.log(`  ⚠️  Nenhum usuário configurado!\n`);
  } else {
    console.log(`  👤 Usuários autorizados (${users.length}):`);
    for (const u of users) console.log(`     - ${u.user}`);
    console.log("");
  }
});
