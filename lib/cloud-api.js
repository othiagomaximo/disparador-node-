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

  // Loga o payload EXATO enviado pra Meta (curl reproduzível via logs Hostinger).
  console.log(
    JSON.stringify(
      {
        event: "meta-send",
        to: body.to,
        template_name: body.template?.name,
        payload: body,
        timestamp: Date.now(),
      },
      null,
      2
    )
  );

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
    // Loga a resposta da Meta — body completo pra diagnosticar 131008 etc.
    console.log(
      JSON.stringify(
        {
          event: "meta-response",
          to: body.to,
          status: res.status,
          body: json,
          timestamp: Date.now(),
        },
        null,
        2
      )
    );
    // ⚠️ DETECÇÃO DE FALHA REAL (fix dos "stats mentirosos"):
    // NÃO basta HTTP 2xx. A Meta às vezes devolve 200 com {"error": {...}}
    // no body, ou um 200 sem messages[] — nesses casos a mensagem NÃO foi
    // aceita. Só contamos como ENVIADO quando há messages[0].id (wamid).
    const err = json?.error || {};
    const failReason =
      res.status >= 400
        ? "http"
        : json?.error
        ? "error-body"
        : !Array.isArray(json?.messages) || json.messages.length === 0
        ? "no-messages"
        : null;

    if (failReason) {
      let message;
      if (failReason === "no-messages") {
        message = "Resposta da Meta sem messages[] — provável falha silenciosa";
      } else {
        message = (err.message || `HTTP ${res.status}`).slice(0, 200);
      }
      // Enriquece o 131008 com hint do provável mismatch de variáveis do template.
      if (err.code === 131008) {
        message =
          `131008: Required parameter is missing — provavel mismatch entre as ` +
          `variaveis configuradas e as exigidas pelo template aprovado. Confere ` +
          `se o template no Meta tem {{1}}..{{N}} e se o disparador ta mapeando todos.`;
      }
      return {
        ok: false,
        code: err.code ?? null,
        message,
        bloqueio: ERROS_BLOQUEIO.has(err.code),
      };
    }

    // Sucesso REAL: HTTP ok, sem error no body, e com wamid de confirmação.
    return { ok: true, wamid: json.messages[0].id };
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
