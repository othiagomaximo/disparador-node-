import pLimit from "p-limit";
import { EventEmitter } from "node:events";

import { sendTemplate } from "./cloud-api.js";
import {
  isAlreadySent,
  markSent,
  createRun,
  updateRunCounters,
  finishRun,
  addRunResult,
} from "./db.js";

// Estado global em memória (1 disparo por vez)
let CURRENT = null;

export function getCurrent() {
  return CURRENT
    ? {
        runId: CURRENT.runId,
        total: CURRENT.total,
        enviados: CURRENT.enviados,
        falhas: CURRENT.falhas,
        pulados: CURRENT.pulados,
        paused: CURRENT.paused,
        motivo: CURRENT.motivo,
        running: !CURRENT.done,
      }
    : null;
}

export function stopCurrent() {
  if (CURRENT && !CURRENT.done) {
    CURRENT.paused = true;
    CURRENT.motivo = "Interrompido manualmente";
  }
}

/**
 * Inicia um disparo em background.
 * leads = [{ phone, parametros: [..] }]
 * opts  = { accessToken, phoneNumberId, templateName, language, concurrency, skipDuplicates }
 *   skipDuplicates: se true (default), pula números já marcados na table 'enviados'.
 *                   Se false, dispara mesmo pra quem já recebeu (sem consultar dedupe).
 * Retorna { runId, events: EventEmitter }
 */
export function startDisparo(leads, opts) {
  if (CURRENT && !CURRENT.done) {
    throw new Error("Já existe disparo em andamento");
  }
  const events = new EventEmitter();
  const runId = createRun(leads.length);
  const skipDuplicates = opts.skipDuplicates !== false; // default true
  CURRENT = {
    runId,
    total: leads.length,
    enviados: 0,
    falhas: 0,
    pulados: 0,
    paused: false,
    motivo: null,
    done: false,
    events,
  };

  const concurrency = Math.max(1, Math.min(50, opts.concurrency || 10));
  const limit = pLimit(concurrency);

  const tasks = leads.map((lead) =>
    limit(async () => {
      if (CURRENT.paused) return;
      const phone = lead.phone;

      // Dedupe (opt-in pelo usuário, default true)
      if (skipDuplicates && isAlreadySent(phone)) {
        CURRENT.pulados++;
        addRunResult(runId, phone, "PULADO", null, "Já enviado anteriormente");
        events.emit("event", { type: "skip", phone, stats: snapshot() });
        return;
      }

      const result = await sendTemplate({
        accessToken: opts.accessToken,
        phoneNumberId: opts.phoneNumberId,
        toPhone: phone,
        templateName: opts.templateName,
        language: opts.language,
        parameters: lead.parametros,
      });

      if (result.ok) {
        CURRENT.enviados++;
        markSent(phone, result.wamid, opts.templateName);
        addRunResult(runId, phone, "ENVIADO", result.wamid, null);
        events.emit("event", {
          type: "success",
          phone,
          wamid: result.wamid,
          stats: snapshot(),
        });
      } else {
        CURRENT.falhas++;
        addRunResult(runId, phone, `FALHA_${result.code ?? "?"}`, null, result.message);
        events.emit("event", {
          type: "failure",
          phone,
          code: result.code,
          message: result.message,
          stats: snapshot(),
        });
        if (result.bloqueio) {
          CURRENT.paused = true;
          CURRENT.motivo = `Bloqueio Meta (${result.code}): ${result.message}`;
          events.emit("event", {
            type: "blocked",
            code: result.code,
            message: result.message,
            stats: snapshot(),
          });
        }
      }
      updateRunCounters(runId, {
        enviados: CURRENT.enviados,
        falhas: CURRENT.falhas,
      });
    })
  );

  Promise.allSettled(tasks).then(() => {
    CURRENT.done = true;
    const status = CURRENT.paused ? "paused" : "completed";
    finishRun(runId, status, CURRENT.motivo);
    events.emit("event", { type: "done", status, stats: snapshot() });
  });

  return { runId, events };
}

function snapshot() {
  if (!CURRENT) return null;
  return {
    runId: CURRENT.runId,
    total: CURRENT.total,
    enviados: CURRENT.enviados,
    falhas: CURRENT.falhas,
    pulados: CURRENT.pulados,
    paused: CURRENT.paused,
    motivo: CURRENT.motivo,
  };
}
