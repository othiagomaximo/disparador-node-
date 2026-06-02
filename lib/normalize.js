// Normaliza telefones BR pra E.164 sem +

// Só dígitos
export function cleanPhone(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

// Versão "simples" — retorna string normalizada ou null pra inválido.
// Usada no caminho de disparo (filtra inválidos como descartados).
export function normalizePhone(input) {
  if (!input) return null;
  const d = cleanPhone(input);
  if (!d) return null;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  if (d.length < 10) return null;
  return d; // internacional sem 55
}

// Versão detalhada — pra preview do frontend (não quebra normalizePhone acima).
// Retorna { original, normalized, changed, reason }.
//   reason: empty | already-55 | added-55 | invalid-length | intl
//   changed=true só quando o 55 foi ADICIONADO automaticamente (destaque verde).
export function normalizePhoneDetailed(raw) {
  const cleaned = cleanPhone(raw);
  if (!cleaned) {
    return { original: raw ?? "", normalized: "", changed: false, reason: "empty" };
  }
  if (cleaned.startsWith("55") && (cleaned.length === 12 || cleaned.length === 13)) {
    return { original: raw, normalized: cleaned, changed: false, reason: "already-55" };
  }
  if (cleaned.length === 10 || cleaned.length === 11) {
    return { original: raw, normalized: "55" + cleaned, changed: true, reason: "added-55" };
  }
  if (cleaned.length < 10) {
    return { original: raw, normalized: cleaned, changed: false, reason: "invalid-length" };
  }
  return { original: raw, normalized: cleaned, changed: false, reason: "intl" };
}

// Força adicionar 55 onde não tem (botão de emergência "+ 55 em todos")
export function forceAdd55(raw) {
  const cleaned = cleanPhone(raw);
  if (!cleaned) return "";
  if (cleaned.startsWith("55")) return cleaned;
  return "55" + cleaned;
}

// Força remover 55 do início onde tem (botão de emergência "- 55 de todos")
export function forceRemove55(raw) {
  const cleaned = cleanPhone(raw);
  if (cleaned.startsWith("55") && cleaned.length >= 12) return cleaned.slice(2);
  return cleaned;
}
