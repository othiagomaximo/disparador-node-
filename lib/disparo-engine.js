import pLimit from "p-limit";
import { EventEmitter } from "node:events";

import { sendTemplate } from "./cloud-api.js";
import {
  isAlreadySent,
  markSent,
  createRun,
  finishRun,
  setRunPaused,
  setRunStatus,
  updateRunProgress,
  addRunResult,
  insertRunRows,
  updateRunRowStatus,
  getRunWithAccount,
  getAccount,
  getAllRunRows,
  countRunRows,
  getRun,
} from "./db.js";

// ───────────────────────────────────────────────────────────────────────────
// PARTE 3 — Estado multi-run.
// RUNS: Map<runKey, state>  (runKey = `${userId}::${runId}`)
// Antes era 1 variável global CURRENT — agora cada run tem seu próprio estado,
// permitindo disparos paralelos por usuário.
// ───────────────────────────────────────────────────────────────────────────
const RUNS = new Map();

// Limiter de envio COMPARTILHADO por phone_number_id. Dois runs que usam o
// MESMO número compartilham o mesmo pLimit → a concorrência agregada NUNCA
// passa do valor configurado (não vira "2 runs × 10 = 20 POSTs"). Números
// DIFERENTES rodam 100% independentes. concurrency=1 vira mutex estrito.
const PHONE_LIMITERS = new Map();

export const MAX_PARALLEL_RUNS_PER_USER = 2;

// Barramento único de eventos — a rota SSE filtra por userId. Assim o frontend
// abre UMA conexão e recebe eventos de todos os seus runs (cada um marcado com
// runId). Runs novos entram no barramento automaticamente.
export const BUS = new EventEmitter();
BUS.setMaxListeners(0);

// Modo simulação: não chama a Meta de verdade. Liga com DISPARO_DRY_RUN=1.
// Útil pra testar paralelo / pausa em N / retomar localmente SEM gastar
// envios reais nem precisar de token. DRY_RUN_FAIL_EVERY=N faz a cada Nª
// linha (por idx) "falhar" de propósito pra exercitar a UI de falha.
const DRY_RUN = process.env.DISPARO_DRY_RUN === "1";
const DRY_RUN_DELAY = Number(process.env.DRY_RUN_DELAY_MS || 40);
const DRY_RUN_FAIL_EVERY = Number(process.env.DRY_RUN_FAIL_EVERY || 0);
let DRY_SEQ = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (userId, runId) => `${userId}::${runId}`;

function getPhoneLimiter(phoneNumberId, concurrency) {
  const key = phoneNumberId || "_none_";
  let entry = PHONE_LIMITERS.get(key);
  if (!entry) {
    const c = Math.max(1, Math.min(50, Number(concurrency) || 10));
    entry = { limit: pLimit(c), concurrency: c };
    PHONE_LIMITERS.set(key, entry);
  }
  return entry.limit;
}

// ───────────────────────────────────────────────────────────────────────────
// Snapshot/eventos
// ───────────────────────────────────────────────────────────────────────────
function statusOf(state) {
  if (state.done) {
    if (state.aborted) return "aborted";
    return state.paused ? "paused" : "completed";
  }
  return state.paused ? "paused" : "running";
}

function snapshot(state) {
  return {
    runId: state.runId,
    accountId: state.account?.id ?? null,
    apelido: state.account?.apelido ?? null,
    icone: state.account?.icone ?? null,
    cor: state.account?.cor ?? null,
    filename: state.csvFilename ?? null,
    total: state.total,
    enviados: state.enviados,
    falhas: state.falhas,
    pulados: state.pulados,
    dispatched: state.dispatched,
    pending: Math.max(0, state.total - state.dispatched),
    pauseAt: state.pauseAt,
    paused: state.paused,
    pauseReason: state.pauseReason,
    aborted: state.aborted,
    done: state.done,
    running: !state.done && !state.paused,
    status: statusOf(state),
    motivo: state.pauseReason,
  };
}

function emit(state, evt) {
  evt.runId = state.runId;
  evt.userId = state.userId;
  state.events?.emit("event", evt);
  BUS.emit("event", evt);
}

function persistProgress(state) {
  updateRunProgress(state.runId, {
    enviados: state.enviados,
    falhas: state.falhas,
    pulados: state.pulados,
    dispatched: state.dispatched,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Envio de uma linha
// ───────────────────────────────────────────────────────────────────────────
async function doSend(state, phone, parametros, idx) {
  if (DRY_RUN) {
    await sleep(DRY_RUN_DELAY);
    if (DRY_RUN_FAIL_EVERY > 0 && (idx + 1) % DRY_RUN_FAIL_EVERY === 0) {
      return { ok: false, code: 131026, message: "DRY-RUN falha simulada", bloqueio: false };
    }
    return { ok: true, wamid: `DRYRUN-${state.runId}-${++DRY_SEQ}` };
  }
  return sendTemplate({
    accessToken: state.account.token,
    phoneNumberId: state.account.phone_number_id,
    toPhone: phone,
    templateName: state.templateName,
    language: state.language,
    parameters: parametros,
  });
}

async function processRow(state, row) {
  if (state.aborted) return;
  const phone = row.phone;

  // Dedupe (opt-in, default true) — conta como linha consumida (pulada).
  if (state.skipDuplicates && isAlreadySent(phone)) {
    state.pulados++;
    row.status = "skipped";
    updateRunRowStatus(state.runId, row.idx, "skipped", null, "Já enviado anteriormente");
    addRunResult(state.runId, phone, "PULADO", null, "Já enviado anteriormente");
    persistProgress(state);
    emit(state, { type: "skip", phone, idx: row.idx, stats: snapshot(state) });
    return;
  }

  const result = await doSend(state, phone, row.parametros, row.idx);

  if (result.ok) {
    state.enviados++;
    row.status = "sent";
    markSent(phone, result.wamid, state.templateName);
    updateRunRowStatus(state.runId, row.idx, "sent", result.wamid, null);
    addRunResult(state.runId, phone, "ENVIADO", result.wamid, null);
    persistProgress(state);
    emit(state, { type: "success", phone, idx: row.idx, wamid: result.wamid, stats: snapshot(state) });
  } else {
    state.falhas++;
    row.status = "failed";
    updateRunRowStatus(state.runId, row.idx, "failed", null, result.message);
    addRunResult(state.runId, phone, `FALHA_${result.code ?? "?"}`, null, result.message);
    persistProgress(state);
    emit(state, {
      type: "failure",
      phone,
      idx: row.idx,
      code: result.code,
      message: result.message,
      stats: snapshot(state),
    });
    if (result.bloqueio) {
      state.paused = true;
      state.pauseReason = `Bloqueio Meta (${result.code}): ${result.message}`;
      // Persiste o pause AGORA (não só no finalizeSegment): se o processo cair
      // durante o drain dos in-flight, o run ainda fica 'paused' no DB com motivo,
      // e é retomável. Idempotente — finalizeSegment re-grava igual.
      setRunPaused(state.runId, state.pauseReason, state.pauseAt);
      emit(state, { type: "blocked", code: result.code, message: result.message, stats: snapshot(state) });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Loop de dispatch — consome rows[nextIdx..] respeitando pauseAt / paused / abort.
// ───────────────────────────────────────────────────────────────────────────
async function runLoop(state) {
  if (state.loopRunning) return;
  state.loopRunning = true;
  const limiter = getPhoneLimiter(state.account?.phone_number_id, state.concurrency);
  const inFlight = new Set();
  const maxAhead = Math.max(4, (Number(state.concurrency) || 10) * 4);

  try {
    while (state.nextIdx < state.rows.length) {
      if (state.aborted) break;
      if (state.paused) break;
      // Pausa programada em N: para ANTES de dispatchar a (pauseAt+1)ª linha.
      if (state.pauseAt != null && state.dispatched >= state.pauseAt) {
        state.paused = true;
        state.pauseReason = "limit-reached";
        break;
      }
      const row = state.rows[state.nextIdx];
      state.nextIdx++;
      state.dispatched++;
      const p = limiter(() => processRow(state, row)).catch((e) => {
        // Erro inesperado numa linha não derruba o run inteiro.
        state.falhas++;
        row.status = "failed";
        try {
          updateRunRowStatus(state.runId, row.idx, "failed", null, String(e?.message || e).slice(0, 200));
          addRunResult(state.runId, row.phone, "FALHA_EXC", null, String(e?.message || e).slice(0, 200));
        } catch {}
        emit(state, { type: "failure", phone: row.phone, idx: row.idx, code: "EXC", message: String(e?.message || e), stats: snapshot(state) });
      });
      const wrapped = p.finally(() => inFlight.delete(wrapped));
      inFlight.add(wrapped);
      // Backpressure: não adianta muito além da concorrência (mantém a pausa
      // responsiva e não segura milhares de promessas pendentes).
      if (inFlight.size >= maxAhead) await Promise.race(inFlight);
    }
    await Promise.allSettled([...inFlight]);
  } finally {
    state.loopRunning = false;
    finalizeSegment(state);
  }
}

// Libera o limiter de um phone_number_id quando NENHUM run ativo o usa mais —
// evita a Map PHONE_LIMITERS crescer pra sempre com contas rotativas.
function releasePhoneLimiterIfUnused(phoneNumberId) {
  if (!phoneNumberId) return;
  for (const s of RUNS.values()) {
    if (!s.done && s.account?.phone_number_id === phoneNumberId) return; // ainda em uso
  }
  PHONE_LIMITERS.delete(phoneNumberId);
}

function finalizeSegment(state) {
  // Guarda de reentrada: uma vez finalizado (completed/aborted) nunca refaz —
  // evita finishRun/emit("done") duplicados num caminho de corrida.
  if (state.done) return;
  persistProgress(state);

  if (state.aborted) {
    state.done = true;
    finishRun(state.runId, "aborted", state.pauseReason || "Abortado pelo usuário");
    emit(state, { type: "done", status: "aborted", stats: snapshot(state) });
    RUNS.delete(state.runKey);
    releasePhoneLimiterIfUnused(state.account?.phone_number_id);
    return;
  }

  const allConsumed = state.nextIdx >= state.rows.length;
  if (allConsumed && !state.paused) {
    state.done = true;
    finishRun(state.runId, "completed", null);
    emit(state, { type: "done", status: "completed", stats: snapshot(state) });
    RUNS.delete(state.runKey);
    releasePhoneLimiterIfUnused(state.account?.phone_number_id);
    return;
  }

  if (state.paused) {
    // Pausado (manual, limite, ou bloqueio Meta). Persiste e SOBREVIVE.
    setRunPaused(state.runId, state.pauseReason, state.pauseAt);
    const remaining = Math.max(0, state.total - state.dispatched);
    emit(state, {
      type: "paused",
      reason: state.pauseReason,
      sent: state.dispatched,
      total: state.total,
      remaining,
      stats: snapshot(state),
    });
    // Permanece em RUNS pra retomada rápida (e também sobrevive via DB).
    return;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// API pública
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inicia um disparo em background pra um usuário, por uma conta WhatsApp.
 * leads = [{ phone, parametros: [..], rowOriginal: {..} }]
 * opts  = { userId, account, templateName, language, concurrency, skipDuplicates,
 *           pauseAt, csvFilename, csvHeaders, csvDelimiter, varCols }
 * Retorna { runId, snapshot }
 */
export function startDisparo(leads, opts) {
  const userId = opts.userId;
  if (getActiveRunCount(userId) >= MAX_PARALLEL_RUNS_PER_USER) {
    throw new Error(
      `Limite de ${MAX_PARALLEL_RUNS_PER_USER} disparos simultâneos atingido. Aguarde um terminar ou pause/aborte.`
    );
  }
  const account = opts.account;
  if (!account) throw new Error("Conta WhatsApp não informada");

  const runId = createRun({
    total: leads.length,
    userId,
    accountId: account.id,
    pauseAt: opts.pauseAt || null,
    csvFilename: opts.csvFilename,
    csvHeaders: opts.csvHeaders,
    csvDelimiter: opts.csvDelimiter,
    varCols: opts.varCols,
    templateName: opts.templateName,
    language: opts.language,
    concurrency: opts.concurrency,
    skipDuplicates: opts.skipDuplicates,
  });

  // Snapshot das linhas (PARTE 3.6 / PARTE 5): o run guarda suas próprias linhas
  // e NUNCA mais lê o CSV_BUFFER global. Subir outro CSV não afeta este run.
  const rows = leads.map((l, i) => ({
    idx: i,
    phone: l.phone,
    parametros: l.parametros || [],
    rowOriginal: l.rowOriginal || {},
    status: "pending",
  }));
  insertRunRows(runId, rows);

  const state = {
    runId,
    runKey: keyOf(userId, runId),
    userId,
    account,
    templateName: opts.templateName,
    language: opts.language || "pt_BR",
    concurrency: Math.max(1, Math.min(50, Number(opts.concurrency) || 10)),
    skipDuplicates: opts.skipDuplicates !== false,
    rows,
    total: rows.length,
    enviados: 0,
    falhas: 0,
    pulados: 0,
    dispatched: 0,
    nextIdx: 0,
    pauseAt: opts.pauseAt || null,
    paused: false,
    pauseReason: null,
    aborted: false,
    done: false,
    loopRunning: false,
    events: new EventEmitter(),
    csvFilename: opts.csvFilename || "lista",
    csvHeaders: opts.csvHeaders || [],
    csvDelimiter: opts.csvDelimiter || ",",
    varCols: opts.varCols || [],
  };
  RUNS.set(state.runKey, state);

  runLoop(state); // background, sem await
  return { runId, snapshot: snapshot(state) };
}

// Reconstrói o estado de um run PAUSADO a partir do banco (pós-reload/restart).
function rebuildStateFromDB(userId, runId) {
  const run = getRunWithAccount(runId);
  if (!run) return { error: "Run não encontrado" };
  if (run.user_id && run.user_id !== userId) return { error: "Run de outro usuário" };
  if (run.status !== "paused") return { error: "Run não está pausado" };

  const account = run.account_id ? getAccount(run.account_id) : null;
  if (!account) {
    return {
      error:
        "A conta WhatsApp deste disparo foi removida — não dá pra retomar o envio. Baixe o CSV de pendentes e reimporte numa conta válida.",
    };
  }

  const dbRows = getAllRunRows(runId);
  const rows = dbRows.map((r) => ({
    idx: r.idx,
    phone: r.phone,
    parametros: safeParse(r.parametros, []),
    rowOriginal: safeParse(r.row_json, {}),
    status: r.status,
  }));
  const counts = countRunRows(runId);
  const dispatched = rows.filter((r) => r.status !== "pending").length;
  let nextIdx = rows.findIndex((r) => r.status === "pending");
  if (nextIdx === -1) nextIdx = rows.length;

  const state = {
    runId,
    runKey: keyOf(userId, runId),
    userId,
    account,
    templateName: run.template_name,
    language: run.language || "pt_BR",
    concurrency: Math.max(1, Math.min(50, Number(run.concurrency) || 10)),
    skipDuplicates: !!run.skip_duplicates,
    rows,
    total: rows.length,
    enviados: counts.sent,
    falhas: counts.failed,
    pulados: counts.skipped,
    dispatched,
    nextIdx,
    pauseAt: null,
    paused: true,
    pauseReason: run.pause_reason,
    aborted: false,
    done: false,
    loopRunning: false,
    events: new EventEmitter(),
    csvFilename: run.csv_filename || "lista",
    csvHeaders: safeParse(run.csv_headers, []),
    csvDelimiter: run.csv_delimiter || ",",
    varCols: safeParse(run.var_cols, []),
  };
  return { state };
}

function safeParse(s, fallback) {
  // JSON.parse(null) retorna null (não lança) — guarda explícita pra colunas
  // NULL do banco (ex.: csv_headers de runs legados) não virarem null e
  // quebrarem headers.map() lá no pending.csv/all.csv.
  if (typeof s !== "string" || s === "") return fallback;
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Retoma um run pausado. count = número (continuar só N) ou "all"/null (todos).
export function resumeRun(userId, runId, count) {
  const runKey = keyOf(userId, runId);
  let state = RUNS.get(runKey);
  if (!state) {
    const rebuilt = rebuildStateFromDB(userId, runId);
    if (rebuilt.error) throw new Error(rebuilt.error);
    state = rebuilt.state;
    RUNS.set(runKey, state);
  }
  if (state.done) throw new Error("Run já finalizado");

  if (count === "all" || count == null || count === "") {
    state.pauseAt = null;
  } else {
    if (typeof count === "object") throw new Error("Quantidade inválida");
    const n = parseInt(count, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error("Quantidade pra continuar deve ser > 0");
    state.pauseAt = state.dispatched + n;
  }
  state.paused = false;
  state.pauseReason = null;
  state.aborted = false;
  setRunStatus(runId, "running");
  emit(state, { type: "resumed", stats: snapshot(state) });
  runLoop(state); // background
  return snapshot(state);
}

// Pausa manual (botão Pausar) — abre o mesmo modal das 4 opções no frontend.
export function pauseRun(userId, runId) {
  const state = RUNS.get(keyOf(userId, runId));
  if (!state || state.done) throw new Error("Run não está ativo");
  if (state.paused) return snapshot(state);
  state.paused = true;
  state.pauseReason = "manual";
  // Persiste já (mesmo com o loop ainda drenando in-flight): fecha a janela em
  // que o pause existe só em memória. finalizeSegment re-grava — é idempotente.
  setRunPaused(state.runId, "manual", state.pauseAt);
  // Se o loop não está rodando (já estava parado), finaliza o segmento agora.
  if (!state.loopRunning) finalizeSegment(state);
  return snapshot(state);
}

// Aborta (descarta restantes).
export function abortRun(userId, runId) {
  const state = RUNS.get(keyOf(userId, runId));
  if (!state) {
    // Run pausado fora da memória (pós-restart): marca abortado direto no DB.
    const run = getRun(runId);
    if (!run || run.user_id !== userId) throw new Error("Run não encontrado");
    if (run.status === "running") throw new Error("Run ativo não está em memória");
    finishRun(runId, "aborted", "Abortado pelo usuário");
    return { runId, status: "aborted" };
  }
  state.aborted = true;
  state.paused = false;
  if (!state.loopRunning) finalizeSegment(state);
  // Se o loop está rodando, ele detecta aborted no próximo tick e finaliza.
  return { runId, status: "aborted" };
}

// Snapshots dos runs EM MEMÓRIA desse user (running/paused) — alimenta os cards.
export function getUserRuns(userId) {
  const out = [];
  for (const state of RUNS.values()) {
    if (state.userId === userId && !state.done) out.push(snapshot(state));
  }
  return out.sort((a, b) => a.runId - b.runId);
}

export function getRunSnapshot(userId, runId) {
  const state = RUNS.get(keyOf(userId, runId));
  return state ? snapshot(state) : null;
}

// Conta runs ATIVOS (rodando, não pausados/finalizados) — pra MAX_PARALLEL.
export function getActiveRunCount(userId) {
  let n = 0;
  for (const state of RUNS.values()) {
    if (state.userId === userId && !state.done && !state.paused && !state.aborted) n++;
  }
  return n;
}

export function isDryRun() {
  return DRY_RUN;
}
