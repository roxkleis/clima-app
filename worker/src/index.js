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



const SMN_LEGACY_API = "https://ws.smn.gob.ar/map_items/weather";
const SMN_OBS_API = "https://w2b.smn.gov.ar/oapi";
const SMN_OBS_COLLECTIONS = [
  // El sitio público del SMN utiliza principalmente observaciones SYNOP
  // (slt0ci); autosmn se usa como respaldo cuando existe un dato más reciente.
  "urn:wmo:md:ar-smn:slt0ci",
  "urn:wmo:md:ar-smn:autosmn",
];
const SMN_STATIONS_COLLECTION = "stations";

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
    headers: { "Accept": "application/geo+json, application/json" },
  });
  if (!r.ok) throw new Error(`SMN API HTTP ${r.status}`);
  return await r.json();
}

function stationCoordinates(feature) {
  const p = feature?.properties || {};
  const c = feature?.geometry?.coordinates;
  const lat = Number(
    Array.isArray(c) ? c[1] :
    p.latitude ?? p.lat ?? p.station_latitude ?? p.y
  );
  const lon = Number(
    Array.isArray(c) ? c[0] :
    p.longitude ?? p.lon ?? p.station_longitude ?? p.x
  );
  return Number.isFinite(lat) && Number.isFinite(lon) ? {lat,lon} : null;
}

async function getLegacySMNObservation(lat, lon) {
  const data = await smnJson(SMN_LEGACY_API);
  if (!Array.isArray(data)) throw new Error("SMN legacy: respuesta inválida");

  const candidates = data.map((item) => {
    const itemLat = Number(item?.lat);
    const itemLon = Number(item?.lon);
    const temp = Number(item?.weather?.temp);
    const humidity = Number(item?.weather?.humidity);
    const updatedMs = Number(item?.updated);
    if (!Number.isFinite(itemLat) || !Number.isFinite(itemLon) ||
        !Number.isFinite(temp) || !Number.isFinite(updatedMs)) return null;

    const ageMinutes = (Date.now() - updatedMs) / 60000;
    if (!Number.isFinite(ageMinutes) || ageMinutes < -10 || ageMinutes > 180) return null;

    return {
      station: {
        id: item?.lid ?? item?._id ?? null,
        name: item?.name || "Estación SMN",
        lat: itemLat,
        lon: itemLon,
        distanceKm: haversineKm(lat, lon, itemLat, itemLon),
      },
      temp,
      humidity: Number.isFinite(humidity) ? humidity : null,
      windSpeed: Number.isFinite(Number(item?.weather?.wind_speed))
        ? Number(item.weather.wind_speed) / 3.6 : null,
      windDirection: item?.weather?.wind_deg || null,
      precipitation: null,
      cloudCover: null,
      presentWeather: item?.weather?.description || null,
      time: new Date(updatedMs).toISOString(),
      ageMinutes: Math.max(0, ageMinutes),
      collection: "smn-legacy-map_items-weather",
    };
  }).filter(Boolean);

  if (!candidates.length) throw new Error("SMN legacy: no hay observaciones recientes");

  candidates.sort((a,b) =>
    a.station.distanceKm - b.station.distanceKm ||
    a.ageMinutes - b.ageMinutes
  );
  return candidates[0];
}

async function getW2BSMNObservation(lat, lon) {
  // W2B es la API oficial actual del SMN para observaciones.
  // Primero ubicamos la estación operativa más cercana y después pedimos
  // exclusivamente sus observaciones recientes.
  const stations = await smnJson(
    SMN_OBS_API + "/collections/" + SMN_STATIONS_COLLECTION + "/items?f=geojson&limit=200"
  );

  const stationCandidates = (stations.features || []).map((feature) => {
    const p = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const stationLat = Number(coordinates[1]);
    const stationLon = Number(coordinates[0]);
    const stationId = String(p.wigos_station_identifier || p.id || feature.id || "");
    if (!stationId || !Number.isFinite(stationLat) || !Number.isFinite(stationLon)) return null;
    if (p.status && String(p.status).toLowerCase() !== "operational") return null;
    return {
      id: stationId, name: p.name || "Estación SMN", lat: stationLat, lon: stationLon,
      distanceKm: haversineKm(lat, lon, stationLat, stationLon),
    };
  }).filter(Boolean);

  if (!stationCandidates.length) throw new Error("W2B: no hay estaciones SMN con coordenadas");
  stationCandidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const station = stationCandidates[0];

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
  candidates.sort((a, b) => new Date(b.reportTime) - new Date(a.reportTime) ||
    (a.collection === "urn:wmo:md:ar-smn:slt0ci" ? -1 : 1));
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
    station, temp: chosen.temp,
    humidity: Number.isFinite(values.relative_humidity) ? values.relative_humidity : null,
    windSpeed: Number.isFinite(values.wind_speed) ? values.wind_speed : null,
    windDirection: Number.isFinite(values.wind_direction) ? values.wind_direction : null,
    precipitation: Number.isFinite(values.total_precipitation_or_total_water_equivalent) ? values.total_precipitation_or_total_water_equivalent : null,
    cloudCover: Number.isFinite(values.cloud_cover_total) ? values.cloud_cover_total : null,
    presentWeather: typeof values.present_weather === "string" ? values.present_weather : null,
    time: chosen.reportTime, ageMinutes: Math.max(0, chosen.ageMinutes), collection: chosen.collection
  };
}

async function getNearestSMNObservation(lat, lon) {
  try {
    return await getW2BSMNObservation(lat, lon);
  } catch (w2bError) {
    console.log("smn-w2b-warning", w2bError?.message || String(w2bError));
  }
  try {
    return await getLegacySMNObservation(lat, lon);
  } catch (legacyError) {
    console.log("smn-legacy-warning", legacyError?.message || String(legacyError));
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
