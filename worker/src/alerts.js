import { sendPush } from "./push.js";

const CAP_FEED = "https://ssl.smn.gob.ar/CAP/AR.php";
const OPEN_MODELS = {
  ecmwf: "https://api.open-meteo.com/v1/ecmwf",
  gfs: "https://api.open-meteo.com/v1/gfs",
  icon: "https://api.open-meteo.com/v1/dwd-icon",
};

const esc = s => String(s ?? "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'");
function tagText(xml, tag, fallback=""){
  const re = new RegExp("<(?:[\\w-]+:)?"+tag+"\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?"+tag+">","i");
  const m = xml.match(re);
  return m ? esc(m[1].replace(/<!\[CDATA\[/g,"").replace(/\]\]>/g,"").trim()) : fallback;
}
function tagBlocks(xml, tag){
  const re = new RegExp("<(?:[\\w-]+:)?"+tag+"\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?"+tag+">","gi");
  return [...xml.matchAll(re)].map(m=>m[1]);
}
function firstTag(block, tag, fallback=""){ return tagText(block,tag,fallback); }

function parsePolygon(area){
  const raw = firstTag(area,"polygon","");
  const points = raw.trim().split(/\\s+/).map(p=>p.split(",").map(Number)).filter(p=>p.length===2 && p.every(Number.isFinite));
  return points.length >= 3 ? points : [];
}
function pointInPolygon(lat,lon,poly){
  if(poly.length<3) return false;
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const yi=poly[i][0], xi=poly[i][1], yj=poly[j][0], xj=poly[j][1];
    const hit=((yi>lat)!==(yj>lat)) && (lon < (xj-xi)*(lat-yi)/(yj-yi)+xi);
    if(hit) inside=!inside;
  }
  return inside;
}
function parseCap(xml){
  const alerts = [];
  const blocks = /<alert\\b[\\s\\S]*?<\\/alert>/gi.test(xml)
    ? [xml.match(/<alert\\b[\\s\\S]*?<\\/alert>/gi)?.[0] || xml]
    : [xml];

  for(const block of blocks){
    const identifier=firstTag(block,"identifier","");
    const status=firstTag(block,"status","Actual");
    const msgType=firstTag(block,"msgType","Alert");
    if(!identifier || (status!=="Actual" && status!=="Test")) continue;
    const infos=tagBlocks(block,"info");
    for(const info of infos.length?infos:[block]){
      const event=firstTag(info,"event","Alerta meteorológica");
      const severity=firstTag(info,"severity","Unknown");
      const certainty=firstTag(info,"certainty","Unknown");
      const urgency=firstTag(info,"urgency","Unknown");
      const headline=firstTag(info,"headline",event);
      const description=firstTag(info,"description","");
      const instruction=firstTag(info,"instruction","");
      const effective=firstTag(info,"effective",firstTag(block,"sent",""));
      const onset=firstTag(info,"onset",effective);
      const expires=firstTag(info,"expires","");
      const areas=tagBlocks(info,"area");
      for(const area of areas.length?areas:[info]){
        alerts.push({
          identifier, event, severity, certainty, urgency, headline, description, instruction,
          effective, onset, expires, areaDesc:firstTag(area,"areaDesc",""),
          polygon:parsePolygon(area)
        });
      }
    }
  }
  return alerts;
}

async function fetchCapAlerts(){
  const r=await fetch(CAP_FEED,{headers:{"Accept":"application/xml,text/xml,*/*","User-Agent":"Clima-by-richardspulgar/1.0"},cache:"no-store"});
  if(!r.ok) throw new Error("SMN CAP HTTP "+r.status);
  const xml=await r.text();
  let alerts=parseCap(xml);
  if(alerts.length) return alerts;

  // Algunos feeds CAP publican un RSS/índice que apunta a los XML individuales.
  const links=[...xml.matchAll(/<(?:[\\w-]+:)?(?:link|guid)\\b[^>]*?(?:href=["']([^"']+)["']|>(https?:[^<]+)<)/gi)]
    .map(m=>m[1]||m[2]).filter(Boolean)
    .map(u=>u.replace(/&amp;/g,"&"))
    .filter(u=>/^https?:\\/\\//i.test(u))
    .slice(0,20);

  for(const url of [...new Set(links)]){
    try{
      const rr=await fetch(url,{headers:{"Accept":"application/xml,text/xml,*/*","User-Agent":"Clima-by-richardspulgar/1.0"},cache:"no-store"});
      if(rr.ok) alerts.push(...parseCap(await rr.text()));
    }catch(_){}
  }
  return alerts;
}

function alertActive(a,now){
  if(a.expires){
    const t=Date.parse(a.expires);
    if(Number.isFinite(t) && t<now) return false;
  }
  return true;
}
function severityRank(s){ return ({Extreme:4,Severe:3,Moderate:2,Minor:1,Unknown:0})[s]||0; }

function alertCovers(a,lat,lon){
  if(a.polygon?.length>=3) return pointInPolygon(lat,lon,a.polygon);
  return false;
}

function formatAlertPayload(a){
  const color = a.severity==="Extreme" ? "roja" : a.severity==="Severe" ? "naranja" : "amarilla";
  const desc = (a.description||"").replace(/\\s+/g," ").trim();
  const extra = desc ? " "+desc.slice(0,180) : "";
  return {
    title: `⚠️ Alerta SMN ${color}: ${a.event}`,
    body: `${a.headline || "El SMN emitió una alerta para tu zona."}${extra}`,
    tag: `smn-${a.identifier}-${a.severity}`,
    url: "https://ws2.smn.gob.ar/alertas"
  };
}

async function ensureSchema(env){
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    event_key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(event_key, endpoint)
  )`).run();
  const cols=await env.DB.prepare("PRAGMA table_info(push_subscriptions)").all();
  if(!(cols.results||[]).some(x=>x.name==="timezone")){
    await env.DB.prepare("ALTER TABLE push_subscriptions ADD COLUMN timezone TEXT DEFAULT 'America/Argentina/Buenos_Aires'").run();
  }
}

async function alreadyDelivered(env,eventKey,endpoint){
  const row=await env.DB.prepare("SELECT 1 AS ok FROM notification_deliveries WHERE event_key=? AND endpoint=? LIMIT 1").bind(eventKey,endpoint).first();
  return !!row;
}
async function markDelivered(env,eventKey,endpoint){
  await env.DB.prepare("INSERT OR IGNORE INTO notification_deliveries(event_key,endpoint) VALUES(?,?)").bind(eventKey,endpoint).run();
}
async function deliver(env,row,eventKey,payload){
  if(await alreadyDelivered(env,eventKey,row.endpoint)) return false;
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

function modelUrl(base,lat,lon,tz){
  const q=new URLSearchParams({
    latitude:String(lat),longitude:String(lon),
    hourly:"precipitation,weather_code,wind_gusts_10m,wind_speed_10m",
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

async function fetchSmnForecast(baseUrl,lat,lon){
  const r=await fetch(`${baseUrl}/forecast?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&hours=6`,{cache:"no-store"});
  if(!r.ok) throw new Error("SMN forecast HTTP "+r.status);
  return await r.json();
}

function eventForModel(model,hour){
  const code=Number(hour.code);
  const precip=Number(hour.precip||0);
  const gust=Number(hour.gust||0);
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
    gust:Number(d.windSpeed??0)*3.6
  }));
}

function consensusDaily(datas){
  const maxs=[],mins=[],precs=[],codes=[];
  for(const d of datas){
    if(Number.isFinite(Number(d?.daily?.temperature_2m_max?.[0]))) maxs.push(Number(d.daily.temperature_2m_max[0]));
    if(Number.isFinite(Number(d?.daily?.temperature_2m_min?.[0]))) mins.push(Number(d.daily.temperature_2m_min[0]));
    if(Number.isFinite(Number(d?.daily?.precipitation_sum?.[0]))) precs.push(Number(d.daily.precipitation_sum[0]));
    if(Number.isFinite(Number(d?.daily?.weather_code?.[0]))) codes.push(Number(d.daily.weather_code[0]));
  }
  const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
  return {max:avg(maxs),min:avg(mins),precip:avg(precs),code:codes.length?Math.max(...codes):0,count:maxs.length};
}

async function runStormAndDaily(env,rows,now){
  const dueDaily=[];
  const stormRows=rows.filter(r=>Number.isFinite(Number(r.lat))&&Number.isFinite(Number(r.lon)));
  for(const row of stormRows){
    const tz=row.timezone || "America/Argentina/Buenos_Aires";
    const lp=localParts(now,tz);

    if(row.daily_summary && lp.hour===8 && lp.minute<15){
      const key=`daily:${lp.date}`;
      if(!(await alreadyDelivered(env,key,row.endpoint))) dueDaily.push({row,key,tz});
    }
  }

  for(const item of dueDaily){
    try{
      const [ecmwf,gfs,icon,smn]=await Promise.all([
        fetchModel(OPEN_MODELS.ecmwf,item.row.lat,item.row.lon,item.tz),
        fetchModel(OPEN_MODELS.gfs,item.row.lat,item.row.lon,item.tz),
        fetchModel(OPEN_MODELS.icon,item.row.lat,item.row.lon,item.tz),
        fetchSmnForecast(env.WORKER_BASE_URL,item.row.lat,item.row.lon)
      ]);
      const d=consensusDaily([ecmwf,gfs,icon]);
      const smnTemps=(smn.data||[]).filter(x=>String(x.validTime).startsWith(item.key.slice(6))).map(x=>Number(x.temperature)).filter(Number.isFinite);
      const maxVals=[d.max,...(smnTemps.length?[Math.max(...smnTemps)]:[])].filter(Number.isFinite);
      const minVals=[d.min,...(smnTemps.length?[Math.min(...smnTemps)]:[])].filter(Number.isFinite);
      const max=maxVals.length?maxVals.reduce((s,x)=>s+x,0)/maxVals.length:d.max;
      const min=minVals.length?minVals.reduce((s,x)=>s+x,0)/minVals.length:d.min;
      const rain=d.precip;
      const rainText=Number.isFinite(rain)&&rain>=1?` Lluvia estimada: ${rain.toFixed(1)} mm.`:"";
      const payload={
        title:"🌤️ Resumen diario · Clima by richardspulgar",
        body:`Hoy: máx ${Math.round(max)}° · mín ${Math.round(min)}°.${rainText}`,
        tag:`daily-${item.key}`,
        url:"./"
      };
      await deliver(env,item.row,item.key,payload);
    }catch(error){ console.log("daily error",item.row.endpoint,error?.message||error); }
  }

  for(const row of stormRows){
    if(!row.alerts_storm) continue;
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
    }catch(error){ console.log("storm error",row.endpoint,error?.message||error); }
  }
}

async function runSmnAlerts(env,rows,now){
  const enabled=rows.filter(r=>r.alerts_smn&&Number.isFinite(Number(r.lat))&&Number.isFinite(Number(r.lon)));
  if(!enabled.length) return;
  let alerts=[];
  try{ alerts=(await fetchCapAlerts()).filter(a=>alertActive(a,now)); }
  catch(error){ console.log("SMN CAP error",error?.message||error); return; }

  for(const row of enabled){
    const matching=alerts.filter(a=>severityRank(a.severity)>=2 && alertCovers(a,row.lat,row.lon));
    if(!matching.length) continue;
    matching.sort((a,b)=>severityRank(b.severity)-severityRank(a.severity) || Date.parse(b.effective||0)-Date.parse(a.effective||0));
    const a=matching[0];
    const key=`smn:${a.identifier}:${row.endpoint}`;
    await deliver(env,row,key,formatAlertPayload(a));
  }
}

export async function runNotificationEngine(env){
  await ensureSchema(env);
  const result=await env.DB.prepare(`SELECT endpoint,p256dh,auth,lat,lon,alerts_smn,alerts_storm,daily_summary,COALESCE(timezone,'America/Argentina/Buenos_Aires') AS timezone FROM push_subscriptions ORDER BY id LIMIT 40`).all();
  const rows=result.results||[];
  if(!rows.length) return {ok:true,subscriptions:0};
  const now=new Date();
  await runSmnAlerts(env,rows,now);
  await runStormAndDaily(env,rows,now);
  return {ok:true,subscriptions:rows.length};
}
