// Normaliza telefones BR pra E.164 sem +
export function normalizePhone(input) {
  if (!input) return null;
  const d = String(input).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  if (d.length < 10) return null;
  return d; // internacional sem 55
}
