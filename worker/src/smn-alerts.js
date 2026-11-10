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

export async function fetchRegionalAlerts(now) {
  const response = await fetch(CAP_INDEX, { signal: AbortSignal.timeout(12000), redirect: "error" });
  if (!response.ok) throw new Error(`Índice SMN HTTP ${response.status}`);
  const links = [...new Set((await response.text()).match(CAP_URL) ?? [])];
  const offset = Math.floor(Number(now) / 300000) * DOCUMENTS_PER_POLL % (links.length || 1);
  const documents = links.length <= DOCUMENTS_PER_POLL
    ? links : [...links.slice(offset), ...links.slice(0, offset)].slice(0, DOCUMENTS_PER_POLL);

  const alerts = new Map();
  for (let i = 0; i < documents.length; i += 6) {
    const results = await Promise.allSettled(documents.slice(i, i + 6).map(async url => {
      const document = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
      if (!document.ok) throw new Error(`CAP HTTP ${document.status}`);
      return parseRegionalAlerts(await document.text(), Number(now));
    }));
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("smn-cap-document", result.reason?.message);
        continue;
      }
      for (const alert of result.value) {
        const key = `smn:${alert.event}:${alert.onset}:${alert.expires}:${alert.severity}`;
        const existing = alerts.get(key);
        if (!existing) {
          alerts.set(key, { ...alert, key });
          continue;
        }
        const local = alert.areas.has("San Miguel") && !existing.areas.has("San Miguel");
        const nearby = alert.areas.has("Cerca de San Miguel") && !existing.areas.has("Cerca de San Miguel");
        if (local || nearby) existing.description = alert.description;
        for (const area of alert.areas) existing.areas.add(area);
      }
    }
  }
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
