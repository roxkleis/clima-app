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

async function getNearestSMNObservation(lat, lon) {
  const stationUrl = `${SMN_OBS_API}/collections/${SMN_STATIONS_COLLECTION}/items?f=json&limit=200`;
  const stationData = await smnJson(stationUrl);

  const stations = (stationData.features || [])
    .map((feature) => {
      const properties = feature.properties || {};
      const coords = stationCoordinates(feature);
      const id = properties.wigos_station_identifier || properties.id || feature.id;
      if (!id || !coords) return null;
      return {
        id: String(id),
        name: properties.name || "Estación SMN",
        lat: coords.lat,
        lon: coords.lon,
        status: properties.status || "unknown",
      };
    })
    .filter((station) => station && station.status !== "standBy")
    .map((station) => ({
      ...station,
      distanceKm: haversineKm(lat, lon, station.lat, station.lon),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  if (!stations.length) {
    throw new Error("SMN stations no contiene coordenadas utilizables");
  }

  // Primero buscamos en las estaciones más cercanas y en ambas colecciones
  // oficiales. Esto permite coincidir con el dato REF/SYNOP que muestra
  // smn.gob.ar y tener autosmn como respaldo.
  for (const station of stations.slice(0, 8)) {
    for (const collection of SMN_OBS_COLLECTIONS) {
      try {
        const params = new URLSearchParams({
          f: "json",
          limit: "120",
          sortby: "-reportTime",
          wigos_station_identifier: station.id,
          name: "air_temperature",
        });

        const url = `${SMN_OBS_API}/collections/${encodeURIComponent(collection)}/items?${params}`;
        const data = await smnJson(url);
        const features = data.features || [];
        if (!features.length) continue;

        // No dependemos de que el servidor ordene correctamente: elegimos
        // explícitamente el reporte más reciente.
        const valid = features
          .map((feature) => ({
            feature,
            reportTime: feature.properties?.reportTime,
            value: Number(feature.properties?.value),
          }))
          .filter((x) => x.reportTime && Number.isFinite(x.value))
          .sort((a, b) => new Date(b.reportTime) - new Date(a.reportTime));

        for (const candidate of valid.slice(0, 5)) {
          const reportTime = candidate.reportTime;
          const ageMinutes = (Date.now() - new Date(reportTime).getTime()) / 60000;
          if (!Number.isFinite(ageMinutes) || ageMinutes < -10 || ageMinutes > 180) continue;

          // Recuperamos el resto de variables del mismo reporte.
          const reportId = candidate.feature.properties?.reportId;
          let reportFeatures = features.filter(
            (feature) => feature.properties?.reportTime === reportTime &&
              (!reportId || feature.properties?.reportId === reportId)
          );

          // Si el filtro name=air_temperature devolvió sólo temperatura,
          // pedimos el reporte completo para humedad/viento/precipitación.
          if (reportFeatures.length < 2 && reportId) {
            const fullParams = new URLSearchParams({
              f: "json",
              limit: "80",
              reportId: reportId,
            });
            try {
              const full = await smnJson(
                `${SMN_OBS_API}/collections/${encodeURIComponent(collection)}/items?${fullParams}`
              );
              if (Array.isArray(full.features) && full.features.length) {
                reportFeatures = full.features;
              }
            } catch (_) {}
          }

          const values = {};
          for (const feature of reportFeatures) {
            const p = feature.properties || {};
            if (p.name && Number.isFinite(Number(p.value))) {
              values[p.name] = Number(p.value);
            }
          }
          values.air_temperature = candidate.value;

          return {
            station: {
              id: station.id,
              name: station.name,
              lat: station.lat,
              lon: station.lon,
              distanceKm: station.distanceKm,
            },
            temp: candidate.value,
            humidity: Number.isFinite(values.relative_humidity) ? values.relative_humidity : null,
            windSpeed: Number.isFinite(values.wind_speed) ? values.wind_speed : null,
            precipitation: Number.isFinite(values.total_precipitation_or_total_water_equivalent)
              ? values.total_precipitation_or_total_water_equivalent : null,
            time: reportTime,
            ageMinutes: Math.max(0, ageMinutes),
            collection,
          };
        }
      } catch (error) {
        console.log(
          "smn-observation-error",
          station.name,
          collection,
          error?.message || String(error)
        );
      }
    }
  }

  throw new Error("No hay una observación SMN reciente cerca de la ubicación");
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
