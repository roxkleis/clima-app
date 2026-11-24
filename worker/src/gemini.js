// Módulo de Inteligencia Artificial con Gemini 2.5/1.5 Flash (Nivel Gratuito)
// Diseñado para máximo ahorro de cuota (caching de 45 min y llamadas agrupadas).

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GEMINI_FALLBACK_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

function getApiKey(env, clientKey) {
  return env?.GEMINI_API_KEY || clientKey || null;
}

export async function callGeminiRaw(prompt, systemInstruction, env, clientKey, asJson = false) {
  const apiKey = getApiKey(env, clientKey);
  if (!apiKey) {
    return { ok: false, error: "NO_API_KEY", message: "Clave de Gemini API no configurada." };
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

  const tryFetch = async (url) => {
    return await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
  };

  try {
    let response = await tryFetch(GEMINI_API_URL);
    if (!response.ok && response.status === 404) {
      // Fallback a 1.5 Flash si 2.5 aún no estuviera disponible en esa región
      response = await tryFetch(GEMINI_FALLBACK_URL);
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const msg = errData?.error?.message || `HTTP ${response.status}`;
      return { ok: false, error: "GEMINI_ERROR", message: msg, status: response.status };
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) {
      return { ok: false, error: "EMPTY_RESPONSE", message: "Respuesta vacía de Gemini." };
    }

    return { ok: true, text: candidate };
  } catch (err) {
    return { ok: false, error: "NETWORK_ERROR", message: err?.message || "Error al conectar con Gemini." };
  }
}

export async function generateWeatherOverview(ctx, env, clientKey) {
  const apiKey = getApiKey(env, clientKey);
  if (!apiKey) {
    return { ok: false, error: "NO_API_KEY" };
  }

  // Cache inteligente de 45 minutos en Cloudflare
  const cacheKeyStr = `https://clima-gemini-cache/overview?loc=${encodeURIComponent(ctx.location || "")}&h=${ctx.dateHour || ""}`;
  const cacheKey = new Request(cacheKeyStr);
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      try {
        return await cached.json();
      } catch (_) {}
    }
  }

  const systemPrompt = `Eres el asistente meteorológico inteligente de la aplicación "Clima Consenso".
Tu tono es profesional, amigable, claro y natural (español de Argentina).
Analiza los datos reales del pronóstico y devuelve un JSON estricto con las 4 claves especificadas.
No uses markdown fuera del JSON. Devuelve únicamente el objeto JSON.`;

  const userPrompt = `Analiza estos datos meteorológicos actuales y de consenso entre modelos:
Ubicación: ${ctx.location || "Buenos Aires"}
Hora local: ${ctx.localTime || "Actual"}
Temperatura actual: ${ctx.temp != null ? ctx.temp + "°C" : "Desconocida"} (Sensación: ${ctx.apparent != null ? ctx.apparent + "°C" : "—"})
Humedad: ${ctx.humidity != null ? ctx.humidity + "%" : "—"}, Precipitación: ${ctx.precip != null ? ctx.precip + " mm" : "0 mm"}
Condición: ${ctx.condition || "Variable"}
Consenso de modelos (SMN, ECMWF, GFS, ICON):
${ctx.modelsDetail || "No disponible"}
Próximas horas: ${ctx.hourlySummary || "Sin datos horarios"}
Próximos días: ${ctx.dailySummary || "Sin datos diarios"}
Alertas activas del SMN: ${ctx.alertsDetail || "Ninguna alerta activa"}

Genera un JSON con esta estructura exacta:
{
  "summary": "Parte meteorológico en lenguaje natural (2 a 3 oraciones concisas y útiles). Destaca cómo se siente el día y qué esperar.",
  "discrepancies": "Explicación breve del consenso entre SMN, ECMWF, GFS e ICON. Si coinciden, menciónalo; si discrepan (ej. lluvia o temperatura), explica qué modelo prevé qué y cuál es más confiable.",
  "lifestyle": {
    "outfit": "Recomendación práctica de ropa para el día y la noche.",
    "outdoor": "Mejor franja horaria para pasear, correr o actividad al aire libre.",
    "laundry": "Recomendación para secar/colgar ropa (viento, humedad, riesgo de lluvia)."
  },
  "alertsSummary": ${ctx.alertsDetail && ctx.alertsDetail !== "Ninguna alerta activa" ? '"Resumen claro de la alerta: qué fenómeno esperar, franja horaria crítica y medidas preventivas."' : 'null'}
}`;

  const result = await callGeminiRaw(userPrompt, systemPrompt, env, clientKey, true);
  if (!result.ok) return result;

  try {
    const parsed = JSON.parse(result.text);
    const finalResponse = { ok: true, data: parsed };

    if (cache) {
      const resp = new Response(JSON.stringify(finalResponse), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=2700" // 45 min
        }
      });
      await cache.put(cacheKey, resp.clone());
    }

    return finalResponse;
  } catch (e) {
    return { ok: false, error: "JSON_PARSE_ERROR", message: "Respuesta de Gemini mal formateada." };
  }
}

export async function chatWithGemini(question, weatherContext, env, clientKey) {
  const apiKey = getApiKey(env, clientKey);
  if (!apiKey) {
    return { ok: false, error: "NO_API_KEY", message: "Configurá una clave de Gemini para chatear." };
  }

  const systemPrompt = `Eres el copiloto meteorológico de la aplicación "Clima Consenso".
Respondes preguntas cotidianas sobre el clima de forma directa, útil, precisa y concisa (español de Argentina).
Usa EXCLUSIVAMENTE los datos meteorológicos provistos (consenso entre SMN, ECMWF, GFS e ICON).
Si te preguntan por horarios de lluvia, actividades, ropa o planes, da una respuesta clara y concreta en 1 o 2 párrafos breves.`;

  const prompt = `Datos meteorológicos actuales para ${weatherContext.location || "la ubicación"}:
- Temperatura: ${weatherContext.temp}°C (Sensación: ${weatherContext.apparent}°C)
- Condición: ${weatherContext.condition}
- Humedad: ${weatherContext.humidity}%, Lluvia actual: ${weatherContext.precip} mm
- Pronóstico lluvia 24h: ${weatherContext.rainOutlook || "Incierto"}
- Próximas horas: ${weatherContext.hourlySummary || ""}
- Próximos 7 días: ${weatherContext.dailySummary || ""}
- Alertas SMN: ${weatherContext.alertsDetail || "Sin alertas"}

Pregunta del usuario: "${question}"`;

  return await callGeminiRaw(prompt, systemPrompt, env, clientKey, false);
}
