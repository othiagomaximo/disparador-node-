// ───────────────────────────────────────────────────────────────────────────
// Classificador de erros SÍNCRONOS da Cloud API da Meta (prompt 26).
// Traduz o código/mensagem cru que a Meta devolve NO POST de envio para uma
// categoria + label PT-BR + dica do que fazer. NÃO mexe em entrega/leitura real
// (isso só viria do webhook — fora de escopo).
// ───────────────────────────────────────────────────────────────────────────

// Tabela de exibição por categoria — usada no breakdown agrupado do relatório.
export const CATEGORIAS = {
  limite:   { emoji: "🚫", short: "limite",          label: "🚫 Limite de mensagens da conta atingido" },
  template: { emoji: "📋", short: "template",        label: "📋 Problema no template (nome/idioma/variáveis)" },
  token:    { emoji: "🔑", short: "token inválido",  label: "🔑 Token inválido ou expirado" },
  numero:   { emoji: "📵", short: "número inválido", label: "📵 Número inválido" },
  rede:     { emoji: "🌐", short: "rede/timeout",    label: "🌐 Erro de rede/timeout" },
  param:    { emoji: "❓", short: "parâmetro",        label: "❓ Parâmetro inválido" },
  outro:    { emoji: "⚠️", short: "outro",            label: "⚠️ Outro erro" },
};

// Mapas de código → categoria. (Não duplicam o ERROS_BLOQUEIO de cloud-api.js —
// aquele decide QUANDO o engine pausa; estes decidem COMO descrever o erro.)
const LIMITE = new Set([131049, 131048, 130429, 368, 80007]);
const QUALIDADE = new Set([131056, 133000]); // também categoria "limite"
const TOKEN = new Set([190, 0, 10, 200, 463]);
const TEMPLATE = new Set([131008, 132000, 132001, 132005, 132007, 132012, 132015, 132016]);
const PARAM = new Set([100, 33, 131009]);
// Códigos de destinatário/entrega imediata inválida → categoria "numero".
const NUMERO = new Set([131026, 131000, 131005, 131021, 131051, 470]);

function make(categoria, label, dica, severidade) {
  return { categoria, label, dica, severidade };
}

/**
 * classifyMetaError({ code, message }) → { categoria, label, dica, severidade }
 * severidade: "bloqueio" (conta travada — vale parar/trocar) | "linha" (só essa linha)
 */
export function classifyMetaError({ code, message } = {}) {
  const c = code == null || code === "" ? null : Number(code);
  const hasCode = c != null && !Number.isNaN(c);
  const msg = String(message ?? "");
  const low = msg.toLowerCase();

  if (hasCode) {
    if (LIMITE.has(c))
      return make("limite", "🚫 Limite de mensagens da conta atingido", "Troque de conta WhatsApp (essa atingiu o limite).", "bloqueio");
    if (QUALIDADE.has(c))
      return make("limite", "🚫 Conta pausada por qualidade/spam", "A conta foi limitada pela Meta. Troque de conta.", "bloqueio");
    if (TOKEN.has(c))
      return make("token", "🔑 Token inválido ou expirado", "Atualize o token da conta na aba 1.", "bloqueio");
    if (TEMPLATE.has(c))
      return make("template", "📋 Problema no template (nome/idioma/variáveis)", "Confira o nome do template, o idioma e o número de variáveis no Meta.", "bloqueio");
    if (PARAM.has(c))
      return make("param", "❓ Parâmetro inválido", "Confira o mapeamento das variáveis/coluna.", "linha");
    if (NUMERO.has(c))
      return make("numero", "📵 Número inválido", "Número fora do padrão ou sem WhatsApp; será pulado.", "linha");
  }

  // Sem código mapeado → olha a mensagem.
  if (/network|timeout|fetch failed|econn|socket hang|aborted|getaddrinfo|enotfound/.test(low))
    return make("rede", "🌐 Erro de rede/timeout", "Falha de conexão com a Meta; pode reenviar depois.", "linha");
  if (/inv[aá]lid|n[uú]mero|recipient|not.*(valid|exist)|undeliverable|too short|curto/.test(low))
    return make("numero", "📵 Número inválido", "Número fora do padrão; será pulado.", "linha");

  // Qualquer outro — preserva código e mensagem original (curta).
  const codeLabel = hasCode ? c : "?";
  const shortMsg = msg.slice(0, 80) || "sem detalhe";
  return make("outro", `⚠️ Erro Meta ${codeLabel}: ${shortMsg}`, "Erro não mapeado — ver detalhe no relatório.", "linha");
}

// Label compacta da categoria (pro breakdown: "🚫 150 limite").
export function categoriaShort(categoria) {
  return CATEGORIAS[categoria] || CATEGORIAS.outro;
}
