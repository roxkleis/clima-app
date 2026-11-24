import { chatWithGemini, generateWeatherOverview } from "./gemini.js";

const accessTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const bearerPattern = /^Bearer ([A-Za-z0-9_-]{32,128})$/i;
const maxBodyBytes = 32 * 1024;
const maxQuestionLength = 500;
const contextFields = [
  "location", "locationId", "lat", "lon", "dateHour", "localTime", "temp", "apparent",
  "humidity", "precip", "condition", "modelsDetail", "hourlySummary", "dailySummary",
  "rainOutlook", "alertsDetail", "forecastRevision", "alertsRevision",
];
const encoder = new TextEncoder();

async function matchesAccessToken(provided, expected) {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

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
    contextFields.every((field) => {
      const value = context[field];
      return value == null || typeof value === "string" || Number.isFinite(value);
    });
}

export async function handleGeminiRequest(request, env, headers, route) {
  const errorResponse = (status, error, extraHeaders = {}) =>
    Response.json({ ok: false, error }, { status, headers: { ...headers, ...extraHeaders } });

  const expected = env.GEMINI_ACCESS_TOKEN;
  if (!env.GEMINI_API_KEY || typeof expected !== "string" || !accessTokenPattern.test(expected)) {
    return errorResponse(503, "GEMINI_UNAVAILABLE");
  }

  const provided = request.headers.get("Authorization")?.match(bearerPattern)?.[1];
  if (!provided || !await matchesAccessToken(provided, expected)) {
    return errorResponse(401, "UNAUTHORIZED", { "WWW-Authenticate": "Bearer" });
  }

  const parsed = await readGeminiBody(request);
  if (parsed.error) return errorResponse(parsed.status, parsed.error);

  const { context, question } = parsed.body ?? {};
  if (!validWeatherContext(context)) return errorResponse(400, "INVALID_WEATHER_CONTEXT");

  const isChat = route === "/gemini/chat";
  if (isChat && (typeof question !== "string" || !question.trim() || question.length > maxQuestionLength)) {
    return errorResponse(400, "INVALID_QUESTION");
  }

  const result = isChat
    ? await chatWithGemini(question.trim(), context, env)
    : await generateWeatherOverview(context, env);
  return Response.json(result, { status: result.ok ? 200 : result.status, headers });
}
