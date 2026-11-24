import { matchedZones, polygonContainsPoint } from "./alert-zones.js";

const CAP_INDEX = "https://ssl.smn.gob.ar/CAP/AR.php";
const CAP_URL = /https:\/\/(?:ssl\.smn\.gob\.ar\/feeds\/CAP\/(?:xml_generados|cap_salida)|forms\.smn\.gob\.ar\/feeds\/CAP\/oladecalor)\/[\w-]+\.xml\b/g;
const DOCUMENTS_PER_POLL = 16;
const FALLBACK_BASE = "https://alerts.kde.org";
const FALLBACK_AREA = FALLBACK_BASE + "/alert/area?min_lat=-35.5&max_lat=-33.7&min_lon=-59.6&max_lon=-57.5";
const COLORS = { Moderate: "amarilla", Severe: "naranja", Extreme: "roja" };
const priority = { Moderate: 1, Severe: 2, Extreme: 3 };
const MAX_INDEX_AGE_MS = 15 * 60000;
const OFFICIAL_ALERTS_URL = "https://www.smn.gob.ar/alertas";
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

function parseCapDocument(xml) {
  const id = field(xml, "identifier");
  const status = field(xml, "status");
  if (!id || !status) throw new Error("Boletín CAP inválido");
  const type = field(xml, "msgType");
  const sent = Date.parse(field(xml, "sent"));
  const references = status === "Actual" && ["Update", "Cancel"].includes(type)
    ? field(xml, "references").split(/\s+/).map(reference => reference.split(",")[1]).filter(Boolean) : [];
  const alerts = [];
  if (status !== "Actual" || !["Alert", "Update"].includes(type)) return { id, references, alerts };
  for (const info of blocks(xml, "info")) {
    if (field(info, "language") && !/^es(?:-|$)/i.test(field(info, "language"))) continue;
    const severity = field(info, "severity");
    const onset = Date.parse(field(info, "onset") || field(info, "effective") || field(xml, "sent"));
    const expires = Date.parse(field(info, "expires"));
    if (!COLORS[severity] || !Number.isFinite(onset) || !Number.isFinite(expires) || expires <= onset) continue;
    const areas = blocks(info, "area").map(area => ({
      name: field(area, "areaDesc"),
      polygons: blocks(area, "polygon").map(polygon =>
        polygon.trim().split(/\s+/).filter(pair => /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(pair))
          .map(pair => pair.split(",").reverse().map(Number))
      ).filter(points => points.length >= 3),
    }));
    const event = field(info, "event") || "Alerta meteorológica";
    alerts.push({
      event, severity, onset, expires, sent: Number.isFinite(sent) ? sent : 0, areas,
      description: field(info, "description"), instructions: field(info, "instruction"),
    });
  }
  return { id, references, alerts };
}

function regionalAlerts(document, now) {
  return document.alerts.filter(alert => alert.expires > now).map(alert => {
    const areas = new Set(alert.areas.flatMap(area => area.polygons.flatMap(matchedZones)));
    return { ...alert, areas };
  }).filter(alert => alert.areas.size);
}

export function parseRegionalAlerts(xml, now) {
  if (field(xml, "status") !== "Actual" || !["Alert", "Update"].includes(field(xml, "msgType"))) return [];
  return regionalAlerts(parseCapDocument(xml), now);
}

async function deferCapRequests(db, response, now) {
  const retryAfter = response.headers.get("Retry-After") ?? "";
  const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  const resumeAt = Math.floor((Number(now) + Math.max(5 * 60000, Number.isFinite(delay) ? delay : 0)) / 1000);
  await db.prepare("INSERT INTO smn_cap_state(id, resume_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET resume_at = excluded.resume_at")
    .bind(resumeAt).run();
  console.warn("smn-cap-rate-limited", new Date(resumeAt * 1000).toISOString());
}

async function readCapCache(db, links) {
  const cached = new Map();
  for (let start = 0; start < links.length; start += 50) {
    const batch = links.slice(start, start + 50);
    const { results } = await db.prepare(
      `SELECT url, alerts FROM smn_cap_documents WHERE url IN (${batch.map(() => "?").join(",")})`
    ).bind(...batch).all();
    for (const row of results) cached.set(row.url, JSON.parse(row.alerts));
  }
  return cached;
}

async function cacheCapDocument(db, url, xml, now) {
  const isSmn = !url.startsWith(FALLBACK_BASE) ||
    (field(xml, "sender") === "smn@smn.gob.ar" && field(xml, "identifier").startsWith("urn:oid:2.49.0.1.32.0."));
  const document = isSmn ? parseCapDocument(xml) : { id: null, references: [], alerts: [] };
  const regional = regionalAlerts(document, Number(now)).map(alert => ({ ...alert, areas: [...alert.areas] }));
  const stored = { ...document, regional };
  await db.prepare("INSERT OR REPLACE INTO smn_cap_documents(url, alerts, fetched_at) VALUES (?, ?, unixepoch())")
    .bind(url, JSON.stringify(stored)).run();
  return stored;
}

async function readFallbackAlerts(db, now) {
  const response = await fetch(FALLBACK_AREA, { signal: AbortSignal.timeout(10000), redirect: "manual" });
  if (!response.ok) throw new Error(`Réplica CAP HTTP ${response.status}`);
  const ids = await response.json();
  const links = [...new Set(ids.filter(id => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)))]
    .slice(0, 100).map(id => FALLBACK_BASE + "/alert/" + id);
  const cached = await readCapCache(db, links);
  for (const url of links.filter(url => !cached.has(url) || Array.isArray(cached.get(url))).slice(0, 8)) {
    try {
      const options = { signal: AbortSignal.timeout(8000), redirect: "manual" };
      let document = await fetch(url, options);
      if (document.status === 301) {
        const location = document.headers.get("Location");
        const target = location && URL.parse(location, FALLBACK_BASE);
        if (!target || target.origin !== FALLBACK_BASE || !/^\/cap\/alerts\/ar-smn-es\/[^/]+\.xml$/.test(target.pathname)) {
          cached.set(url, await cacheCapDocument(db, url, "", now));
          continue;
        }
        document = await fetch(target, options);
      }
      if (document.status === 429) break;
      if (!document.ok) throw new Error(`CAP HTTP ${document.status}`);
      cached.set(url, await cacheCapDocument(db, url, await document.text(), now));
    } catch (error) {
      console.warn("smn-cap-fallback-document", error?.message);
    }
  }
  return cached;
}

async function readDirectAlerts(db, now) {
  const state = await db.prepare("SELECT resume_at FROM smn_cap_state WHERE id = 1").first();
  if (state?.resume_at * 1000 > now) return { cached: new Map(), fallback: true, complete: false };
  const response = await fetch(CAP_INDEX, { signal: AbortSignal.timeout(12000), redirect: "manual" });
  if (response.status === 429) {
    await deferCapRequests(db, response, now);
    return { cached: new Map(), fallback: true, complete: false };
  }
  if (!response.ok) throw new Error(`Índice SMN HTTP ${response.status}`);
  const index = await response.text();
  if (!/<rss\b[^>]*>[\s\S]*?<channel\b[\s\S]*?<\/channel>\s*<\/rss>/i.test(index)) {
    throw new Error("Índice CAP del SMN inválido");
  }
  const allLinks = [...new Set(index.match(CAP_URL) ?? [])];
  const links = allLinks.slice(0, 200);
  const cached = await readCapCache(db, links);
  const missing = links.filter(url => !cached.has(url) || Array.isArray(cached.get(url)));
  const offset = Math.floor(Number(now) / 300000) * DOCUMENTS_PER_POLL % (missing.length || 1);
  const documents = missing.length <= DOCUMENTS_PER_POLL
    ? missing : [...missing.slice(offset), ...missing.slice(0, offset)].slice(0, DOCUMENTS_PER_POLL);
  let fallback = missing.length > DOCUMENTS_PER_POLL;
  for (const url of documents) {
    try {
      const document = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" });
      if (document.status === 429) {
        await deferCapRequests(db, document, now);
        fallback = true;
        break;
      }
      if (!document.ok) throw new Error(`CAP HTTP ${document.status}`);
      cached.set(url, await cacheCapDocument(db, url, await document.text(), now));
    } catch (error) {
      console.warn("smn-cap-document", error?.message);
    }
  }
  console.log("smn-cap-direct", { indexed: links.length, processed: cached.size });
  const complete = links.length === allLinks.length && links.every(url => cached.has(url) && !Array.isArray(cached.get(url)));
  return { cached, fallback: fallback || !complete, complete };
}

export async function fetchRegionalAlerts(db, now) {
  if (now.getUTCMinutes() < 5) {
    await db.prepare("DELETE FROM smn_cap_documents WHERE fetched_at < unixepoch() - 345600").run();
  }
  const { cached, fallback, complete } = await readDirectAlerts(db, now).catch(error => {
    console.warn("smn-cap-index", error?.message);
    return { cached: new Map(), fallback: true, complete: false };
  });
  if (fallback) {
    const alternate = await readFallbackAlerts(db, now).catch(error => {
      console.warn("smn-cap-fallback", error?.message);
      return new Map();
    });
    for (const [url, alerts] of alternate) cached.set(url, alerts);
    console.log("smn-cap-fallback", { processed: alternate.size });
  }
  try {
    await db.prepare(`
      INSERT INTO smn_cap_index(id, urls, complete, checked_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET urls = excluded.urls, complete = excluded.complete, checked_at = excluded.checked_at
      WHERE excluded.checked_at >= smn_cap_index.checked_at
    `).bind(JSON.stringify([...cached.keys()]), Number(complete), Number(now)).run();
  } catch {
    console.warn("smn-cap-index-snapshot-unavailable");
  }
  const alerts = new Map();
  for (const document of cached.values()) {
    const regional = Array.isArray(document) ? document : document.regional;
    for (const alert of regional) {
      if (alert.expires <= now) continue;
      const key = `smn:${alert.event}:${alert.onset}:${alert.severity}`;
      const existing = alerts.get(key);
      if (!existing) {
        alerts.set(key, { ...alert, key, areas: new Set(alert.areas) });
        continue;
      }
      const local = alert.areas.includes("San Miguel") && !existing.areas.has("San Miguel");
      const nearby = alert.areas.includes("Cerca de San Miguel") && !existing.areas.has("Cerca de San Miguel");
      if (local || nearby) existing.description = alert.description;
      if (alert.sent > existing.sent) {
        existing.sent = alert.sent;
        existing.expires = alert.expires;
      }
      for (const area of alert.areas) existing.areas.add(area);
    }
  }
  console.log("smn-cap-poll", { documents: cached.size, regionalAlerts: alerts.size });
  return [...alerts.values()].sort((a, b) =>
    Number(b.areas.has("San Miguel")) - Number(a.areas.has("San Miguel")) ||
    Number(b.areas.has("Cerca de San Miguel")) - Number(a.areas.has("Cerca de San Miguel")) ||
    priority[b.severity] - priority[a.severity] || a.onset - b.onset
  );
}

export async function readAlertsAtLocation(db, lat, lon, now = Date.now()) {
  const unavailable = { status: "unavailable", alerts: [], url: OFFICIAL_ALERTS_URL };
  try {
    const index = await db.prepare("SELECT urls, complete, checked_at FROM smn_cap_index WHERE id = 1").first();
    if (!index || now - index.checked_at >= MAX_INDEX_AGE_MS) return unavailable;
    const urls = JSON.parse(index.urls);
    const cached = await readCapCache(db, urls);
    const documents = [...cached].filter(([, document]) => !Array.isArray(document));
    const superseded = new Set(documents.flatMap(([, document]) => document.references));
    let complete = Boolean(index.complete) && documents.length === urls.length;
    const alerts = new Map();
    for (const [url, document] of documents) {
      if (superseded.has(document.id)) continue;
      for (const alert of document.alerts) {
        if (alert.expires <= now) continue;
        if (!alert.areas.length || alert.areas.some(area => !area.polygons.length)) complete = false;
        const matched = alert.areas.filter(area =>
          area.polygons.some(polygon => polygonContainsPoint(polygon, [lon, lat]))
        );
        if (!matched.length) continue;
        const key = `${alert.event}:${alert.onset}:${alert.severity}`;
        if ((alerts.get(key)?.sent ?? -1) >= alert.sent) continue;
        alerts.set(key, {
          id: document.id, event: alert.event, severity: COLORS[alert.severity], priority: priority[alert.severity],
          onset: new Date(alert.onset).toISOString(), expires: new Date(alert.expires).toISOString(), sent: alert.sent,
          areas: [...new Set(matched.map(area => area.name).filter(Boolean))].sort(),
          description: alert.description, instructions: alert.instructions,
          sourceUrl: url.startsWith(FALLBACK_BASE) ? OFFICIAL_ALERTS_URL : url,
        });
      }
    }
    const matches = [...alerts.values()].sort((a, b) => b.priority - a.priority || a.onset.localeCompare(b.onset) || a.id.localeCompare(b.id));
    return {
      status: matches.length ? (complete ? "active" : "partial") : (complete ? "none" : "unavailable"),
      alerts: matches, url: OFFICIAL_ALERTS_URL, checkedAt: new Date(index.checked_at).toISOString(),
    };
  } catch {
    console.warn("smn-cap-location-unavailable");
    return unavailable;
  }
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
    url: OFFICIAL_ALERTS_URL,
    ttl: Math.max(0, Math.min(86400, Math.floor((alert.expires - now) / 1000)))
  };
}
