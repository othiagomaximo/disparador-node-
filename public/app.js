// ===== Tabs =====
const navBtns = document.querySelectorAll("header nav button[data-tab]");
const panes = document.querySelectorAll(".pane");
navBtns.forEach((b) => {
  b.addEventListener("click", () => {
    navBtns.forEach((x) => x.classList.remove("active"));
    panes.forEach((p) => p.classList.remove("active"));
    b.classList.add("active");
    document.querySelector(`.pane[data-pane="${b.dataset.tab}"]`).classList.add("active");
    if (b.dataset.tab === "relatorio") loadRuns();
    if (b.dataset.tab === "disparo") {
      loadAccountsIntoDropdown();
      loadPausedBanner();
    }
  });
});

// ===== Utils =====
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
// Rótulo da conta no relatório: distingue conta removida (run tem account_id mas
// o apelido sumiu no LEFT JOIN) de run sem conta nenhuma. PARTE 3.5.
function accLabel(apelido, icone, accountId) {
  if (apelido) return `${escapeHtml(icone || "")} ${escapeHtml(apelido)}`;
  if (accountId) return '<span class="muted">(conta removida)</span>';
  return '<span class="muted">sem conta</span>';
}
// Postgres devolve timestamptz (ISO); SQLite devolve "YYYY-MM-DD HH:MM:SS".
// Normaliza pra um formato curto legível.
function fmtTs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// ===== Config: Template =====
async function loadConfig() {
  const r = await fetch("/api/config");
  const cfg = await r.json();
  for (const k of ["template_name", "language", "concurrency"]) {
    const el = document.getElementById(`cfg-${k}`);
    if (el && cfg[k] != null) el.value = cfg[k];
  }
}

document.getElementById("save-config").addEventListener("click", async () => {
  const body = {
    template_name: document.getElementById("cfg-template_name").value.trim(),
    language: document.getElementById("cfg-language").value.trim(),
    concurrency: document.getElementById("cfg-concurrency").value,
  };
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const msg = document.getElementById("save-config-msg");
  if (r.ok) {
    msg.textContent = "✅ Salvo!";
    msg.style.color = "var(--accent)";
  } else {
    msg.textContent = "❌ Erro ao salvar";
    msg.style.color = "var(--error)";
  }
  setTimeout(() => (msg.textContent = ""), 3000);
});

// ===== Config: Contas WhatsApp (PARTE 1) =====
let accountsCache = [];

async function loadAccounts() {
  const r = await fetch("/api/accounts");
  accountsCache = await r.json();
  renderAccounts();
  loadAccountsIntoDropdown();
}

function accountCardHtml(a) {
  const id = a.id || "";
  const cor = a.cor || "#25D366";
  return `
  <div class="account-card" data-id="${id}">
    <div class="account-head">
      <span class="account-swatch" style="background:${escapeAttr(cor)}"></span>
      <b>${a.id ? escapeHtml((a.icone || "") + " " + a.apelido) : "Nova conta"}</b>
    </div>
    <div class="row">
      <label>Apelido * <input class="acc-apelido" maxlength="60" value="${escapeAttr(a.apelido || "")}" placeholder="ex: Lourrany Beleza" /></label>
      <label style="max-width:110px;">Ícone <input class="acc-icone" maxlength="4" value="${escapeAttr(a.icone || "")}" placeholder="💄" /></label>
      <label style="max-width:120px;">Cor <input class="acc-cor" type="color" value="${escapeAttr(cor)}" /></label>
    </div>
    <div class="row">
      <label>Número (só exibição) <input class="acc-numero" value="${escapeAttr(a.numero || "")}" placeholder="+55 81 7902-1827" /></label>
      <label>Phone Number ID <input class="acc-phone_number_id" value="${escapeAttr(a.phone_number_id || "")}" placeholder="15 dígitos" /></label>
      <label>WABA ID <input class="acc-waba_id" value="${escapeAttr(a.waba_id || "")}" placeholder="opcional" /></label>
    </div>
    <label>Access Token ${a.has_token ? '<span class="muted">(salvo — deixe em branco pra manter)</span>' : ""}<textarea class="acc-token" rows="2" placeholder="${a.has_token ? "•••••••• preenchido" : "EAA..."}"></textarea></label>
    <div class="row">
      <label>Template desta conta <input class="acc-template_name" value="${escapeAttr(a.template_name || "")}" placeholder="vazio = usa o template global" /></label>
      <label style="max-width:140px;">Idioma <input class="acc-language" value="${escapeAttr(a.language || "")}" placeholder="pt_BR" /></label>
    </div>
    <div class="row">
      <button class="acc-save primary">💾 Salvar conta</button>
      ${a.id ? '<button class="acc-delete danger">🗑 Remover</button>' : '<button class="acc-cancel ghost">Cancelar</button>'}
      <span class="acc-msg hint"></span>
    </div>
  </div>`;
}

function renderAccounts() {
  const list = document.getElementById("accounts-list");
  if (!accountsCache.length) {
    list.innerHTML = '<p class="muted">Nenhuma conta cadastrada ainda. Clique em "+ Adicionar conta WhatsApp".</p>';
  } else {
    list.innerHTML = accountsCache.map(accountCardHtml).join("");
  }
  bindAccountCards();
}

function bindAccountCards() {
  document.querySelectorAll("#accounts-list .account-card").forEach(bindAccountCard);
}

// Liga listeners de UM card só — evita duplicar handlers nos cards existentes
// quando "+ Adicionar conta" insere um novo (re-bindar todos duplicava o fetch).
function bindAccountCard(card) {
  const get = (cls) => card.querySelector("." + cls);
    const msg = get("acc-msg");
    get("acc-save")?.addEventListener("click", async () => {
      const body = {
        id: card.dataset.id || null,
        apelido: get("acc-apelido").value.trim(),
        icone: get("acc-icone").value.trim(),
        cor: get("acc-cor").value,
        numero: get("acc-numero").value.trim(),
        phone_number_id: get("acc-phone_number_id").value.trim(),
        waba_id: get("acc-waba_id").value.trim(),
        token: get("acc-token").value.trim(),
        template_name: get("acc-template_name").value.trim(),
        language: get("acc-language").value.trim(),
      };
      if (!body.apelido) {
        msg.textContent = "Apelido é obrigatório";
        msg.style.color = "var(--error)";
        return;
      }
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) {
        msg.textContent = j.error || "Erro";
        msg.style.color = "var(--error)";
        return;
      }
      await loadAccounts();
    });
    get("acc-delete")?.addEventListener("click", async () => {
      if (!confirm(`Remover a conta "${get("acc-apelido").value}"? Disparos pausados nessa conta não poderão ser retomados.`)) return;
      const r = await fetch(`/api/accounts/${card.dataset.id}`, { method: "DELETE" });
      if (r.ok) await loadAccounts();
      else alert("Erro ao remover");
    });
    get("acc-cancel")?.addEventListener("click", () => renderAccounts());
}

document.getElementById("add-account").addEventListener("click", () => {
  const list = document.getElementById("accounts-list");
  if (list.querySelector('.account-card[data-id=""]')) return; // já tem uma nova aberta
  if (accountsCache.length === 0) list.innerHTML = "";
  list.insertAdjacentHTML("beforeend", accountCardHtml({}));
  bindAccountCard(list.lastElementChild); // só o novo — não re-bindar os existentes
  list.lastElementChild.querySelector(".acc-apelido")?.focus();
});

// ===== CSV =====
let csvHeaders = [];
let csvPhoneCol = null;
let csvPreview = [];

document.getElementById("csv-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch("/api/csv/upload", { method: "POST", body: fd });
  const j = await r.json();
  if (!r.ok) {
    alert(j.error || "Erro");
    return;
  }
  renderCSV(j);
});

async function loadCurrentCSV() {
  const r = await fetch("/api/csv/current");
  const j = await r.json();
  if (j.loaded) renderCSV(j);
}

function renderCSV(j) {
  csvHeaders = j.headers;
  csvPreview = j.preview || [];
  document.getElementById("csv-info").classList.remove("hidden");
  document.getElementById("csv-summary").textContent = `✅ ${j.filename} · ${j.total} linhas · colunas: ${j.headers.join(", ")}`;

  const phoneSel = document.getElementById("phone-col");
  phoneSel.innerHTML = j.headers.map((h) => `<option value="${escapeAttr(h)}">${escapeHtml(h)}</option>`).join("");
  csvPhoneCol = j.phoneCol || j.headers.find((h) => /celular|telefone|phone|whatsapp/i.test(h)) || null;
  if (csvPhoneCol) phoneSel.value = csvPhoneCol;

  const varDiv = document.getElementById("var-cols");
  varDiv.innerHTML = "";
  const remaining = j.headers.filter((h) => h !== phoneSel.value);
  if (remaining.length) addVarRow(remaining[0]);

  renderPreview();
}

function renderPreview() {
  const tbl = document.getElementById("preview-table");
  tbl.innerHTML =
    "<thead><tr>" +
    csvHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join("") +
    "</tr></thead><tbody>" +
    csvPreview
      .map(
        (row) =>
          "<tr>" +
          csvHeaders.map((h) => `<td title="${escapeAttr(row[h] ?? "")}">${escapeHtml(row[h] ?? "")}</td>`).join("") +
          "</tr>"
      )
      .join("") +
    "</tbody>";
}

document.getElementById("phone-col").addEventListener("change", async (e) => {
  csvPhoneCol = e.target.value;
  const r = await fetch("/api/csv/normalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneCol: csvPhoneCol }),
  });
  const j = await r.json();
  if (!r.ok) return alert(j.error || "Erro ao normalizar");
  csvPhoneCol = j.phoneCol;
  csvPreview = j.preview || [];
  renderPreview();
});

function addVarRow(defaultCol) {
  const div = document.createElement("div");
  div.className = "var-row";
  const idx = document.querySelectorAll("#var-cols .var-row").length + 1;
  div.innerHTML = `
    <b>{{${idx}}}</b>
    <select>${csvHeaders.map((h) => `<option value="${escapeAttr(h)}">${escapeHtml(h)}</option>`).join("")}</select>
    <button class="remove">Remover</button>`;
  if (defaultCol) div.querySelector("select").value = defaultCol;
  div.querySelector(".remove").addEventListener("click", () => {
    div.remove();
    reindexVars();
  });
  document.getElementById("var-cols").appendChild(div);
}

function reindexVars() {
  document.querySelectorAll("#var-cols .var-row").forEach((row, i) => {
    row.querySelector("b").textContent = `{{${i + 1}}}`;
  });
}

document.getElementById("add-var").addEventListener("click", (e) => {
  e.preventDefault();
  addVarRow(csvHeaders[0]);
});

// ===== Preview 1ª mensagem =====
async function renderPreviewFirstInto(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const phoneCol = document.getElementById("phone-col").value;
  const varCols = Array.from(document.querySelectorAll("#var-cols .var-row select")).map((s) => s.value);
  if (!phoneCol) return alert("Mapeie a coluna de telefone na aba 2");
  container.innerHTML = '<div class="muted">Carregando preview...</div>';
  try {
    // Passa a conta selecionada no disparo → backend resolve o template DA CONTA.
    const accountId = document.getElementById("disparo-account")?.value || "";
    const qs = new URLSearchParams({ phoneCol, varCols: varCols.join(","), accountId });
    const r = await fetch(`/api/disparo/preview-first?${qs}`);
    const j = await r.json();
    if (!r.ok) {
      container.innerHTML = `<div style="color:var(--error)">Erro: ${escapeHtml(j.error || "HTTP " + r.status)}</div>`;
      return;
    }
    const tmpl = j.template_name
      ? escapeHtml(j.template_name)
      : '<span style="color:var(--error)">⚠️ template não configurado</span>';
    const vars = j.variables.length
      ? j.variables
          .map((v) => `<div><b>{{${v.index}}}</b> <span class="muted">(${escapeHtml(v.column)})</span> = ${escapeHtml(v.value || "—")}</div>`)
          .join("")
      : '<div class="muted">Sem variáveis mapeadas.</div>';
    container.innerHTML = `
      <div class="card" style="text-align:left;">
        <div class="muted" style="font-size:12px; margin-bottom:8px;">PREVISÃO DO ENVIO</div>
        <div><b>Pra:</b> ${escapeHtml(j.phone || "—")}</div>
        <div><b>Template:</b> ${tmpl} <span class="muted">(${escapeHtml(j.language)})</span></div>
        <div style="margin-top:8px;">${vars}</div>
      </div>`;
  } catch (e) {
    container.innerHTML = `<div style="color:var(--error)">Erro: ${escapeHtml(e.message)}</div>`;
  }
}
document.getElementById("btn-preview-first")?.addEventListener("click", () => renderPreviewFirstInto("preview-first-container"));
document.getElementById("btn-preview-first-csv")?.addEventListener("click", () => renderPreviewFirstInto("preview-first-csv-container"));

// ===== Disparo: dropdown de contas =====
async function loadAccountsIntoDropdown() {
  // Sempre busca fresco — assim editar/remover conta na aba 1 reflete no dropdown
  // ao voltar pra aba 3 (cache podia ficar stale).
  const r = await fetch("/api/accounts");
  accountsCache = await r.json();
  const sel = document.getElementById("disparo-account");
  const prev = sel.value;
  if (!accountsCache.length) {
    sel.innerHTML = '<option value="">— cadastre uma conta na aba 1 —</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = accountsCache
    .map((a) => `<option value="${a.id}">${escapeHtml((a.icone || "") + " " + a.apelido)}</option>`)
    .join("");
  if (prev && accountsCache.find((a) => String(a.id) === prev)) sel.value = prev;
  // Se só 1 conta, pré-seleciona (já é o único option).
}

// ===== Disparo: cards multi-run + SSE =====
const runCards = {}; // runId → { logEl, counter, autoScroll }
let sse = null;

function attachSSE() {
  if (sse) return; // 1 conexão multiplexada serve todos os runs
  sse = new EventSource("/api/disparo/stream");
  sse.onmessage = (e) => {
    try {
      handleEvt(JSON.parse(e.data));
    } catch {}
  };
  // Se a conexão cair (rede/restart), zera a ref e reabre — senão o guard
  // `if (sse) return` travaria pra sempre numa EventSource morta.
  sse.onerror = () => {
    if (sse && sse.readyState === EventSource.CLOSED) {
      sse = null;
      setTimeout(attachSSE, 3000);
    }
  };
}

function statusPill(status) {
  return `<span class="status-pill ${status}">${status}</span>`;
}

function ensureCard(s) {
  let card = document.getElementById(`run-card-${s.runId}`);
  document.getElementById("no-runs-msg").style.display = "none";
  if (!card) {
    card = document.createElement("div");
    card.className = "run-card";
    card.id = `run-card-${s.runId}`;
    card.innerHTML = `
      <div class="run-card-head">
        <span class="run-card-title">${escapeHtml((s.icone || "") + " " + (s.apelido || "Conta"))} · <b>run #${s.runId}</b></span>
        <span class="run-card-status">${statusPill(s.status)}</span>
      </div>
      <div class="run-card-stats">
        <span>📋 <b class="rc-total">${s.total}</b></span>
        <span class="ok">✅ <b class="rc-env">${s.enviados}</b></span>
        <span class="err">❌ <b class="rc-fal">${s.falhas}</b></span>
        <span class="warn">⏭️ <b class="rc-pul">${s.pulados}</b></span>
        ${s.pauseAt ? `<span class="muted">pausa em ${s.pauseAt}</span>` : ""}
      </div>
      <div class="progress"><div class="rc-bar"></div></div>
      <pre class="log rc-log"></pre>
      <div class="row rc-actions">
        <button class="rc-pause ghost">⏸ Pausar</button>
        <button class="rc-abort danger">⏹ Abortar</button>
        <button class="rc-resume primary hidden">▶️ Continuar…</button>
      </div>`;
    document.getElementById("runs-cards").prepend(card);
    const logEl = card.querySelector(".rc-log");
    runCards[s.runId] = { logEl, counter: s.dispatched || 0, autoScroll: true };
    logEl.addEventListener("scroll", () => {
      const rc = runCards[s.runId];
      rc.autoScroll = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    });
    card.querySelector(".rc-pause").addEventListener("click", () => pauseRunUi(s.runId));
    card.querySelector(".rc-abort").addEventListener("click", () => abortRunUi(s.runId));
    card.querySelector(".rc-resume").addEventListener("click", () => openPauseModal(s.runId));
  }
  updateCard(s);
  return card;
}

function updateCard(s) {
  const card = document.getElementById(`run-card-${s.runId}`);
  if (!card) return;
  card.querySelector(".rc-total").textContent = s.total;
  card.querySelector(".rc-env").textContent = s.enviados;
  card.querySelector(".rc-fal").textContent = s.falhas;
  card.querySelector(".rc-pul").textContent = s.pulados;
  card.querySelector(".run-card-status").innerHTML = statusPill(s.status);
  const done = s.enviados + s.falhas + s.pulados;
  card.querySelector(".rc-bar").style.width = `${s.total ? (done / s.total) * 100 : 0}%`;
  const isPaused = s.status === "paused";
  const isActive = s.status === "running";
  card.querySelector(".rc-pause").classList.toggle("hidden", !isActive);
  card.querySelector(".rc-resume").classList.toggle("hidden", !isPaused);
  card.querySelector(".rc-abort").classList.toggle("hidden", s.status === "completed" || s.status === "aborted");
}

function appendRunLog(runId, line) {
  const rc = runCards[runId];
  if (!rc) return;
  rc.logEl.textContent += line + "\n";
  if (rc.autoScroll) rc.logEl.scrollTop = rc.logEl.scrollHeight;
}

function numberedLine(runId, icon, text) {
  const rc = runCards[runId];
  rc.counter = (rc.counter || 0) + 1;
  const n = String(rc.counter).padStart(4, " ");
  return `${n} - ${icon} ${text}`;
}

function handleEvt(evt) {
  const rid = evt.runId;
  if (evt.stats) {
    ensureCard(evt.stats); // garante card + atualiza números
  }
  if (!rid || !runCards[rid]) return;
  switch (evt.type) {
    case "success":
      appendRunLog(rid, numberedLine(rid, "✅", evt.phone));
      break;
    case "skip":
      appendRunLog(rid, numberedLine(rid, "⏭️", `${evt.phone} (já enviado)`));
      break;
    case "failure":
      appendRunLog(rid, numberedLine(rid, "❌", `${evt.phone} → ${evt.code}: ${evt.message}`));
      break;
    case "blocked":
      appendRunLog(rid, `🚫 BLOQUEIO ${evt.code}: ${evt.message}`);
      break;
    case "resumed":
      appendRunLog(rid, `▶️ retomado`);
      break;
    case "paused":
      appendRunLog(rid, `⏸ PAUSADO (${evt.reason}) — ${evt.sent} de ${evt.total}, restam ${evt.remaining}`);
      // Sempre atualiza o banner — se 2 runs pausam juntos, o modal abre pro 1º
      // e o 2º fica visível/retomável no banner (não some).
      loadPausedBanner();
      if (modalIsClosed() && !pauseModalBusy) openPauseModal(rid);
      break;
    case "done":
      appendRunLog(rid, `🏁 FINALIZADO (${evt.status})`);
      break;
  }
}

document.getElementById("btn-start").addEventListener("click", async () => {
  const accountId = document.getElementById("disparo-account").value;
  const phoneCol = document.getElementById("phone-col").value;
  const varCols = Array.from(document.querySelectorAll("#var-cols .var-row select")).map((s) => s.value);
  const skipDuplicates = document.getElementById("chk-skip-duplicates").checked;
  const pauseAtRaw = document.getElementById("disparo-pauseat").value.trim();
  const pauseAt = pauseAtRaw ? parseInt(pauseAtRaw, 10) : null;
  if (!accountId) return alert("Escolha a conta WhatsApp pra disparar (aba 1 pra cadastrar).");
  if (!phoneCol) return alert("Mapeie a coluna de telefone na aba 2");
  const acc = accountsCache.find((a) => String(a.id) === accountId);
  let msg = `Iniciar disparo pela conta "${acc?.apelido || accountId}"?\n\n`;
  msg += pauseAt ? `Vai pausar automaticamente após ${pauseAt} disparos.\n` : "";
  msg += skipDuplicates ? "Duplicados serão pulados." : "⚠️ Pular duplicados DESMARCADO — quem já recebeu vai receber DE NOVO.";
  if (!confirm(msg)) return;

  const r = await fetch("/api/disparo/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, phoneCol, varCols, skipDuplicates, pauseAt }),
  });
  const j = await r.json();
  if (!r.ok) return alert(j.error || "Erro");
  ensureCard(j.snapshot);
  appendRunLog(j.runId, `Disparo iniciado · run #${j.runId} · ${j.total} leads (${j.invalidos} inválidos descartados) · ${j.skipDuplicates ? "dedupe ON" : "dedupe OFF"}${j.pauseAt ? ` · pausa em ${j.pauseAt}` : ""}`);
  attachSSE();
});

async function pauseRunUi(runId) {
  await fetch(`/api/disparo/run/${runId}/pause`, { method: "POST" });
  // o evento "paused" via SSE abre o modal
}
async function abortRunUi(runId) {
  if (!confirm("Abortar o disparo? Os leads restantes serão descartados (você ainda pode baixar o CSV de pendentes pelo relatório).")) return;
  await fetch(`/api/disparo/run/${runId}/abort`, { method: "POST" });
}

// ===== Modal genérico =====
const backdrop = document.getElementById("modal-backdrop");
const modalContent = document.getElementById("modal-content");
function modalIsClosed() {
  return backdrop.classList.contains("hidden");
}
function openModal(html) {
  modalContent.innerHTML = html;
  backdrop.classList.remove("hidden");
}
function closeModal() {
  backdrop.classList.add("hidden");
  modalContent.innerHTML = "";
}
document.getElementById("modal-close").addEventListener("click", closeModal);
backdrop.addEventListener("click", (e) => {
  if (e.target === backdrop) closeModal();
});

// ===== Modal de PAUSA (4 opções) — PARTE 5 =====
let pauseModalBusy = false; // guarda contra duplo-clique / múltiplos eventos abrindo o modal
async function openPauseModal(runId) {
  if (pauseModalBusy) return;
  pauseModalBusy = true;
  try {
    await renderPauseModal(runId);
  } catch (e) {
    alert("Erro abrindo o painel de pausa: " + e.message);
  } finally {
    pauseModalBusy = false;
  }
}

async function renderPauseModal(runId) {
  const r = await fetch(`/api/disparo/run/${runId}`);
  const { run } = await r.json();
  const remaining = run.pending;
  const reasonTxt = run.pauseReason === "manual" ? "(pausa manual)" : run.pauseReason === "limit-reached" ? "(limite atingido)" : run.pauseReason ? `(${escapeHtml(run.pauseReason)})` : "";
  openModal(`
    <div class="pause-modal">
      <h3>⏸ Disparo pausado em ${run.dispatched} de ${run.total} <span class="muted">${reasonTxt}</span></h3>
      <p>Restam <b>${remaining}</b> leads não disparados${run.apelido ? ` · conta ${escapeHtml((run.icone || "") + " " + run.apelido)}` : ""}.</p>
      <a class="btn-dl" href="/api/disparo/run/${runId}/pending.csv">⬇ Baixar CSV dos NÃO disparados</a>
      <div class="pause-options">
        <label><input type="radio" name="pause-opt" value="all" checked /> Continuar disparando <b>TODOS</b> os ${remaining} restantes</label>
        <label><input type="radio" name="pause-opt" value="n" /> Continuar disparando apenas <input id="pause-n" type="number" min="1" max="${remaining}" value="${Math.min(remaining, 500)}" style="width:90px;" /> restantes</label>
        <label><input type="radio" name="pause-opt" value="abort" /> Encerrar disparo (descartar os ${remaining})</label>
      </div>
      <div class="row" style="margin-top:16px;">
        <button id="pause-confirm" class="primary">Confirmar</button>
        <button id="pause-later" class="ghost">Decidir depois</button>
      </div>
      <p class="hint">⚠️ Baixar o CSV não fecha esse modal nem muda o status. Em deploy o disparo pausado pode se perder — o CSV é a garantia real dos pendentes.</p>
    </div>`);
  document.getElementById("pause-confirm").addEventListener("click", async () => {
    const opt = document.querySelector('input[name="pause-opt"]:checked').value;
    if (opt === "abort") {
      await fetch(`/api/disparo/run/${runId}/abort`, { method: "POST" });
    } else if (opt === "n") {
      const n = parseInt(document.getElementById("pause-n").value, 10);
      if (!n || n < 1) return alert("Quantidade inválida");
      await fetch(`/api/disparo/run/${runId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: n }),
      });
      attachSSE();
    } else {
      await fetch(`/api/disparo/run/${runId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: "all" }),
      });
      attachSSE();
    }
    closeModal();
    loadPausedBanner();
  });
  document.getElementById("pause-later").addEventListener("click", () => {
    closeModal();
    loadPausedBanner();
  });
}

// ===== Banner de disparos pausados (sobrevive reload/restart) =====
async function loadPausedBanner() {
  const banner = document.getElementById("paused-banner");
  const r = await fetch("/api/disparo/my-paused-runs");
  const paused = await r.json();
  if (!paused.length) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }
  banner.classList.remove("hidden");
  banner.innerHTML =
    `<b>⏸ Você tem ${paused.length} disparo(s) pausado(s):</b> ` +
    paused
      .map(
        (p) =>
          `<button class="banner-run" data-id="${p.id}">${escapeHtml((p.acc_icone || "") + " " + (p.acc_apelido || "run"))} #${p.id} — ${p.dispatched}/${p.total} <span class="muted">retomar/ver</span></button>`
      )
      .join(" ");
  banner.querySelectorAll(".banner-run").forEach((b) => {
    b.addEventListener("click", () => openPauseModal(b.dataset.id));
  });
}

// Reconecta cards de runs ativos (running/paused) ao (re)carregar a aba.
async function loadActiveRuns() {
  const r = await fetch("/api/disparo/active");
  const j = await r.json();
  if (j.runs.length) {
    j.runs.forEach((s) => ensureCard(s));
    attachSSE();
  }
}

// ===== Relatórios =====
async function loadRuns() {
  const r = await fetch("/api/runs");
  const runs = await r.json();
  const list = document.getElementById("runs-list");
  if (!runs.length) {
    list.innerHTML = '<p class="muted">Nenhum disparo ainda.</p>';
    return;
  }
  list.innerHTML = runs
    .map((run) => {
      const acc = accLabel(run.acc_apelido, run.acc_icone, run.account_id);
      // Resuminho de entrega (só se houver dado de webhook) — PARTE 4.5.
      const deliv =
        run.delivered_cnt > 0 || run.read_cnt > 0
          ? `<span class="muted" title="entregues · lidas (via webhook)">📬 ${run.delivered_cnt} · 👁 ${run.read_cnt}</span>`
          : "";
      return `
    <div class="run-row" data-id="${run.id}">
      <span><b>#${run.id}</b></span>
      <span class="run-acc">${acc}</span>
      <span class="status-pill ${run.status}">${run.status}</span>
      <span class="muted">${escapeHtml(fmtTs(run.started_at))}</span>
      <span style="margin-left:auto; display:flex; align-items:center; gap:12px;">
        <span>✅ ${run.enviados} · ❌ ${run.falhas} · 📋 ${run.total}</span>
        ${deliv}
        <button class="btn-row-download" data-id="${run.id}" title="Baixar relatório CSV" style="padding:4px 10px; font-size:12px;">⬇️ Baixar</button>
      </span>
    </div>`;
    })
    .join("");
  list.querySelectorAll(".run-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".btn-row-download")) return;
      openReportModal(row.dataset.id);
    });
  });
  list.querySelectorAll(".btn-row-download").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadUrl(`/api/runs/${btn.dataset.id}/download`);
    });
  });
}

function downloadUrl(url) {
  const link = document.createElement("a");
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ===== Modal de RELATÓRIO (PARTE 4) =====
async function openReportModal(id) {
  const r = await fetch(`/api/disparo/run/${id}`);
  const { run, counts, deliveryCounts, results } = await r.json();
  const cor = run.cor || "#8b949e";
  const acc = accLabel(run.apelido, run.icone, run.account_id);
  // Linha de ENTREGA (PARTE 4.4) — read conta como entregue (read ⊃ delivered).
  const dc = deliveryCounts || {};
  const entregues = (dc.delivered || 0) + (dc.read || 0);
  const semConf = (run.enviados || 0) - entregues - (dc.failed || 0);
  const deliveryLine = dc.hasWebhook
    ? `<div class="delivery-line">📬 <b>${entregues}</b> entregues · 👁 <b>${dc.read || 0}</b> lidas · ❌ <b>${dc.failed || 0}</b> falhas de entrega · ⏳ ${Math.max(0, semConf)} sem confirmação</div>`
    : `<div class="delivery-line muted">📭 Sem dados de entrega ainda — configure o webhook na Meta (ver instruções) ou aguarde os callbacks.</div>`;
  const last = results.slice(-50).reverse();
  const rowsHtml = last.length
    ? last
        .map((x) => `<tr><td>${escapeHtml(x.phone)}</td><td>${escapeHtml(x.status)}</td><td>${escapeHtml(x.delivery_status || "—")}</td><td title="${escapeAttr(x.motivo || "")}">${escapeHtml((x.motivo || "").slice(0, 50))}</td></tr>`)
        .join("")
    : '<tr><td colspan="4" class="muted">Sem resultados.</td></tr>';
  openModal(`
    <div class="report-modal">
      <h3><span class="account-swatch" style="background:${escapeAttr(cor)}"></span> ${acc} · run #${run.id} ${statusPill(run.status)}</h3>
      <div class="report-grid">
        <div><span class="muted">WhatsApp</span><br>${escapeHtml(run.numero || "—")}</div>
        <div><span class="muted">Phone Number ID</span><br>${escapeHtml(run.phone_number_id || "—")}</div>
        <div><span class="muted">WABA ID</span><br>${escapeHtml(run.waba_id || "—")}</div>
        <div><span class="muted">Lista</span><br>${escapeHtml(run.filename || "—")}</div>
        <div><span class="muted">Template</span><br>${escapeHtml(run.template_name || "—")}</div>
        <div><span class="muted">Início</span><br>${escapeHtml(fmtTs(run.started_at))}</div>
        <div><span class="muted">Fim</span><br>${escapeHtml(fmtTs(run.finished_at))}</div>
      </div>
      <div class="run-card-stats" style="margin:12px 0;">
        <span>📋 <b>${run.total}</b></span>
        <span class="ok">✅ <b>${run.enviados}</b></span>
        <span class="err">❌ <b>${run.falhas}</b></span>
        <span class="warn">⏭️ <b>${run.pulados}</b></span>
        <span class="muted">pendentes: <b>${counts.pending}</b></span>
      </div>
      ${deliveryLine}
      <div class="row" style="flex-wrap:wrap; gap:8px;">
        <button id="rep-dl-all" class="ghost">⬇️ Baixar CSV completo</button>
        <button id="rep-dl-report" class="ghost">⬇️ Baixar relatório (entrega)</button>
        ${counts.pending > 0 ? '<button id="rep-dl-pending" class="ghost">⬇️ Baixar CSV NÃO disparados</button>' : ""}
        ${run.status === "paused" ? '<button id="rep-continue" class="primary">▶️ Continuar disparo</button>' : ""}
      </div>
      <h4 style="margin:16px 0 6px;">Últimos ${last.length} números</h4>
      <div class="table-wrap" style="max-height:240px; overflow:auto;">
        <table><thead><tr><th>Telefone</th><th>Status</th><th>Entrega</th><th>Motivo</th></tr></thead><tbody>${rowsHtml}</tbody></table>
      </div>
    </div>`);
  document.getElementById("rep-dl-all")?.addEventListener("click", () => downloadUrl(`/api/disparo/run/${id}/all.csv`));
  document.getElementById("rep-dl-report")?.addEventListener("click", () => downloadUrl(`/api/runs/${id}/download`));
  document.getElementById("rep-dl-pending")?.addEventListener("click", () => downloadUrl(`/api/disparo/run/${id}/pending.csv`));
  document.getElementById("rep-continue")?.addEventListener("click", () => openPauseModal(id));
}

// ===== Init =====
loadConfig();
loadAccounts();
loadCurrentCSV();
loadActiveRuns();
loadPausedBanner();
