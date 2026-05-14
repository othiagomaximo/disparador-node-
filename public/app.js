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
  });
});

// ===== Config =====
async function loadConfig() {
  const r = await fetch("/api/config");
  const cfg = await r.json();
  for (const k of ["access_token", "phone_number_id", "template_name", "language", "concurrency"]) {
    const el = document.getElementById(`cfg-${k}`);
    if (el && cfg[k] != null) el.value = cfg[k];
  }
}

document.getElementById("save-config").addEventListener("click", async () => {
  const body = {
    access_token: document.getElementById("cfg-access_token").value.trim(),
    phone_number_id: document.getElementById("cfg-phone_number_id").value.trim(),
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

// ===== CSV =====
let csvHeaders = [];

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
  document.getElementById("csv-info").classList.remove("hidden");
  document.getElementById("csv-summary").textContent = `✅ ${j.filename} · ${j.total} linhas · colunas: ${j.headers.join(", ")}`;

  const phoneSel = document.getElementById("phone-col");
  phoneSel.innerHTML = j.headers
    .map((h) => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`)
    .join("");
  // tenta achar a coluna de telefone automaticamente
  const guess = j.headers.find((h) => /celular|telefone|phone|whatsapp/i.test(h));
  if (guess) phoneSel.value = guess;

  // variáveis: começa com a primeira coluna não-telefone
  const varDiv = document.getElementById("var-cols");
  varDiv.innerHTML = "";
  const remaining = j.headers.filter((h) => h !== phoneSel.value);
  if (remaining.length) addVarRow(remaining[0]);

  // preview table
  const tbl = document.getElementById("preview-table");
  tbl.innerHTML =
    "<thead><tr>" +
    j.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("") +
    "</tr></thead><tbody>" +
    j.preview
      .map(
        (row) =>
          "<tr>" +
          j.headers
            .map((h) => `<td title="${escapeAttr(row[h] ?? "")}">${escapeHtml(row[h] ?? "")}</td>`)
            .join("") +
          "</tr>"
      )
      .join("") +
    "</tbody>";
}

function addVarRow(defaultCol) {
  const div = document.createElement("div");
  div.className = "var-row";
  const idx = document.querySelectorAll("#var-cols .var-row").length + 1;
  div.innerHTML = `
    <b>{{${idx}}}</b>
    <select>${csvHeaders.map((h) => `<option value="${escapeAttr(h)}">${escapeHtml(h)}</option>`).join("")}</select>
    <button class="remove">Remover</button>
  `;
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

// ===== Disparo =====
let evtSource = null;

document.getElementById("btn-start").addEventListener("click", async () => {
  const phoneCol = document.getElementById("phone-col").value;
  const varCols = Array.from(document.querySelectorAll("#var-cols .var-row select")).map((s) => s.value);
  const skipDuplicates = document.getElementById("chk-skip-duplicates").checked;
  if (!phoneCol) return alert("Mapeie a coluna de telefone na aba 2");
  const msg = skipDuplicates
    ? "Iniciar disparo agora?\n\nDuplicados serão pulados."
    : "Iniciar disparo agora?\n\n⚠️ ATENÇÃO: a opção de pular duplicados está DESMARCADA.\nNúmeros que já receberam vão receber DE NOVO.";
  if (!confirm(msg)) return;

  const r = await fetch("/api/disparo/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneCol, varCols, skipDuplicates }),
  });
  const j = await r.json();
  if (!r.ok) {
    alert(j.error || "Erro");
    return;
  }
  document.getElementById("stat-total").textContent = j.total;
  const dedupeLabel = j.skipDuplicates ? "dedupe ON" : "dedupe OFF";
  appendLog(`Disparo iniciado · run #${j.runId} · ${j.total} leads (${j.invalidos} inválidos descartados) · ${dedupeLabel}`);
  attachSSE();
});

document.getElementById("btn-stop").addEventListener("click", async () => {
  if (!confirm("Parar disparo?")) return;
  await fetch("/api/disparo/stop", { method: "POST" });
});

function attachSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource("/api/disparo/stream");
  evtSource.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      handleEvt(evt);
    } catch {}
  };
  evtSource.onerror = () => {};
}

function handleEvt(evt) {
  const s = evt.stats;
  if (s) {
    document.getElementById("stat-total").textContent = s.total;
    document.getElementById("stat-enviados").textContent = s.enviados;
    document.getElementById("stat-falhas").textContent = s.falhas;
    document.getElementById("stat-pulados").textContent = s.pulados;
    const done = s.enviados + s.falhas + s.pulados;
    document.getElementById("progress-bar").style.width = `${(done / s.total) * 100}%`;
  }
  if (evt.type === "success") appendLog(`✅ ${evt.phone}`);
  if (evt.type === "skip") appendLog(`⏭️  ${evt.phone} (já enviado)`);
  if (evt.type === "failure") appendLog(`❌ ${evt.phone}  → ${evt.code}: ${evt.message}`);
  if (evt.type === "blocked") appendLog(`🚫 BLOQUEIO ${evt.code}: ${evt.message}`);
  if (evt.type === "done") {
    appendLog(`🏁 FINALIZADO (${evt.status})`);
    if (evtSource) evtSource.close();
  }
}

function appendLog(line) {
  const log = document.getElementById("log");
  log.textContent += line + "\n";
  log.scrollTop = log.scrollHeight;
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
    .map(
      (run) => `
    <div class="run-row" data-id="${run.id}">
      <span><b>#${run.id}</b></span>
      <span class="status-pill ${run.status}">${run.status}</span>
      <span class="muted">${run.started_at}</span>
      <span style="margin-left:auto">
        ✅ ${run.enviados} · ❌ ${run.falhas} · 📋 ${run.total}
      </span>
    </div>
  `
    )
    .join("");
  list.querySelectorAll(".run-row").forEach((row) => {
    row.addEventListener("click", () => loadRunDetail(row.dataset.id));
  });
}

let currentRunResults = [];

async function loadRunDetail(id) {
  const r = await fetch(`/api/runs/${id}`);
  const { run, results } = await r.json();
  currentRunResults = results;
  document.getElementById("run-detail").classList.remove("hidden");
  document.getElementById("run-title").textContent = `Run #${run.id} — ${run.status} — ${run.enviados} enviados, ${run.falhas} falhas`;
  document.getElementById("btn-download-csv").onclick = () => {
    window.location = `/api/runs/${id}/download`;
  };
  const filterSel = document.getElementById("delivery-filter");
  filterSel.value = "all";
  filterSel.onchange = () => renderResults(currentRunResults, filterSel.value);
  renderResults(results, "all");
}

// Renderiza badge colorida pro delivery_status real (vindo do webhook).
// Volta texto cinza pro accepted (resposta da API) quando ainda não chegou webhook.
function deliveryBadge(r) {
  const ds = r.delivery_status;
  if (ds === "read") return `<span class="badge badge-read">👁 read</span>`;
  if (ds === "delivered") return `<span class="badge badge-delivered">✅ delivered</span>`;
  if (ds === "sent") return `<span class="badge badge-sent">📨 sent</span>`;
  if (ds === "failed") {
    const err = r.delivery_error ? ` (${escapeHtml(r.delivery_error)})` : "";
    return `<span class="badge badge-failed" title="${escapeAttr(r.delivery_error || "")}">❌ failed${err}</span>`;
  }
  // Sem update de webhook ainda: mostra "accepted" se a API aceitou
  if (r.status === "ENVIADO") return `<span class="badge badge-accepted">⏳ accepted</span>`;
  return `<span class="muted">—</span>`;
}

function passesFilter(r, filter) {
  if (filter === "all") return true;
  const ds = r.delivery_status;
  if (filter === "delivered") return ds === "delivered" || ds === "read";
  if (filter === "read") return ds === "read";
  if (filter === "failed") return ds === "failed";
  if (filter === "not_delivered") {
    // Não entregues = qualquer um que foi ENVIADO mas não temos confirmação de delivered/read,
    // ou que falhou pelo webhook.
    if (r.status !== "ENVIADO" && r.status !== "PULADO" && !r.status?.startsWith?.("FALHA"))
      return false;
    if (ds === "failed") return true;
    if (r.status === "ENVIADO" && ds !== "delivered" && ds !== "read") return true;
    return false;
  }
  return true;
}

function renderResults(results, filter) {
  const filtered = results.filter((r) => passesFilter(r, filter));
  const tbl = document.getElementById("results-table");
  if (!filtered.length) {
    tbl.innerHTML =
      "<thead><tr><th>Telefone</th><th>Status</th><th>Entrega</th><th>WAMID</th><th>Motivo</th></tr></thead>" +
      `<tbody><tr><td colspan="5" class="muted" style="text-align:center; padding:16px;">Nenhum resultado pra esse filtro.</td></tr></tbody>`;
    return;
  }
  tbl.innerHTML =
    "<thead><tr><th>Telefone</th><th>Status</th><th>Entrega</th><th>WAMID</th><th>Motivo</th></tr></thead><tbody>" +
    filtered
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.phone)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${deliveryBadge(r)}</td>
        <td title="${escapeAttr(r.wamid || "")}">${escapeHtml((r.wamid || "").slice(0, 30))}</td>
        <td title="${escapeAttr(r.motivo || "")}">${escapeHtml((r.motivo || "").slice(0, 60))}</td>
      </tr>
    `
      )
      .join("") +
    "</tbody>";
}

// ===== Utils =====
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// ===== Limpar credenciais =====
document.getElementById("btn-clear-creds").addEventListener("click", async () => {
  if (!confirm("Apagar token, phone ID e template salvos? Você terá que digitar tudo de novo na próxima vez.")) return;
  const r = await fetch("/api/config/clear", { method: "POST" });
  if (r.ok) {
    for (const k of ["access_token", "phone_number_id", "template_name", "language", "concurrency"]) {
      const el = document.getElementById(`cfg-${k}`);
      if (el) el.value = "";
    }
    alert("✅ Credenciais apagadas!");
  } else {
    alert("❌ Erro ao apagar");
  }
});

// ===== Init =====
loadConfig();
loadCurrentCSV();
