import { reserveGeminiRequest, useGeminiCache } from "./gemini-storage.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";

async function callGeminiRaw(prompt, systemInstruction, env, { asJson = false, channel = "interactive" } = {}) {
  const apiKey = env?.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: "NO_API_KEY", message: "Gemini todavía no está configurado." };
  }

  try {
    if (!await reserveGeminiRequest(env.DB, channel)) {
      return { ok: false, status: 429, error: "QUOTA_EXHAUSTED", message: "Se alcanzó el límite diario de Gemini." };
    }
  } catch {
    console.warn("gemini-quota-unavailable");
    return { ok: false, status: 503, error: "QUOTA_UNAVAILABLE", message: "Gemini no está disponible en este momento." };
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1000,
      ...(asJson ? { responseMimeType: "application/json" } : {})
    }
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return {
        ok: false,
        error: "GEMINI_ERROR",
        message: response.status === 429
          ? "Gemini alcanzó su límite de uso. Probá más tarde."
          : "Gemini no está disponible en este momento.",
        status: response.status === 429 ? 429 : 502
      };
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof candidate !== "string" || !candidate.trim()) {
      return { ok: false, status: 502, error: "EMPTY_RESPONSE", message: "Respuesta vacía de Gemini." };
    }

    return { ok: true, text: candidate };
  } catch {
    return { ok: false, status: 502, error: "NETWORK_ERROR", message: "Error al conectar con Gemini." };
  }
}

export async function generateWeatherOverview(ctx, env) {
  const systemPrompt = `Eres el asistente meteorológico inteligente de la aplicación "Clima Consenso".
Tu tono es profesional, amigable, claro y natural (español de Argentina).
Analiza los datos reales del pronóstico y devuelve un JSON estricto con las 4 claves especificadas.
Usa solo los datos provistos. Diferencia observación, estimación de modelos y pronóstico. Los valores ausentes o parciales son desconocidos.
Describe el desacuerdo según la evidencia, sin asignar a un modelo mayor precisión por su resolución. Las alertas se explican con los horarios y las recomendaciones oficiales provistas.
No uses markdown fuera del JSON. Devuelve únicamente el objeto JSON.`;

  const userPrompt = `Analiza estos datos meteorológicos actuales y de consenso entre modelos:
Ubicación: ${ctx.location || "Buenos Aires"}
Hora local: ${ctx.dateHour || ctx.localTime || "Actual"}
Temperatura actual: ${ctx.temp != null ? ctx.temp + "°C" : "Desconocida"} (Sensación: ${ctx.apparent != null ? ctx.apparent + "°C" : "—"})
Humedad: ${ctx.humidity != null ? ctx.humidity + "%" : "—"}, Precipitación del modelo: ${ctx.precip != null ? ctx.precip + " mm" : "desconocida"}
Condición: ${ctx.condition || "desconocida"}
Fuente actual: ${ctx.observationDetail || "Consenso de los modelos disponibles"}
Próxima lluvia: ${ctx.rainOutlook || "Incierta"}
Consenso de modelos (SMN, ECMWF, GFS, ICON):
${ctx.modelsDetail || "No disponible"}
Próximas horas: ${ctx.hourlySummary || "Sin datos horarios"}
Próximos días: ${ctx.dailySummary || "Sin datos diarios"}
Alertas y cobertura del SMN: ${ctx.alertsDetail}

Genera un JSON con esta estructura exacta:
{
  "summary": "Parte meteorológico en lenguaje natural (2 a 3 oraciones concisas y útiles). Destaca cómo se siente el día y qué esperar.",
  "discrepancies": "Explica qué prevé cada modelo cuando hay diferencias. Indica el grado de acuerdo y los modelos que no disponen de datos.",
  "lifestyle": {
    "outfit": "Recomendación práctica de ropa para el día y la noche.",
    "outdoor": "Mejor franja horaria para pasear, correr o actividad al aire libre.",
    "laundry": "Recomendación para secar/colgar ropa (viento, humedad, riesgo de lluvia)."
  },
  "alertsSummary": ${["active", "partial"].includes(ctx.alertsStatus) ? '"Resume el fenómeno, zona, vigencia e instrucciones oficiales disponibles."' : 'null'}
}`;

  const cacheParts = [
    "overview", GEMINI_API_URL, ctx.locationId, ctx.lat, ctx.lon,
    ctx.forecastRevision, ctx.alertsRevision, systemPrompt, userPrompt,
  ];
  return useGeminiCache(env.DB, cacheParts, async () => {
    const result = await callGeminiRaw(userPrompt, systemPrompt, env, { asJson: true });
    if (!result.ok) return result;
    try {
      const data = JSON.parse(result.text);
      const fields = [data?.summary, data?.discrepancies, data?.lifestyle?.outfit,
        data?.lifestyle?.outdoor, data?.lifestyle?.laundry];
      if (fields.every((field) => typeof field === "string" && field.trim()) &&
        (data.alertsSummary === null || typeof data.alertsSummary === "string")) {
        if (!["active", "partial"].includes(ctx.alertsStatus)) data.alertsSummary = null;
        return { ok: true, data };
      }
    } catch {
      // Una respuesta inválida no debe quedar en caché.
    }
    return { ok: false, status: 502, error: "INVALID_RESPONSE", message: "Gemini devolvió un parte incompleto." };
  });
}

export async function chatWithGemini(question, weatherContext, env) {
  const systemPrompt = `Eres el copiloto meteorológico de la aplicación "Clima Consenso".
Respondes preguntas cotidianas sobre el clima de forma directa, útil, precisa y concisa (español de Argentina).
Usa EXCLUSIVAMENTE los datos meteorológicos provistos (consenso entre SMN, ECMWF, GFS e ICON).
Si faltan datos o hay desacuerdo, expresa la incertidumbre. Conserva los horarios, niveles y recomendaciones oficiales de las alertas.
Si te preguntan por horarios de lluvia, actividades, ropa o planes, da una respuesta clara y concreta en 1 o 2 párrafos breves.`;

  const prompt = `Datos meteorológicos actuales para ${weatherContext.location || "la ubicación"}:
- Hora local: ${weatherContext.dateHour || weatherContext.localTime}
- Temperatura en °C: ${weatherContext.temp ?? "desconocida"} (sensación: ${weatherContext.apparent ?? "desconocida"})
- Fuente: ${weatherContext.observationDetail || "Consenso de los modelos disponibles"}
- Condición: ${weatherContext.condition || "desconocida"}
- Humedad en %: ${weatherContext.humidity ?? "desconocida"}, precipitación estimada en mm: ${weatherContext.precip ?? "desconocida"}
- Modelos: ${weatherContext.modelsDetail || "Sin detalle"}
- Pronóstico lluvia 24h: ${weatherContext.rainOutlook || "Incierto"}
- Próximas horas: ${weatherContext.hourlySummary || ""}
- Próximos 7 días: ${weatherContext.dailySummary || ""}
- Alertas y cobertura del SMN: ${weatherContext.alertsDetail}

Pregunta del usuario: "${question}"`;

  return await callGeminiRaw(prompt, systemPrompt, env);
}

export async function rewriteSummaryNotification(body, night, eventKey, env) {
  if (!env?.GEMINI_API_KEY) return body;

  const period = night ? "la madrugada" : "el resumen del día";
  const prompt = `Crea una notificación push ultra concisa (máximo 100 caracteres) en tono amigable argentino para ${period}: ${body}. Solo el texto de la notificación sin comillas.`;
  const instructions = "Conserva los valores, el lugar y la vigencia del pronóstico provisto. No agregues fenómenos ni condiciones. Escribe una sola línea de hasta 100 caracteres.";
  const cacheParts = ["push", GEMINI_API_URL, eventKey, instructions, prompt];
  const result = await useGeminiCache(env.DB, cacheParts, async () => {
    const response = await callGeminiRaw(prompt, instructions, env, { channel: "push" });
    if (!response.ok) return response;
    const text = response.text.trim().replace(/^["']|["']$/g, "").trim();
    return text && Array.from(text).length <= 100 && !/[\r\n]/.test(text)
      ? { ok: true, text }
      : { ok: false };
  });
  return result.ok ? result.text : body;
}
