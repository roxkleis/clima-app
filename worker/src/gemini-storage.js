const DAILY_LIMITS = { interactive: 12, push: 4 };
const CACHE_TTL_MS = 45 * 60 * 1000;
const quotaDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
const encoder = new TextEncoder();

export async function reserveGeminiRequest(db, channel) {
  const day = quotaDayFormat.format(new Date());
  const result = await db.prepare(`
    INSERT INTO gemini_daily_quota (channel, quota_day, requests)
    VALUES (?, ?, 1)
    ON CONFLICT (channel) DO UPDATE SET
      quota_day = excluded.quota_day,
      requests = CASE WHEN quota_day = excluded.quota_day THEN requests + 1 ELSE 1 END
    WHERE quota_day < excluded.quota_day
       OR (quota_day = excluded.quota_day AND requests < ?)
  `).bind(channel, day, DAILY_LIMITS[channel]).run();
  return result.meta.changes === 1;
}

export async function useGeminiCache(db, parts, generate) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(parts)));
  const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

  try {
    const cached = await db.prepare(`
      SELECT result FROM gemini_response_cache WHERE cache_key = ? AND expires_at > ?
    `).bind(key, Date.now()).first();
    if (cached) return JSON.parse(cached.result);
  } catch {
    console.warn("gemini-cache-read-failed");
  }

  const result = await generate();
  if (!result.ok) return result;

  const now = Date.now();
  try {
    await db.batch([
      db.prepare("DELETE FROM gemini_response_cache WHERE expires_at <= ?").bind(now),
      db.prepare(`
        INSERT INTO gemini_response_cache (cache_key, result, expires_at) VALUES (?, ?, ?)
        ON CONFLICT (cache_key) DO UPDATE SET result = excluded.result, expires_at = excluded.expires_at
      `).bind(key, JSON.stringify(result), now + CACHE_TTL_MS),
    ]);
  } catch {
    console.warn("gemini-cache-write-failed");
  }
  return result;
}
