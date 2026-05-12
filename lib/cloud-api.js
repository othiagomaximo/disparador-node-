// Códigos da Meta que param o disparo automaticamente (BM travada, spam, etc)
export const ERROS_BLOQUEIO = new Set([
  368, 131048, 131049, 131056, 131031, 133000, 132012, 132015, 132016, 190,
]);

const API_VERSION = process.env.META_API_VERSION || "v22.0";

export async function sendTemplate({
  accessToken,
  phoneNumberId,
  toPhone,
  templateName,
  language,
  parameters,
  timeoutMs = 20000,
}) {
  const url = `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language || "pt_BR" },
      components: parameters?.length
        ? [
            {
              type: "body",
              parameters: parameters.map((p) => ({ type: "text", text: String(p ?? "") })),
            },
          ]
        : [],
    },
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const wamid = json?.messages?.[0]?.id || "";
      return { ok: true, wamid };
    }
    const err = json?.error || {};
    return {
      ok: false,
      code: err.code ?? null,
      message: (err.message || "").slice(0, 200),
      bloqueio: ERROS_BLOQUEIO.has(err.code),
    };
  } catch (e) {
    return {
      ok: false,
      code: null,
      message: `network: ${e.message || e}`.slice(0, 200),
      bloqueio: false,
    };
  } finally {
    clearTimeout(t);
  }
}
