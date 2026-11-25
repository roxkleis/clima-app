import { chatWithGemini, generateWeatherOverview } from "./gemini.js";
import { readAlertsAtLocation } from "./smn-alerts.js";

const maxBodyBytes = 32 * 1024;
const maxQuestionLength = 500;
const contextFields = [
  "location", "locationId", "lat", "lon", "dateHour", "localTime", "temp", "apparent",
  "humidity", "precip", "condition", "modelsDetail", "hourlySummary", "dailySummary",
  "rainOutlook", "forecastRevision", "observationDetail",
];
async function readGeminiBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return { status: 400, error: "INVALID_JSON" };

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel().catch(() => {});
        return { status: 413, error: "BODY_TOO_LARGE" };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { body: JSON.parse(text + decoder.decode()) };
  } catch {
    return { status: 400, error: "INVALID_JSON" };
  } finally {
    reader.releaseLock();
  }
}

function validWeatherContext(context) {
  return context && typeof context === "object" && !Array.isArray(context) &&
    typeof context.location === "string" && context.location.trim() &&
    Number.isFinite(context.lat) && Math.abs(context.lat) <= 90 &&
    Number.isFinite(context.lon) && Math.abs(context.lon) <= 180 &&
    contextFields.every((field) => {
      const value = context[field];
      return value == null || typeof value === "string" || Number.isFinite(value);
    });
}

function describeAlerts({ status, alerts }) {
  if (status === "unavailable") return "Cobertura incompleta o consulta no disponible. No se puede afirmar que no hay alertas.";
  if (status === "none") return "Sin alertas en el índice oficial del SMN que coincidan con esta ubicación.";
  const compact = (text) => text.replace(/\s+/g, " ").trim().slice(0, 1100);
  const time = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short",
  });
  const lines = alerts.slice(0, 5).map(alert =>
    `${alert.event} · nivel ${alert.severity} · zona: ${alert.areas.join("; ") || "polígono oficial"} · desde ${time.format(new Date(alert.onset))} hasta ${time.format(new Date(alert.expires))} (Argentina). Descripción oficial: ${compact(alert.description) || "sin texto"}. Recomendaciones del SMN: ${compact(alert.instructions) || "sin instrucciones en el boletín"}.`
  );
  if (status === "partial" || alerts.length > lines.length) {
    lines.push("Lista parcial de alertas confirmadas. Consultar el aviso oficial para más información.");
  }
  return lines.join("\n");
}

export async function handleGeminiRequest(request, env, headers, route) {
  const errorResponse = (status, error) =>
    Response.json({ ok: false, error }, { status, headers });

  if (!env.GEMINI_API_KEY) {
    return errorResponse(503, "GEMINI_UNAVAILABLE");
  }

  const parsed = await readGeminiBody(request);
  if (parsed.error) return errorResponse(parsed.status, parsed.error);

  const { context, question, history = [] } = parsed.body ?? {};
  if (!validWeatherContext(context)) return errorResponse(400, "INVALID_WEATHER_CONTEXT");

  const isChat = route === "/gemini/chat";
  if (isChat && (typeof question !== "string" || !question.trim() || question.length > maxQuestionLength)) {
    return errorResponse(400, "INVALID_QUESTION");
  }
  if (isChat && (!Array.isArray(history) || history.length > 2 || history.some(turn =>
    typeof turn?.question !== "string" || !turn.question.trim() || turn.question.length > maxQuestionLength ||
    typeof turn?.text !== "string" || !turn.text.trim() || turn.text.length > 1400
  ))) return errorResponse(400, "INVALID_HISTORY");

  const officialAlerts = await readAlertsAtLocation(env.DB, context.lat, context.lon);
  const weatherContext = {
    ...context,
    alertsStatus: officialAlerts.status,
    alertsDetail: describeAlerts(officialAlerts),
    alertsRevision: JSON.stringify([officialAlerts.status, officialAlerts.alerts]),
  };
  const result = isChat
    ? await chatWithGemini(question.trim(), weatherContext, env, history)
    : await generateWeatherOverview(weatherContext, env);
  return Response.json({ ...result, officialAlerts }, { status: result.ok ? 200 : result.status, headers });
}
