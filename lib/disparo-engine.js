import pLimit from "p-limit";
import { EventEmitter } from "node:events";

import { sendTemplate, ERROS_BLOQUEIO } from "./cloud-api.js";
import { classifyMetaError } from "./meta-errors.js";
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
// Estado multi-run.  RUNS: Map<runKey, state>  (runKey = `${userId}::${runId}`)
// ───────────────────────────────────────────────────────────────────────────
const RUNS = new Map();

// Reserva síncrona de vaga por user. startDisparo virou async (await createRun/
// insertRunRows ANTES do RUNS.set), abrindo uma janela em que 2 starts rápidos
// passariam ambos no check de MAX_PARALLEL. Esta Map fecha a janela.
const RESERVING = new Map();

// Limiter de envio COMPARTILHADO por phone_number_id (concorrência agregada nunca
// passa do configurado; concurrency=1 vira mutex). Números diferentes independentes.
const PHONE_LIMITERS = new Map();

export const MAX_PARALLEL_RUNS_PER_USER = 2;

// Barramento único de eventos — a rota SSE filtra por userId.
export const BUS = new EventEmitter();
BUS.setMaxListeners(0);

// Modo simulação (DISPARO_DRY_RUN=1). DRY_RUN_FAIL_EVERY=N falha a cada Nª linha.
const DRY_RUN = process.env.DISPARO_DRY_RUN === "1";
const DRY_RUN_DELAY = Number(process.env.DRY_RUN_DELAY_MS || 40);
const DRY_RUN_FAIL_EVERY = Number(process.env.DRY_RUN_FAIL_EVERY || 0);
// Pra TESTE: códigos de erro a injetar nas linhas que falham (cicla a lista).
// Ex.: DRY_RUN_FAIL_CODES=131049,132001,100,NUM,NET  (NUM=número inválido, NET=rede).
const DRY_RUN_FAIL_CODES = String(process.env.DRY_RUN_FAIL_CODES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Throttle da persistência de contadores agregados (PARTE 1.6): grava a cada
// ~25 linhas OU 2s — mas SEMPRE força em pause/block/finalize. Evita 1 round-trip
// pro Postgres por linha só pra atualizar enviados/falhas.
const PROGRESS_EVERY_N = 25;
const PROGRESS_EVERY_MS = 2000;

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

async function persistProgress(state) {
  state.lastPersistCount = state.enviados + state.falhas + state.pulados;
  state.lastPersistAt = Date.now();
  await updateRunProgress(state.runId, {
    enviados: state.enviados,
    falhas: state.falhas,
    pulados: state.pulados,
    dispatched: state.dispatched,
  });
}

// Persiste os writes de UMA linha (run_rows + run_results + dedupe) de forma
// best-effort: um erro de DB aqui NÃO pode estourar pra fora do processRow,
// senão o .catch do loop marcaria como falha uma linha que JÁ foi enviada
// (e ainda duplicaria o contador). Loga e segue — o run_rows é a fonte da verdade.
async function persistRowWrites(state, promises) {
  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`run ${state.runId}: persist de linha falhou:`, r.reason?.message || r.reason);
    }
  }
}

// Versão throttled — usada por linha no loop.
async function maybePersistProgress(state) {
  const processed = state.enviados + state.falhas + state.pulados;
  if (
    processed - state.lastPersistCount >= PROGRESS_EVERY_N ||
    Date.now() - state.lastPersistAt >= PROGRESS_EVERY_MS
  ) {
    await persistProgress(state);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Envio de uma linha
// ───────────────────────────────────────────────────────────────────────────
async function doSend(state, phone, parametros, idx) {
  if (DRY_RUN) {
    await sleep(DRY_RUN_DELAY);
    if (DRY_RUN_FAIL_EVERY > 0 && (idx + 1) % DRY_RUN_FAIL_EVERY === 0) {
      if (DRY_RUN_FAIL_CODES.length) {
        const pick = DRY_RUN_FAIL_CODES[Math.floor(idx / DRY_RUN_FAIL_EVERY) % DRY_RUN_FAIL_CODES.length];
        if (pick === "NUM") return { ok: false, code: null, message: "Número inválido (curto)", bloqueio: false };
        if (pick === "NET") return { ok: false, code: null, message: "network: timeout", bloqueio: false };
        const code = Number(pick);
        return { ok: false, code, message: `DRY-RUN erro ${code}`, bloqueio: ERROS_BLOQUEIO.has(code) };
      }
      return { ok: false, code: 131026, message: "DRY-RUN falha simulada", bloqueio: false };
    }
    // wamid determinístico por (runId, idx) — único e estável mesmo após restart
    // (a Meta real já devolve wamid único; isso só ajuda o teste em dry-run).
    return { ok: true, wamid: `DRYRUN-${state.runId}-${idx}` };
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
  const accountId = state.account?.id ?? null;

  // Dedupe POR CONTA (PARTE 2): só pula se ESTA conta já mandou pro número.
  if (state.skipDuplicates && (await isAlreadySent(phone, accountId))) {
    state.pulados++;
    row.status = "skipped";
    await persistRowWrites(state, [
      updateRunRowStatus(state.runId, row.idx, "skipped", null, "Já enviado anteriormente"),
      addRunResult(state.runId, phone, "PULADO", null, "Já enviado anteriormente"),
    ]);
    await maybePersistProgress(state);
    emit(state, { type: "skip", phone, idx: row.idx, stats: snapshot(state) });
    return;
  }

  const result = await doSend(state, phone, row.parametros, row.idx);

  if (result.ok) {
    // O ENVIO foi feito — atualiza estado/contadores ANTES de persistir, e nunca
    // deixa um erro de DB reverter pra "falha" (a msg já saiu). markSent falhar
    // = perde só o dedupe daquele número (pode reenviar num próximo run).
    state.enviados++;
    row.status = "sent";
    await persistRowWrites(state, [
      markSent(phone, accountId, result.wamid, state.templateName),
      updateRunRowStatus(state.runId, row.idx, "sent", result.wamid, null),
      addRunResult(state.runId, phone, "ENVIADO", result.wamid, null),
    ]);
    await maybePersistProgress(state);
    emit(state, { type: "success", phone, idx: row.idx, wamid: result.wamid, stats: snapshot(state) });
  } else {
    state.falhas++;
    row.status = "failed";
    // PARTE 1/2: traduz o erro cru da Meta numa categoria + label PT-BR. A label
    // vai prefixada no motivo (modal/relatório legíveis) e a categoria vai na
    // coluna erro_categoria (pro breakdown agrupado da PARTE 3).
    const cls = classifyMetaError({ code: result.code, message: result.message });
    // separador "—" (não "|") pra não sujar o CSV de relatório (delimitado por ;).
    const motivo = `${cls.label} — (cód. ${result.code ?? "?"}) ${result.message}`.slice(0, 300);
    await persistRowWrites(state, [
      updateRunRowStatus(state.runId, row.idx, "failed", null, motivo),
      addRunResult(state.runId, phone, `FALHA_${result.code ?? "?"}`, null, motivo, cls.categoria),
    ]);
    await maybePersistProgress(state);
    emit(state, {
      type: "failure",
      phone,
      idx: row.idx,
      code: result.code,
      message: result.message,
      categoria: cls.categoria,
      label: cls.label,
      stats: snapshot(state),
    });
    // PARTE 2.2 — pausa em erro de BLOQUEIO. O ERROS_BLOQUEIO de cloud-api.js
    // (intocado) NÃO cobre todos os códigos limite/template/token que o
    // classificador marca como "bloqueio" (ex.: 132001/131008 template, 0/10/200
    // token, 130429/80007 limite). Sem isto, um template/token errado QUEIMA a
    // lista inteira (todas as linhas falham e nada pausa). Então o engine pausa
    // se O CLOUD-API disse bloqueio OU se o classificador disser bloqueio.
    // ⚠️ DECISÃO PRA MAXIMO APROVAR — reverter = trocar por `if (result.bloqueio)`.
    const shouldBlock = result.bloqueio || cls.severidade === "bloqueio";
    if (shouldBlock) {
      state.paused = true;
      // pauseReason humano (a tela de pausa mostra isto pra explicar POR QUE parou).
      state.pauseReason = `${cls.label} (cód. Meta ${result.code ?? "?"})`;
      // Persiste o pause AGORA (fecha janela de crash antes do finalizeSegment).
      await persistProgress(state);
      await setRunPaused(state.runId, state.pauseReason, state.pauseAt);
      emit(state, {
        type: "blocked",
        code: result.code,
        message: result.message,
        categoria: cls.categoria,
        label: cls.label,
        dica: cls.dica,
        stats: snapshot(state),
      });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Loop de dispatch
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
      if (state.pauseAt != null && state.dispatched >= state.pauseAt) {
        state.paused = true;
        state.pauseReason = "limit-reached";
        break;
      }
      const row = state.rows[state.nextIdx];
      state.nextIdx++;
      state.dispatched++;
      const p = limiter(() => processRow(state, row)).catch(async (e) => {
        // Erro inesperado numa linha não derruba o run inteiro.
        state.falhas++;
        row.status = "failed";
        const exMsg = String(e?.message || e).slice(0, 200);
        try {
          await Promise.all([
            updateRunRowStatus(state.runId, row.idx, "failed", null, exMsg),
            addRunResult(state.runId, row.phone, "FALHA_EXC", null, exMsg, "outro"),
          ]);
        } catch {}
        emit(state, { type: "failure", phone: row.phone, idx: row.idx, code: "EXC", categoria: "outro", label: `⚠️ ${exMsg}`, message: exMsg, stats: snapshot(state) });
      });
      const wrapped = p.finally(() => inFlight.delete(wrapped));
      inFlight.add(wrapped);
      if (inFlight.size >= maxAhead) await Promise.race(inFlight);
    }
    await Promise.allSettled([...inFlight]);
  } finally {
    state.loopRunning = false;
    await finalizeSegment(state);
  }
}

// Libera o limiter de um phone_number_id quando nenhum run ativo o usa mais.
function releasePhoneLimiterIfUnused(phoneNumberId) {
  if (!phoneNumberId) return;
  for (const s of RUNS.values()) {
    if (!s.done && s.account?.phone_number_id === phoneNumberId) return;
  }
  PHONE_LIMITERS.delete(phoneNumberId);
}

async function finalizeSegment(state) {
  if (state.done) return; // guarda de reentrada
  await persistProgress(state);

  if (state.aborted) {
    state.done = true;
    await finishRun(state.runId, "aborted", state.pauseReason || "Abortado pelo usuário");
    emit(state, { type: "done", status: "aborted", stats: snapshot(state) });
    RUNS.delete(state.runKey);
    releasePhoneLimiterIfUnused(state.account?.phone_number_id);
    return;
  }

  const allConsumed = state.nextIdx >= state.rows.length;
  if (allConsumed && !state.paused) {
    state.done = true;
    await finishRun(state.runId, "completed", null);
    emit(state, { type: "done", status: "completed", stats: snapshot(state) });
    RUNS.delete(state.runKey);
    releasePhoneLimiterIfUnused(state.account?.phone_number_id);
    return;
  }

  if (state.paused) {
    await setRunPaused(state.runId, state.pauseReason, state.pauseAt);
    const remaining = Math.max(0, state.total - state.dispatched);
    emit(state, {
      type: "paused",
      reason: state.pauseReason,
      sent: state.dispatched,
      total: state.total,
      remaining,
      stats: snapshot(state),
    });
    return;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// API pública (todas async — call sites usam await)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inicia um disparo. leads = [{ phone, parametros, rowOriginal }].
 * opts = { userId, account, templateName, language, concurrency, skipDuplicates,
 *          pauseAt, csvFilename, csvHeaders, csvDelimiter, varCols }
 */
export async function startDisparo(leads, opts) {
  const userId = opts.userId;
  const reserved = RESERVING.get(userId) || 0;
  if (getActiveRunCount(userId) + reserved >= MAX_PARALLEL_RUNS_PER_USER) {
    throw new Error(
      `Limite de ${MAX_PARALLEL_RUNS_PER_USER} disparos simultâneos atingido. Aguarde um terminar ou pause/aborte.`
    );
  }
  const account = opts.account;
  if (!account) throw new Error("Conta WhatsApp não informada");
  RESERVING.set(userId, reserved + 1); // reserva a vaga ANTES dos awaits

  try {
    return await doStartDisparo(leads, opts, userId, account);
  } finally {
    RESERVING.set(userId, Math.max(0, (RESERVING.get(userId) || 1) - 1));
  }
}

async function doStartDisparo(leads, opts, userId, account) {
  const runId = await createRun({
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

  const rows = leads.map((l, i) => ({
    idx: i,
    phone: l.phone,
    parametros: l.parametros || [],
    rowOriginal: l.rowOriginal || {},
    status: "pending",
  }));
  await insertRunRows(runId, rows); // insert em LOTE no Postgres

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
    lastPersistCount: 0,
    lastPersistAt: Date.now(),
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
async function rebuildStateFromDB(userId, runId) {
  const run = await getRunWithAccount(runId);
  if (!run) return { error: "Run não encontrado" };
  // Isolamento ESTRITO (sem o `&&` que deixava run.user_id NULL passar — runs
  // legados são atribuídos ao operador no boot, então NULL não acontece).
  if (run.user_id !== userId) return { error: "Run não encontrado" };
  if (run.status !== "paused") return { error: "Run não está pausado" };

  const account = run.account_id ? await getAccount(run.account_id) : null;
  if (!account) {
    return {
      error:
        "A conta WhatsApp deste disparo foi removida — não dá pra retomar o envio. Baixe o CSV de pendentes e reimporte numa conta válida.",
    };
  }

  const dbRows = await getAllRunRows(runId);
  const rows = dbRows.map((r) => ({
    idx: r.idx,
    phone: r.phone,
    parametros: safeParse(r.parametros, []),
    rowOriginal: safeParse(r.row_json, {}),
    status: r.status,
  }));
  const counts = await countRunRows(runId);
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
    lastPersistCount: counts.sent + counts.failed + counts.skipped,
    lastPersistAt: Date.now(),
    events: new EventEmitter(),
    csvFilename: run.csv_filename || "lista",
    csvHeaders: safeParse(run.csv_headers, []),
    csvDelimiter: run.csv_delimiter || ",",
    varCols: safeParse(run.var_cols, []),
  };
  return { state };
}

function safeParse(s, fallback) {
  if (typeof s !== "string" || s === "") return fallback;
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Retoma um run pausado. count = número (continuar só N) ou "all"/null (todos).
export async function resumeRun(userId, runId, count) {
  const runKey = keyOf(userId, runId);
  let state = RUNS.get(runKey);
  if (!state) {
    const rebuilt = await rebuildStateFromDB(userId, runId);
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
  await setRunStatus(runId, "running");
  emit(state, { type: "resumed", stats: snapshot(state) });
  runLoop(state); // background
  return snapshot(state);
}

// Pausa manual (botão Pausar) — abre o mesmo modal das 4 opções.
export async function pauseRun(userId, runId) {
  const state = RUNS.get(keyOf(userId, runId));
  if (!state || state.done) throw new Error("Run não está ativo");
  if (state.paused) return snapshot(state);
  state.paused = true;
  state.pauseReason = "manual";
  await setRunPaused(state.runId, "manual", state.pauseAt); // persiste já
  if (!state.loopRunning) await finalizeSegment(state);
  return snapshot(state);
}

// Aborta (descarta restantes).
export async function abortRun(userId, runId) {
  const state = RUNS.get(keyOf(userId, runId));
  if (!state) {
    const run = await getRun(runId);
    if (!run || run.user_id !== userId) throw new Error("Run não encontrado");
    if (run.status === "running") throw new Error("Run ativo não está em memória");
    await finishRun(runId, "aborted", "Abortado pelo usuário");
    return { runId, status: "aborted" };
  }
  state.aborted = true;
  state.paused = false;
  if (!state.loopRunning) await finalizeSegment(state);
  return { runId, status: "aborted" };
}

// Snapshots em memória (síncrono — não tocam o banco).
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
