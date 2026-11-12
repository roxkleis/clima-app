import { sendPush } from "./push.js";

import { fetchRegionalAlerts, alertPayload } from "./smn-alerts.js";

const TIMEZONE = "America/Argentina/Buenos_Aires";
const SUMMARY_CRON = "0,5,10 8,23 * * *";
const ALERT_CRON = "*/5 * * * *";
const STORM_CRON = "1,16,31,46 * * * *";
const OPEN_MODELS = {
  ecmwf: "https://api.open-meteo.com/v1/ecmwf",
  gfs: "https://api.open-meteo.com/v1/gfs",
  icon: "https://api.open-meteo.com/v1/dwd-icon",
};

async function alreadyDelivered(env,eventKey,endpoint){
  const row=await env.DB.prepare("SELECT 1 AS ok FROM notification_deliveries WHERE event_key=? AND endpoint=? LIMIT 1").bind(eventKey,endpoint).first();
  return !!row;
}
async function markDelivered(env,eventKey,endpoint){
  await env.DB.prepare("INSERT OR IGNORE INTO notification_deliveries(event_key,endpoint) VALUES(?,?)").bind(eventKey,endpoint).run();
}
async function deliver(env,row,eventKey,payload,budget){
  if(await alreadyDelivered(env,eventKey,row.endpoint)) return false;
  if (budget) budget.remaining--;
  const result=await sendPush({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},payload,env);
  if(result.gone){
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(row.endpoint).run();
    return false;
  }
  if(result.ok){
    await markDelivered(env,eventKey,row.endpoint);
    return true;
  }
  return false;
}

function localParts(date,tz){
  const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  const p=Object.fromEntries(fmt.formatToParts(date).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute)};
}

function nextLocalDate(dateString){
  const d=new Date(`${dateString}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}

function modelUrl(base,lat,lon,tz){
  const q=new URLSearchParams({
    latitude:String(lat),longitude:String(lon),
    hourly:"temperature_2m,precipitation,weather_code,wind_gusts_10m,wind_speed_10m",
    daily:"temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    timezone:tz,forecast_days:"2"
  });
  return base+"?"+q.toString();
}

async function fetchModel(base,lat,lon,tz){
  const r=await fetch(modelUrl(base,lat,lon,tz),{cache:"no-store"});
  if(!r.ok) throw new Error("Open-Meteo HTTP "+r.status);
  return await r.json();
}

async function fetchSmnForecast(baseUrl,lat,lon,hours=6){
  const r=await fetch(`${baseUrl}/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&hours=${hours}`,{cache:"no-store"});
  if(r.status===404) return null;
  if(!r.ok) throw new Error("SMN forecast HTTP "+r.status);
  return await r.json();
}

function eventForModel(model,hour){
  const code=Number(hour.code);
  const precip=Number(hour.precip||0);
  const gust=Number(hour.gust||0);
  if(model==="SMN") return precip>=10;
  const thunder=code>=95;
  const severeCombo=(precip>=10 && gust>=50) || precip>=20;
  return thunder || severeCombo;
}

function consensusStorm(models){
  const byTime=new Map();
  for(const [name,series] of Object.entries(models)){
    for(const h of series){
      const key=h.time;
      if(!byTime.has(key)) byTime.set(key,[]);
      if(eventForModel(name,h)) byTime.get(key).push({name,h});
    }
  }
  const candidates=[...byTime.entries()].map(([time,members])=>({time,members})).filter(x=>x.members.length>=3);
  candidates.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  return candidates[0]||null;
}

function openSeries(data){
  const h=data?.hourly;
  if(!h?.time?.length) return [];
  return h.time.map((time,i)=>({
    time,
    code:Number(h.weather_code?.[i] ?? 0),
    precip:Number(h.precipitation?.[i] ?? 0),
    gust:Number(h.wind_gusts_10m?.[i] ?? 0)
  }));
}

function smnSeries(data){
  return (data?.data||[]).map(d=>({
    time:d.validTime,
    code:0,
    precip:Number(d.precipitation??0),
    gust:0
  }));
}


const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
forecastUrl.search = new URLSearchParams({
  latitude: "-34.543", longitude: "-58.713", timezone: TIMEZONE,
  forecast_days: "2", hourly: "temperature_2m",
  daily: "temperature_2m_min,temperature_2m_max,precipitation_probability_max"
});

export function summaryPayload(forecast, date, night) {
  if (night) {
    const target = nextLocalDate(date);
    const hourly = forecast.hourly;
    const temperatures = Array.from({ length: 6 }, (_, hour) =>
      hourly?.temperature_2m?.[hourly?.time?.indexOf(target + "T0" + hour + ":00")]
    );
    if (!temperatures.every(Number.isFinite)) return null;
    const min = Math.round(Math.min(...temperatures));
    const max = Math.round(Math.max(...temperatures));
    const middle = (min + max) / 2;
    const condition = middle < 12 ? "fría" : middle < 18 ? "fresca" : middle < 24 ? "templada" : "calurosa";
    return {
      title: "🌙 Madrugada en San Miguel",
      body: `Madrugada ${condition}: de ${min} a ${max} °C entre las 00:00 y las 05:00.`,
      ttl: 4 * 60 * 60
    };
  }
  const daily = forecast.daily;
  const index = daily?.time?.indexOf(date);
  const min = daily?.temperature_2m_min?.[index];
  const max = daily?.temperature_2m_max?.[index];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const rain = daily.precipitation_probability_max?.[index];
  return {
    title: "🌤️ Hoy en San Miguel",
    body: `Mínima ${Math.round(min)} °C · Máxima ${Math.round(max)} °C.` +
      (Number.isFinite(rain) ? ` Probabilidad máxima de lluvia: ${rain} %.` : ""),
    ttl: 3 * 60 * 60
  };
}

async function runSummary(env, rows, now) {
  const local = localParts(now, TIMEZONE);
  const night = local.hour === 20;
  if ((!night && local.hour !== 5) || local.minute >= 15) return;
  const key = night ? `night-min:${nextLocalDate(local.date)}` : `daily:${local.date}`;
  const recipients = [];
  for (const row of rows) {
    if ((night ? row.night_minimum : row.daily_summary) && !await alreadyDelivered(env, key, row.endpoint)) {
      recipients.push(row);
    }
  }
  if (!recipients.length) return;
  const response = await fetch(forecastUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const payload = summaryPayload(await response.json(), local.date, night);
  if (!payload) throw new Error("Pronóstico incompleto");
  for (const row of recipients) {
    try {
      await deliver(env, row, key, { ...payload, tag: key, url: "./" });
    } catch (error) {
      console.warn("summary-delivery", error?.message);
    }
  }
}

async function runStorm(env, rows, now) {
  const enabled = rows.filter(row => row.alerts_storm && row.lat != null && row.lon != null);
  // Each storm check can use four forecast requests and one Web Push request.
  const batchSize = 10;
  const batch = Math.floor(now.getTime() / (15 * 60 * 1000)) % (Math.ceil(enabled.length / batchSize) || 1);
  const stormRows = enabled.slice(batch * batchSize, (batch + 1) * batchSize);
  for(const row of stormRows){
    try{
      const [ecmwf,gfs,icon,smn]=await Promise.all([
        fetchModel(OPEN_MODELS.ecmwf,row.lat,row.lon,row.timezone||"America/Argentina/Buenos_Aires"),
        fetchModel(OPEN_MODELS.gfs,row.lat,row.lon,row.timezone||"America/Argentina/Buenos_Aires"),
        fetchModel(OPEN_MODELS.icon,row.lat,row.lon,row.timezone||"America/Argentina/Buenos_Aires"),
        fetchSmnForecast(env.WORKER_BASE_URL,row.lat,row.lon)
      ]);
      const models={
        ECMWF:openSeries(ecmwf),
        GFS:openSeries(gfs),
        ICON:openSeries(icon),
        SMN:smnSeries(smn)
      };
      const candidate=consensusStorm(models);
      if(!candidate) continue;
      const when=Date.parse(candidate.time);
      const leadMinutes=(when-Date.now())/60000;
      if(leadMinutes<35 || leadMinutes>110) continue;
      const key=`storm:${Number(row.lat).toFixed(3)}:${Number(row.lon).toFixed(3)}:${candidate.time}`;
      const members=candidate.members.map(x=>x.name).join(", ");
      const payload={
        title:"⛈️ Tormenta probable · Clima by richardspulgar",
        body:`Los modelos muestran una tormenta importante alrededor de las ${new Intl.DateTimeFormat("es-AR",{timeZone:row.timezone||"America/Argentina/Buenos_Aires",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(candidate.time))}. Consenso ${candidate.members.length}/4 (${members}).`,
        tag:key,
        url:"./"
      };
      await deliver(env,row,key,payload);
    }catch(error){ console.warn("storm-delivery", error?.message); }
  }
}


async function runSmnAlerts(env, rows, now) {
  const recipients = rows.filter(row => row.alerts_smn);
  if (!recipients.length) return;
  const alerts = await fetchRegionalAlerts(env.DB, now);
  // 1 índice + hasta 32 XML + hasta 16 envíos = 49 subconsultas externas.
  const budget = { remaining: 16 };
  for (const alert of alerts) {
    const payload = alertPayload(alert, now);
    for (const row of recipients) {
      if (!budget.remaining) return;
      try {
        await deliver(env, row, alert.key, payload, budget);
      } catch (error) {
        console.warn("smn-delivery", error?.message);
      }
    }
  }
}

export async function runNotificationEngine(env, controller) {
  const now = new Date(controller.scheduledTime);
  const result = await env.DB.prepare(
    "SELECT endpoint,p256dh,auth,lat,lon,alerts_smn,alerts_storm,daily_summary,night_minimum," +
    "COALESCE(timezone,'America/Argentina/Buenos_Aires') AS timezone FROM push_subscriptions ORDER BY id LIMIT 40"
  ).all();
  const rows = result.results ?? [];
  if (rows.length) {
    if (controller.cron === SUMMARY_CRON) await runSummary(env, rows, now);
    if (controller.cron === ALERT_CRON) await runSmnAlerts(env, rows, now);
    if (controller.cron === STORM_CRON) await runStorm(env, rows, now);
  }
  return { ok: true, subscriptions: rows.length };
}
