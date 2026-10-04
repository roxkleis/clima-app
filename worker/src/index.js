import { runNotificationEngine } from "./alerts.js";

const HEADER_BYTES_PER_VALUE = 2;
const VARIABLES = ["temperature", "humidity", "precipitation", "windSpeed", "windDirection"];
const BYTES_PER_POINT = VARIABLES.length * HEADER_BYTES_PER_VALUE;
const MISSING = -32768;

function degToRad(v) {
  return (v * Math.PI) / 180;
}

function lccProject(lat, lon, p) {
  // Spherical Lambert Conformal Conic.
  const phi = degToRad(lat);
  const lambda = degToRad(lon);
  const phi0 = degToRad(p.latitudeOfOrigin);
  const lambda0 = degToRad(p.centralMeridian);
  const phi1 = degToRad(p.standardParallel[0]);
  const phi2 = degToRad(p.standardParallel[1]);
  const R = Number(p.earthRadius || 6370000);

  let n;
  if (Math.abs(phi1 - phi2) < 1e-12) {
    n = Math.sin(phi1);
  } else {
    n =
      Math.log(Math.cos(phi1) / Math.cos(phi2)) /
      Math.log(
        Math.tan(Math.PI / 4 + phi2 / 2) /
        Math.tan(Math.PI / 4 + phi1 / 2)
      );
  }

  const F =
    (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;

  function rho(phiValue) {
    return (R * F) / Math.pow(Math.tan(Math.PI / 4 + phiValue / 2), n);
  }

  const rho0 = rho(phi0);
  const r = rho(phi);
  const theta = n * (lambda - lambda0);

  return {
    x: r * Math.sin(theta) + Number(p.falseEasting ?? p.false_easting ?? 0),
    y: rho0 - r * Math.cos(theta) + Number(p.falseNorthing ?? p.false_northing ?? 0),
  };
}

function nearestIndex(value, origin, step, count) {
  const idx = Math.round((value - origin) / step);
  return Math.max(0, Math.min(count - 1, idx));
}

function decodeInt16(buffer, byteOffset) {
  return new DataView(buffer).getInt16(byteOffset, true);
}

async function readPoint(env, metadata, leadIndex, gridIndex) {
  const gridSize = Number(metadata.gridSize);
  const variableCount = VARIABLES.length;
  const recordSize = gridSize * BYTES_PER_POINT;
  const offset = leadIndex * recordSize + gridIndex * BYTES_PER_POINT;

  const object = await env.SMN_DATA.get("smn/forecast.bin", {
    range: {
      offset,
      length: BYTES_PER_POINT,
    },
  });

  if (!object) {
    throw new Error("forecast.bin not found");
  }

  const buffer = await object.arrayBuffer();
  if (buffer.byteLength < BYTES_PER_POINT) {
    throw new Error("Incomplete forecast record");
  }

  const raw = [];
  for (let i = 0; i < variableCount; i++) {
    raw.push(decodeInt16(buffer, i * HEADER_BYTES_PER_VALUE));
  }

  const scales = VARIABLES.map((name) => Number(metadata.variables[name].scale));

  return {
    temperature: raw[0] === MISSING ? null : raw[0] / scales[0],
    humidity: raw[1] === MISSING ? null : raw[1] / scales[1],
    precipitation: raw[2] === MISSING ? null : raw[2] / scales[2],
    windSpeed: raw[3] === MISSING ? null : raw[3] / scales[3],
    windDirection: raw[4] === MISSING ? null : raw[4] / scales[4],
  };
}

async function getMetadata(env) {
  const object = await env.SMN_DATA.get("smn/metadata.json");
  if (!object) return null;
  return await object.json();
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowed = origin === "https://roxkleis.github.io" ? origin : "https://roxkleis.github.io";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}




const SMN_TIEPRE_API = "https://ssl.smn.gob.ar/dpd/zipopendata.php?dato=tiepre";
const SMN_OBS_API = "https://w2b.smn.gov.ar/oapi";
const SMN_OBS_COLLECTIONS = [
  "urn:wmo:md:ar-smn:slt0ci",
  "urn:wmo:md:ar-smn:autosmn",
];
const SMN_STATIONS_COLLECTION = "stations";
const TIEPRE_CACHE_KEY = "https://clima-internal/tiepre/current.zip";
const TIEPRE_MAX_AGE_MINUTES = 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function smnJson(url) {
  const r = await fetch(url, {
    headers: {
      "Accept": "application/geo+json, application/json",
      "User-Agent": "Clima-by-richardspulgar/1.0",
    },
  });
  if (!r.ok) throw new Error("SMN API HTTP " + r.status);
  return await r.json();
}

function normalizeStationName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseTiepreDate(dateText, timeText) {
  const rawDate = String(dateText || "").trim();
  const rawTime = String(timeText || "").trim();
  const parts = rawDate.split(/[-/]/);
  if (parts.length !== 3) return null;

  const day = Number(parts[0]);
  const year = Number(parts[2]);
  const monthRaw = String(parts[1]).trim().toUpperCase();
  const months = {
    ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
    JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
    JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
    JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
    ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8,
    SEP: 9, OCT: 10, NOV: 11, DIC: 12,
  };
  const month = Number.isFinite(Number(monthRaw)) ? Number(monthRaw) : months[monthRaw];
  if (!Number.isFinite(day) || !Number.isFinite(year) || !month) return null;

  const hm = rawTime.split(":");
  const hour = Number(hm[0]);
  const minute = Number(hm[1] || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const iso = String(year).padStart(4,"0") + "-" +
    String(month).padStart(2,"0") + "-" +
    String(day).padStart(2,"0") + "T" +
    String(hour).padStart(2,"0") + ":" +
    String(minute).padStart(2,"0") + ":00-03:00";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? { iso, ms } : null;
}

async function inflateZipEntry(buffer) {
  const view = new DataView(buffer);
  let localOffset = 0;
  let compression = view.getUint16(8, true);
  let compressedSize = view.getUint32(18, true);
  let fileNameLength = view.getUint16(26, true);
  let extraLength = view.getUint16(28, true);

  // Algunos ZIP usan data descriptors y dejan los tamaños en cero
  // dentro del encabezado local. En ese caso recuperamos los tamaños
  // desde el central directory.
  if (view.getUint32(0, true) !== 0x04034b50 || !compressedSize) {
    let eocd = -1;
    const min = Math.max(0, buffer.byteLength - 65557);
    for (let i = buffer.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("TIEPRE: ZIP central directory no encontrado");

    const centralOffset = view.getUint32(eocd + 16, true);
    if (view.getUint32(centralOffset, true) !== 0x02014b50) {
      throw new Error("TIEPRE: entrada central ZIP inválida");
    }

    compression = view.getUint16(centralOffset + 10, true);
    compressedSize = view.getUint32(centralOffset + 20, true);
    localOffset = view.getUint32(centralOffset + 42, true);
    fileNameLength = view.getUint16(centralOffset + 28, true);
    extraLength = view.getUint16(centralOffset + 30, true);
  }

  if (view.getUint32(localOffset, true) !== 0x04034b50) {
    throw new Error("TIEPRE: ZIP local header inválido");
  }

  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  if (dataEnd > buffer.byteLength) throw new Error("TIEPRE: ZIP truncado");

  const compressed = buffer.slice(dataOffset, dataEnd);
  if (compression === 0) return compressed;
  if (compression !== 8) throw new Error("TIEPRE: método ZIP no soportado (" + compression + ")");

  if (typeof DecompressionStream === "undefined") {
    throw new Error("TIEPRE: DecompressionStream no disponible");
  }

  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).arrayBuffer();
}

async function fetchTiepreText() {
  const cache = caches.default;
  const cached = await cache.match(TIEPRE_CACHE_KEY);
  if (cached) return await cached.text();

  const response = await fetch(SMN_TIEPRE_API, {
    headers: {
      "Accept": "application/zip, application/octet-stream, */*",
      "User-Agent": "Mozilla/5.0 (compatible; Clima-by-richardspulgar/1.0)",
    },
    cf: { cacheTtl: 600, cacheEverything: true },
  });

  if (!response.ok) throw new Error("SMN TIEPRE HTTP " + response.status);

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 4) throw new Error("SMN TIEPRE: respuesta vacía");

  const uncompressed = await inflateZipEntry(bytes);
  const text = new TextDecoder("windows-1252").decode(uncompressed);

  const cacheResponse = new Response(text, {
    headers: {
      "Content-Type": "text/plain; charset=windows-1252",
      "Cache-Control": "public, max-age=600",
    },
  });
  await cache.put(TIEPRE_CACHE_KEY, cacheResponse.clone());
  return text;
}

async function getW2BStationCatalog() {
  const stations = await smnJson(
    SMN_OBS_API + "/collections/" + SMN_STATIONS_COLLECTION + "/items?f=geojson&limit=200"
  );

  return (stations.features || []).map((feature) => {
    const p = feature?.properties || {};
    const c = feature?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;

    const lat = Number(c[1]);
    const lon = Number(c[0]);
    const name = String(p.name || "").trim();
    const id = String(p.wigos_station_identifier || p.id || feature.id || "").trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return { id, name, lat, lon, normalized: normalizeStationName(name) };
  }).filter(Boolean);
}

function findStationMetadata(stationName, catalog) {
  const target = normalizeStationName(stationName);
  if (!target) return null;

  let exact = catalog.find(s => s.normalized === target);
  if (exact) return exact;

  exact = catalog.find(s => s.normalized.includes(target) || target.includes(s.normalized));
  if (exact) return exact;

  const targetTokens = new Set(target.split(" ").filter(x => x.length > 2));
  let best = null;
  let bestScore = 0;
  for (const station of catalog) {
    const tokens = station.normalized.split(" ");
    const overlap = tokens.filter(t => targetTokens.has(t)).length;
    const score = overlap / Math.max(1, Math.max(tokens.length, targetTokens.size));
    if (score > bestScore) {
      bestScore = score;
      best = station;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function parseTiepreRows(text) {
  const rows = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes(";")) continue;

    const parts = line.replace(/\r/g, "").split(";").map(x => x.trim());
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    if (parts.length < 10) continue;

    const stationName = parts[0];
    const date = parseTiepreDate(parts[1], parts[2]);
    const temperature = Number(String(parts[5]).replace(",", "."));
    const feelsLike = Number(String(parts[6]).replace(",", "."));
    const humidity = Number(String(parts[7]).replace(",", "."));
    const pressure = Number(String(parts[9]).replace(",", "."));
    if (!stationName || !date || !Number.isFinite(temperature)) continue;

    const windRaw = String(parts[8] || "").trim();
    let windDirection = null;
    let windSpeedKmh = null;
    if (/^calma$/i.test(windRaw)) {
      windDirection = "Calma";
      windSpeedKmh = 0;
    } else {
      const windMatch = windRaw.match(/^(.*?)(?:\s+)(\d+(?:[.,]\d+)?)\s*$/);
      if (windMatch) {
        windDirection = windMatch[1].trim() || null;
        windSpeedKmh = Number(windMatch[2].replace(",", "."));
      } else {
        windDirection = windRaw || null;
      }
    }

    rows.push({
      stationName,
      normalized: normalizeStationName(stationName),
      time: date.iso,
      timestamp: date.ms,
      temp: temperature,
      feelsLike: Number.isFinite(feelsLike) ? feelsLike : null,
      humidity: Number.isFinite(humidity) ? humidity : null,
      pressure: Number.isFinite(pressure) ? pressure : null,
      visibility: parts[4] || null,
      windDirection,
      windSpeed: Number.isFinite(windSpeedKmh) ? windSpeedKmh / 3.6 : null,
      presentWeather: parts[3] || null,
    });
  }
  return rows;
}

async function getTiepreObservation(lat, lon) {
  const [text, catalog] = await Promise.all([
    fetchTiepreText(),
    getW2BStationCatalog(),
  ]);

  const rows = parseTiepreRows(text);
  if (!rows.length) throw new Error("SMN TIEPRE: no se pudieron interpretar registros");

  const now = Date.now();
  const recentRows = rows.filter(row => {
    const age = (now - row.timestamp) / 60000;
    return Number.isFinite(age) && age >= -10 && age <= TIEPRE_MAX_AGE_MINUTES;
  });
  if (!recentRows.length) throw new Error("SMN TIEPRE: no hay registros recientes");

  const candidates = [];
  for (const row of recentRows) {
    const station = findStationMetadata(row.stationName, catalog);
    if (!station) continue;
    candidates.push({
      ...row,
      station,
      distanceKm: haversineKm(lat, lon, station.lat, station.lon),
    });
  }

  if (!candidates.length) {
    throw new Error("SMN TIEPRE: no se pudo asociar ninguna estación a coordenadas");
  }

  candidates.sort((a, b) =>
    a.distanceKm - b.distanceKm || b.timestamp - a.timestamp
  );

  const chosen = candidates[0];
  const ageMinutes = Math.max(0, (now - chosen.timestamp) / 60000);

  return {
    station: {
      id: chosen.station.id || chosen.station.name,
      name: chosen.station.name,
      lat: chosen.station.lat,
      lon: chosen.station.lon,
      distanceKm: chosen.distanceKm,
    },
    temp: chosen.temp,
    humidity: chosen.humidity,
    windSpeed: chosen.windSpeed,
    windDirection: chosen.windDirection,
    precipitation: null,
    cloudCover: null,
    presentWeather: chosen.presentWeather,
    pressure: chosen.pressure,
    feelsLike: chosen.feelsLike,
    visibility: chosen.visibility,
    time: chosen.time,
    ageMinutes,
    collection: "SMN-TIEPRE",
  };
}

async function getW2BSMNObservation(lat, lon) {
  const stationCandidates = await getW2BStationCatalog();
  if (!stationCandidates.length) throw new Error("W2B: no hay estaciones SMN con coordenadas");

  stationCandidates.sort((a, b) =>
    haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon)
  );
  const station = stationCandidates[0];
  station.distanceKm = haversineKm(lat, lon, station.lat, station.lon);

  const delta = 0.08;
  const bbox = [station.lon - delta, station.lat - delta, station.lon + delta, station.lat + delta].join(",");
  const candidates = [];

  for (const collection of SMN_OBS_COLLECTIONS) {
    try {
      const params = new URLSearchParams({f: "geojson", bbox, limit: "2000"});
      const data = await smnJson(
        SMN_OBS_API + "/collections/" + encodeURIComponent(collection) + "/items?" + params
      );
      for (const feature of data.features || []) {
        const p = feature?.properties || {};
        const stationId = String(p.wigos_station_identifier || "");
        const reportTime = p.reportTime;
        const temp = Number(p.value);
        if (stationId !== station.id || p.name !== "air_temperature" || !reportTime || !Number.isFinite(temp)) continue;
        const ageMinutes = (Date.now() - new Date(reportTime).getTime()) / 60000;
        if (!Number.isFinite(ageMinutes) || ageMinutes < -10 || ageMinutes > 180) continue;
        candidates.push({collection, stationId, temp, reportTime, ageMinutes});
      }
    } catch (error) {
      console.log("smn-observation-query-error", collection, error?.message || String(error));
    }
  }

  if (!candidates.length) throw new Error("W2B: no hay temperatura reciente para " + station.name);
  candidates.sort((a, b) =>
    new Date(b.reportTime) - new Date(a.reportTime) ||
    (a.collection === "urn:wmo:md:ar-smn:slt0ci" ? -1 : 1)
  );
  const chosen = candidates[0];

  const values = {};
  try {
    const params = new URLSearchParams({f: "geojson", bbox, limit: "2000"});
    const data = await smnJson(
      SMN_OBS_API + "/collections/" + encodeURIComponent(chosen.collection) + "/items?" + params
    );
    for (const feature of data.features || []) {
      const p = feature?.properties || {};
      if (String(p.wigos_station_identifier || "") !== chosen.stationId || p.reportTime !== chosen.reportTime || !p.name) continue;
      if (p.name === "present_weather" && p.description) values.present_weather = p.description;
      else if (Number.isFinite(Number(p.value))) values[p.name] = Number(p.value);
    }
  } catch (error) {
    console.log("smn-observation-detail-warning", error?.message || String(error));
  }

  return {
    station,
    temp: chosen.temp,
    humidity: Number.isFinite(values.relative_humidity) ? values.relative_humidity : null,
    windSpeed: Number.isFinite(values.wind_speed) ? values.wind_speed : null,
    windDirection: Number.isFinite(values.wind_direction) ? values.wind_direction : null,
    precipitation: Number.isFinite(values.total_precipitation_or_total_water_equivalent)
      ? values.total_precipitation_or_total_water_equivalent : null,
    cloudCover: Number.isFinite(values.cloud_cover_total) ? values.cloud_cover_total : null,
    presentWeather: typeof values.present_weather === "string" ? values.present_weather : null,
    time: chosen.reportTime,
    ageMinutes: Math.max(0, chosen.ageMinutes),
    collection: chosen.collection
  };
}

async function getNearestSMNObservation(lat, lon) {
  try {
    return await getTiepreObservation(lat, lon);
  } catch (tiepreError) {
    console.log("smn-tiepre-warning", tiepreError?.message || String(tiepreError));
  }

  try {
    return await getW2BSMNObservation(lat, lon);
  } catch (w2bError) {
    console.log("smn-w2b-warning", w2bError?.message || String(w2bError));
  }

  throw new Error("No hay observaciones SMN recientes disponibles");
}

async function pushSubscribe(request,env){
  const origin=request.headers.get("Origin");
  if(origin && origin!=="https://roxkleis.github.io"){
    return new Response(JSON.stringify({ok:false,error:"Origin not allowed"}),{status:403,headers:{"Content-Type":"application/json",...corsHeaders(request)}});
  }
  let b;
  try{b=await request.json();}
  catch{return new Response(JSON.stringify({ok:false,error:"Invalid JSON"}),{status:400,headers:{"Content-Type":"application/json",...corsHeaders(request)}});}
  const endpoint=String(b?.endpoint||""),p256dh=String(b?.keys?.p256dh||""),auth=String(b?.keys?.auth||"");
  const lat=Number(b?.lat),lon=Number(b?.lon);
  const timezone=String(b?.timezone||"America/Argentina/Buenos_Aires");
  if(!endpoint.startsWith("https://")||!p256dh||!auth||!Number.isFinite(lat)||lat<-90||lat>90||!Number.isFinite(lon)||lon<-180||lon>180){
    return new Response(JSON.stringify({ok:false,error:"Invalid subscription"}),{status:400,headers:{"Content-Type":"application/json",...corsHeaders(request)}});
  }
  await env.DB.prepare("INSERT INTO push_subscriptions(endpoint,p256dh,auth,lat,lon,alerts_smn,alerts_storm,daily_summary,last_seen_at) VALUES(?,?,?,?,?,?,?, ?,CURRENT_TIMESTAMP) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,lat=excluded.lat,lon=excluded.lon,alerts_smn=excluded.alerts_smn,alerts_storm=excluded.alerts_storm,daily_summary=excluded.daily_summary,last_seen_at=CURRENT_TIMESTAMP")
    .bind(endpoint,p256dh,auth,lat,lon,b?.alerts_smn===false?0:1,b?.alerts_storm===false?0:1,b?.daily_summary===false?0:1).run();
  try{
    await env.DB.prepare("UPDATE push_subscriptions SET timezone=? WHERE endpoint=?").bind(timezone.slice(0,64),endpoint).run();
  }catch(_){}
  return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json",...corsHeaders(request)}});
}
async function pushUnsubscribe(request,env){
  const origin=request.headers.get("Origin");
  if(origin && origin!=="https://roxkleis.github.io"){
    return new Response(JSON.stringify({ok:false,error:"Origin not allowed"}),{status:403,headers:{"Content-Type":"application/json",...corsHeaders(request)}});
  }
  let b;try{b=await request.json();}catch{return new Response(JSON.stringify({ok:false,error:"Invalid JSON"}),{status:400,headers:{"Content-Type":"application/json",...corsHeaders(request)}});}
  const endpoint=String(b?.endpoint||"");
  if(!endpoint)return new Response(JSON.stringify({ok:false,error:"Missing endpoint"}),{status:400,headers:{"Content-Type":"application/json",...corsHeaders(request)}});
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(endpoint).run();
  return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json",...corsHeaders(request)}});
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    try {
      const url = new URL(request.url);
      if (url.pathname === "/push/config" && request.method === "GET") {
        return new Response(JSON.stringify({ok:true,publicKey:env.VAPID_PUBLIC_KEY}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      }
      if (url.pathname === "/observation" && request.method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return new Response(JSON.stringify({ ok: false, error: "Invalid lat/lon" }), {
            status: 400,
            headers: { ...headers, "Content-Type": "application/json" },
          });
        }
        const observation = await getNearestSMNObservation(lat, lon);
        return new Response(JSON.stringify({ ok: true, source: "SMN", observation }), {
          headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
        });
      }
      if (url.pathname === "/push/subscribe" && request.method === "POST") return await pushSubscribe(request,env);
      if (url.pathname === "/push/unsubscribe" && request.method === "POST") return await pushUnsubscribe(request,env);

      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      const requestedHours = Number(url.searchParams.get("hours") || "6");

      if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
          lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return new Response(
          JSON.stringify({ error: "Invalid lat/lon" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
        );
      }

      const hours = Math.max(0, Math.min(72, Math.floor(requestedHours)));
      const metadata = await getMetadata(env);

      if (!metadata) {
        return new Response(
          JSON.stringify({ error: "SMN data not available yet" }),
          { status: 503, headers: { ...headers, "Content-Type": "application/json" } }
        );
      }

      const projected = lccProject(lat, lon, metadata.projection);
      const xIndex = nearestIndex(projected.x, metadata.x0, metadata.dx, metadata.nx);
      const yIndex = nearestIndex(projected.y, metadata.y0, metadata.dy, metadata.ny);
      const gridIndex = yIndex * metadata.nx + xIndex;

      const now = Date.now();
      const init = Date.parse(metadata.initTime);
      let targetLead = Math.round((now - init) / 3600000);
      if (!Number.isFinite(targetLead)) targetLead = 0;

      const available = metadata.leads.map(Number);
      const selectedLeads = available
        .filter((lead) => lead >= targetLead)
        .slice(0, hours + 1);

      // If the current run is still catching up, return the closest available lead(s).
      if (selectedLeads.length === 0 && available.length) {
        selectedLeads.push(available[available.length - 1]);
      }

      const results = await Promise.all(
        selectedLeads.map(async (lead) => {
          const leadIndex = available.indexOf(lead);
          const point = await readPoint(env, metadata, leadIndex, gridIndex);
          return {
            validTime: new Date(init + lead * 3600000).toISOString(),
            lead,
            ...point,
          };
        })
      );

      return new Response(
        JSON.stringify({
          ok: true,
          model: "SMN-WRF",
          resolutionKm: metadata.resolutionKm,
          cycle: metadata.runId,
          location: { lat, lon, xIndex, yIndex },
          currentLead: targetLead,
          data: results,
        }),
        {
          status: 200,
          headers: {
            ...headers,
            "Content-Type": "application/json; charset=utf-8",
          },
        }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "SMN query failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: {
            ...headers,
            "Content-Type": "application/json; charset=utf-8",
          },
        }
      );
    }
  },
  async scheduled(controller, env) {
    try {
      const result = await runNotificationEngine(env);
      console.log("notification-engine", controller.cron, JSON.stringify(result));
    } catch (error) {
      console.log("notification-engine-error", error?.message || String(error));
      controller.noRetry();
    }
  },
};
