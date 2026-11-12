import { matchedZones } from "./alert-zones.js";

const CAP_INDEX = "https://ssl.smn.gob.ar/CAP/AR.php";
const CAP_URL = /https:\/\/ssl\.smn\.gob\.ar\/feeds\/CAP\/[\w/-]+\.xml\b/g;
const DOCUMENTS_PER_POLL = 32;
const COLORS = { Moderate: "amarilla", Severe: "naranja", Extreme: "roja" };
const priority = { Moderate: 1, Severe: 2, Extreme: 3 };
const timezone = "America/Argentina/Buenos_Aires";
const formatTime = new Intl.DateTimeFormat("es-AR", {
  timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function blocks(xml, tag) {
  return Array.from(xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "gi")), match => match[1]);
}

function field(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "i"));
  const value = match?.[1]?.trim() ?? "";
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (entity, code, name) => {
      if (!code) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name] ?? entity;
      const point = code[0].toLowerCase() === "x" ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    });
}

export function parseRegionalAlerts(xml, now) {
  if (field(xml, "status") !== "Actual" || !["Alert", "Update"].includes(field(xml, "msgType"))) return [];
  const alerts = [];
  for (const info of blocks(xml, "info")) {
    if (field(info, "language") && !/^es(?:-|$)/i.test(field(info, "language"))) continue;
    const severity = field(info, "severity");
    const onset = Date.parse(field(info, "onset") || field(info, "effective") || field(xml, "sent"));
    const expires = Date.parse(field(info, "expires"));
    if (!COLORS[severity] || !Number.isFinite(onset) || !Number.isFinite(expires) || expires <= now || expires <= onset) continue;

    const areas = new Set();
    for (const area of blocks(info, "area")) {
      for (const polygon of blocks(area, "polygon")) {
        const points = polygon.trim().split(/\s+/).map(pair => pair.split(",").reverse().map(Number))
          .filter(pair => pair.length === 2 && pair.every(Number.isFinite));
        if (points.length < 3) continue;
        for (const zone of matchedZones(points)) areas.add(zone);
      }
    }
    if (!areas.size) continue;
    const event = field(info, "event") || "Alerta meteorológica";
    alerts.push({ event, severity, onset, expires, areas, description: field(info, "description") });
  }
  return alerts;
}

async function deferCapRequests(db, response, now) {
  const retryAfter = response.headers.get("Retry-After") ?? "";
  const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  const resumeAt = Math.floor((Number(now) + Math.max(5 * 60000, Number.isFinite(delay) ? delay : 0)) / 1000);
  await db.prepare("INSERT INTO smn_cap_state(id, resume_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET resume_at = excluded.resume_at")
    .bind(resumeAt).run();
  console.warn("smn-cap-rate-limited", new Date(resumeAt * 1000).toISOString());
}

export async function fetchRegionalAlerts(db, now) {
  const state = await db.prepare("SELECT resume_at FROM smn_cap_state WHERE id = 1").first();
  if (state?.resume_at * 1000 > now) return [];
  const response = await fetch(CAP_INDEX, { signal: AbortSignal.timeout(12000), redirect: "manual" });
  if (response.status === 429) {
    await deferCapRequests(db, response, now);
    return [];
  }
  if (!response.ok) throw new Error(`Índice SMN HTTP ${response.status}`);
  const links = [...new Set((await response.text()).match(CAP_URL) ?? [])].slice(0, 200);
  if (now.getUTCMinutes() < 5) {
    await db.prepare("DELETE FROM smn_cap_documents WHERE fetched_at < unixepoch() - 345600").run();
  }
  const cached = new Map();
  for (let start = 0; start < links.length; start += 50) {
    const batch = links.slice(start, start + 50);
    const { results } = await db.prepare(
      `SELECT url, alerts FROM smn_cap_documents WHERE url IN (${batch.map(() => "?").join(",")})`
    ).bind(...batch).all();
    for (const row of results) cached.set(row.url, JSON.parse(row.alerts));
  }
  const missing = links.filter(url => !cached.has(url));
  const offset = Math.floor(Number(now) / 300000) * DOCUMENTS_PER_POLL % (missing.length || 1);
  const documents = missing.length <= DOCUMENTS_PER_POLL
    ? missing : [...missing.slice(offset), ...missing.slice(0, offset)].slice(0, DOCUMENTS_PER_POLL);
  for (const url of documents) {
    try {
      const document = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
      if (document.status === 429) {
        await deferCapRequests(db, document, now);
        break;
      }
      if (!document.ok) throw new Error(`CAP HTTP ${document.status}`);
      const regional = parseRegionalAlerts(await document.text(), Number(now))
        .map(alert => ({ ...alert, areas: [...alert.areas] }));
      await db.prepare("INSERT OR REPLACE INTO smn_cap_documents(url, alerts, fetched_at) VALUES (?, ?, unixepoch())")
        .bind(url, JSON.stringify(regional)).run();
      cached.set(url, regional);
    } catch (error) {
      console.warn("smn-cap-document", error?.message);
    }
  }
  const alerts = new Map();
  for (const regional of cached.values()) {
    for (const alert of regional) {
      if (alert.expires <= now) continue;
      const key = `smn:${alert.event}:${alert.onset}:${alert.expires}:${alert.severity}`;
      const existing = alerts.get(key);
      if (!existing) {
        alerts.set(key, { ...alert, key, areas: new Set(alert.areas) });
        continue;
      }
      const local = alert.areas.includes("San Miguel") && !existing.areas.has("San Miguel");
      const nearby = alert.areas.includes("Cerca de San Miguel") && !existing.areas.has("Cerca de San Miguel");
      if (local || nearby) existing.description = alert.description;
      for (const area of alert.areas) existing.areas.add(area);
    }
  }
  console.log("smn-cap-poll", { indexed: links.length, processed: cached.size, regionalAlerts: alerts.size });
  return [...alerts.values()].sort((a, b) =>
    Number(b.areas.has("San Miguel")) - Number(a.areas.has("San Miguel")) ||
    Number(b.areas.has("Cerca de San Miguel")) - Number(a.areas.has("Cerca de San Miguel")) ||
    priority[b.severity] - priority[a.severity] || a.onset - b.onset
  );
}

export function alertPayload(alert, now) {
  const { areas } = alert;
  const zone = areas.has("San Miguel") ? "Incluye San Miguel" :
    areas.has("Cerca de San Miguel") ? "Cerca de San Miguel" :
    areas.has("CABA") && areas.has("GBA") ? "CABA y GBA" : areas.has("CABA") ? "CABA" : "GBA";
  const period = alert.onset > now
    ? `Desde ${formatTime.format(alert.onset)} hasta ${formatTime.format(alert.expires)}`
    : `Vigente hasta ${formatTime.format(alert.expires)}`;
  return {
    title: `⚠️ SMN · Alerta ${COLORS[alert.severity]} · ${alert.event}`,
    body: `${zone}. ${period}. ${alert.description.replace(/\s+/g, " ").slice(0, 150)}`.trim(),
    tag: alert.key,
    url: "https://www.smn.gob.ar/alertas",
    ttl: Math.max(0, Math.min(86400, Math.floor((alert.expires - now) / 1000)))
  };
}
