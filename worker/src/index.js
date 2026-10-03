import { sendPush } from "./push.js";

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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}


async function pushSubscribe(request,env){
  let b;try{b=await request.json()}catch{return new Response(JSON.stringify({ok:false,error:"Invalid JSON"}),{status:400,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}})}
  const endpoint=String(b?.endpoint||""),p256dh=String(b?.keys?.p256dh||""),auth=String(b?.keys?.auth||"");
  if(!endpoint.startsWith("https://")||!p256dh||!auth)return new Response(JSON.stringify({ok:false,error:"Invalid subscription"}),{status:400,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  const n=v=>Number.isFinite(Number(v))?Number(v):null;
  await env.DB.prepare("INSERT INTO push_subscriptions(endpoint,p256dh,auth,lat,lon,alerts_smn,alerts_storm,daily_summary,last_seen_at) VALUES(?,?,?,?,?,?,?, ?,CURRENT_TIMESTAMP) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,lat=excluded.lat,lon=excluded.lon,alerts_smn=excluded.alerts_smn,alerts_storm=excluded.alerts_storm,daily_summary=excluded.daily_summary,last_seen_at=CURRENT_TIMESTAMP")
    .bind(endpoint,p256dh,auth,n(b?.lat),n(b?.lon),b?.alerts_smn===false?0:1,b?.alerts_storm===false?0:1,b?.daily_summary===false?0:1).run();
  return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
}
async function pushUnsubscribe(request,env){
  let b;try{b=await request.json()}catch{return new Response(JSON.stringify({ok:false,error:"Invalid JSON"}),{status:400,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}})}
  const endpoint=String(b?.endpoint||"");if(!endpoint)return new Response(JSON.stringify({ok:false,error:"Missing endpoint"}),{status:400,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(endpoint).run();
  return new Response(JSON.stringify({ok:true}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
}
async function pushStatus(env){
  const row=await env.DB.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").first();
  return new Response(JSON.stringify({ok:true,subscriptions:Number(row?.count||0)}),{headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
}
async function pushSendOne(request,env){
  let b;try{b=await request.json()}catch{return new Response(JSON.stringify({ok:false,error:"Invalid JSON"}),{status:400,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  }
  const endpoint=String(b?.endpoint||"");
  const row=await env.DB.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE endpoint=?").bind(endpoint).first();
  if(!row)return new Response(JSON.stringify({ok:false,error:"Subscription not found"}),{status:404,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  const result=await sendPush({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},b?.payload||{title:"Clima by richardspulgar",body:"Prueba de notificaciones"},env);
  if(result.gone)await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(endpoint).run();
  return new Response(JSON.stringify({ok:result.ok,status:result.status,gone:result.gone}),{status:result.ok?200:502,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders();

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
      if (url.pathname === "/push/subscribe" && request.method === "POST") return await pushSubscribe(request,env);
      if (url.pathname === "/push/unsubscribe" && request.method === "POST") return await pushUnsubscribe(request,env);
      if (url.pathname === "/push/status" && request.method === "GET") return await pushStatus(env);
      if (url.pathname === "/push/send-one" && request.method === "POST") return await pushSendOne(request,env);

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
};
