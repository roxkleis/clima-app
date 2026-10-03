const MODELS = {
  ecmwf: {name:"ECMWF", flag:"🇪🇺", label:"IFS HRES · 9 km", endpoint:"https://api.open-meteo.com/v1/ecmwf"},
  gfs:   {name:"GFS",   flag:"🇺🇸", label:"NOAA GFS Global · ~13 km", endpoint:"https://api.open-meteo.com/v1/gfs"},
  icon:  {name:"ICON",  flag:"🇩🇪", label:"DWD ICON Global · ~11 km", endpoint:"https://api.open-meteo.com/v1/dwd-icon"}
};

const $ = id => document.getElementById(id);
const els = {
  location:$("location"),updated:$("updated"),status:$("status"),icon:$("weatherIcon"),condition:$("condition"),
  temperature:$("temperature"),apparent:$("apparent"),rain:$("rain"),humidity:$("humidity"),
  hourly:$("hourly"),daily:$("daily"),lat:$("lat"),lon:$("lon"),accuracy:$("accuracy"),
  message:$("message"),retry:$("retry"),consensusBadge:$("consensusBadge"),
  consensusTitle:$("consensusTitle"),consensusSub:$("consensusSub"),modelDetails:$("modelDetails"),
  modelCards:$("modelCards"),closeDetails:$("closeDetails")
};

const weatherMap = {
  0:["☀️","Despejado"],1:["🌤️","Principalmente despejado"],2:["⛅","Parcialmente nublado"],3:["☁️","Nublado"],
  45:["🌫️","Niebla"],48:["🌫️","Niebla"],51:["🌦️","Llovizna ligera"],53:["🌦️","Llovizna"],
  55:["🌧️","Llovizna intensa"],56:["🌧️","Llovizna helada"],57:["🌧️","Llovizna helada intensa"],
  61:["🌦️","Lluvia ligera"],63:["🌧️","Lluvia"],65:["🌧️","Lluvia intensa"],66:["🌧️","Lluvia helada"],
  67:["🌧️","Lluvia helada intensa"],71:["🌨️","Nieve ligera"],73:["🌨️","Nieve"],75:["❄️","Nieve intensa"],
  77:["🌨️","Granizo de nieve"],80:["🌦️","Chaparrones ligeros"],81:["🌧️","Chaparrones"],
  82:["⛈️","Chaparrones intensos"],85:["🌨️","Nieve"],86:["❄️","Nieve intensa"],
  95:["⛈️","Tormenta"],96:["⛈️","Tormenta con granizo"],99:["⛈️","Tormenta fuerte"]
};
const weatherInfo = code => weatherMap[code] || ["🌤️","Condición variable"];
const fmtHour = iso => new Intl.DateTimeFormat("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso));
const fmtDay = iso => new Intl.DateTimeFormat("es-AR",{weekday:"short",day:"2-digit"}).format(new Date(`${iso}T12:00:00`)).replace(".","");
const setMessage = text => els.message.textContent = text;

function queryUrl(model, lat, lon){
  const hourly = [
    "temperature_2m","relative_humidity_2m","apparent_temperature",
    "precipitation","weather_code","wind_speed_10m","wind_gusts_10m"
  ];
  if(model === "gfs" || model === "icon") hourly.push("precipitation_probability");
  const params = new URLSearchParams({
    latitude:lat, longitude:lon, hourly:hourly.join(","),
    daily:"temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    timezone:"auto", forecast_days:"7"
  });
  return `${MODELS[model].endpoint}?${params.toString()}`;
}

async function fetchModel(model,lat,lon){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),15000);
  try{
    const r = await fetch(queryUrl(model,lat,lon),{cache:"no-store",signal:controller.signal});
    if(!r.ok) throw new Error(`${model.toUpperCase()} HTTP ${r.status}`);
    const data = await r.json();
    if(!data.hourly?.time?.length) throw new Error(`${model.toUpperCase()} sin datos horarios`);
    return {key:model,data};
  } finally { clearTimeout(timer); }
}

function currentIndex(data){
  const now=Date.now(); let idx=0,best=Infinity;
  data.hourly.time.forEach((t,i)=>{
    const diff=Math.abs(new Date(t).getTime()-now);
    if(diff<best){best=diff;idx=i;}
  });
  return idx;
}

function currentSnapshot(item){
  const h=item.data.hourly, i=currentIndex(item.data);
  return {
    key:item.key, name:MODELS[item.key].name, flag:MODELS[item.key].flag, label:MODELS[item.key].label,
    time:h.time[i], temp:Number(h.temperature_2m[i]), apparent:Number(h.apparent_temperature[i]),
    humidity:Number(h.relative_humidity_2m[i]), precipitation:Number(h.precipitation[i]??0),
    probability:h.precipitation_probability ? Number(h.precipitation_probability[i]) : null,
    code:Number(h.weather_code[i]), wind:Number(h.wind_speed_10m?.[i]??0), gust:Number(h.wind_gusts_10m?.[i]??0)
  };
}

function clusters(values,tolerance=1){
  const sorted=[...values].sort((a,b)=>a.temp-b.temp);
  const groups=[];
  for(const item of sorted){
    let placed=false;
    for(const g of groups){
      const center=g.reduce((s,x)=>s+x.temp,0)/g.length;
      if(Math.abs(item.temp-center)<=tolerance){g.push(item);placed=true;break;}
    }
    if(!placed) groups.push([item]);
  }
  groups.sort((a,b)=>b.length-a.length || a[0].temp-b[0].temp);
  return groups;
}

function consensusFor(snaps){
  const groups=clusters(snaps,1);
  const main=groups[0];
  const count=main.length;
  const mean=main.reduce((s,x)=>s+x.temp,0)/count;
  const apparent=main.reduce((s,x)=>s+x.apparent,0)/count;
  const humidity=main.reduce((s,x)=>s+x.humidity,0)/count;
  const precip=main.reduce((s,x)=>s+x.precipitation,0)/count;
  const code=main[0].code;
  const members=new Set(main.map(x=>x.key));
  return {groups,main,count,total:snaps.length,temp:mean,apparent,humidity,precipitation:precip,code,members};
}

function renderModelDetails(snaps,consensus){
  els.modelCards.innerHTML="";
  const mainSet=consensus.members;
  for(const s of snaps){
    const card=document.createElement("div");
    card.className=`model-card ${mainSet.has(s.key) ? "" : "outlier"}`;
    card.innerHTML=`
      <div class="model-top">
        <div class="model-name">${s.flag} ${s.name}</div>
        <div class="model-tag">${mainSet.has(s.key) ? "Grupo principal" : "Diferencia"}</div>
      </div>
      <div class="model-values">
        <div><span>Temperatura</span><strong>${Math.round(s.temp)}°</strong></div>
        <div><span>Sensación</span><strong>${Math.round(s.apparent)}°</strong></div>
        <div><span>Humedad</span><strong>${Math.round(s.humidity)}%</strong></div>
        <div><span>Precipitación</span><strong>${s.precipitation.toFixed(1)} mm</strong></div>
      </div>`;
    els.modelCards.appendChild(card);
  }
}

function renderMain(items,position){
  const snaps=items.map(currentSnapshot);
  const c=consensusFor(snaps);
  const [icon,condition]=weatherInfo(c.code);

  els.location.textContent="Mi ubicación";
  els.updated.textContent=`Actualizado ${new Date().toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit"})}`;
  els.status.textContent=`${items.length} MODELOS OK`;
  els.icon.textContent=icon;
  els.condition.textContent=condition;
  els.temperature.textContent=Math.round(c.temp);
  els.apparent.textContent=Math.round(c.apparent);
  els.rain.textContent=`${c.precipitation.toFixed(1)} mm`;
  els.humidity.textContent=`${Math.round(c.humidity)}%`;
  els.lat.textContent=position.coords.latitude.toFixed(6);
  els.lon.textContent=position.coords.longitude.toFixed(6);
  els.accuracy.textContent=`${Math.round(position.coords.accuracy)} m`;

  els.consensusTitle.textContent=`Consenso ${c.count} de ${c.total}`;
  els.consensusSub.textContent=`${snaps.map(s=>s.name).join(" · ")} · temperatura ±1 °C`;
  els.consensusBadge.classList.toggle("warn",c.count<c.total);
  els.consensusBadge.classList.toggle("split",c.count===1 && c.total>1);

  renderModelDetails(snaps,c);
  renderHourly(items);
  renderDaily(items);

  const failed=Object.keys(MODELS).filter(k=>!items.some(x=>x.key===k));
  setMessage(failed.length
    ? `Conectados: ${items.map(x=>MODELS[x.key].name).join(", ")}. Sin respuesta: ${failed.map(k=>MODELS[k].name).join(", ")}.`
    : "ECMWF, GFS e ICON conectados correctamente. Próximo paso: integrar SMN WRF 4 km.");
}

function renderHourly(items){
  const snapshots=items.map(currentSnapshot);
  const base=items[0].data.hourly;
  const idx=currentIndex(items[0].data);
  els.hourly.innerHTML="";
  for(let off=0;off<6;off++){
    const targetTime=base.time[idx+off]; if(!targetTime) break;
    const vals=[];
    for(const item of items){
      const h=item.data.hourly;
      const j=h.time.indexOf(targetTime);
      if(j>=0) vals.push({
        temp:Number(h.temperature_2m[j]),
        precip:Number(h.precipitation[j]??0),
        code:Number(h.weather_code[j])
      });
    }
    if(!vals.length) continue;
    const temp=vals.reduce((s,x)=>s+x.temp,0)/vals.length;
    const precip=vals.reduce((s,x)=>s+x.precip,0)/vals.length;
    const code=vals[Math.floor(vals.length/2)].code;
    const [ico]=weatherInfo(code);
    const el=document.createElement("div");
    el.className=`hour ${off===0?"now":""}`;
    el.innerHTML=`<div class="time">${off===0?"Ahora":fmtHour(targetTime)}</div><div class="icon">${ico}</div><div class="temp">${Math.round(temp)}°</div><div class="rain">💧 ${precip.toFixed(1)} mm</div>`;
    els.hourly.appendChild(el);
  }
}

function renderDaily(items){
  const base=items[0].data.daily;
  els.daily.innerHTML="";
  for(let i=0;i<Math.min(7,base.time.length);i++){
    const max=[],min=[],codes=[];
    for(const item of items){
      const d=item.data.daily;
      max.push(Number(d.temperature_2m_max[i])); min.push(Number(d.temperature_2m_min[i])); codes.push(Number(d.weather_code[i]));
    }
    const avgMax=max.reduce((s,v)=>s+v,0)/max.length;
    const avgMin=min.reduce((s,v)=>s+v,0)/min.length;
    const code=codes[Math.floor(codes.length/2)];
    const [ico,desc]=weatherInfo(code);
    const el=document.createElement("div");
    el.className="day";
    el.innerHTML=`<div class="name">${i===0?"Hoy":fmtDay(base.time[i])}</div><div class="icon">${ico}</div><div class="desc">${desc}</div><div class="max">${Math.round(avgMax)}°</div><div class="min">${Math.round(avgMin)}°</div>`;
    els.daily.appendChild(el);
  }
}

function showGpsError(error){
  els.status.textContent="GPS";
  setMessage({1:"Permiso de ubicación denegado. Habilitalo para este sitio.",2:"No fue posible determinar tu ubicación.",3:"La solicitud de ubicación tardó demasiado."}[error.code]||"No se pudo obtener la ubicación.");
}

async function loadWeather(){
  els.status.textContent="BUSCANDO";
  setMessage("Obteniendo ubicación y consultando ECMWF, GFS e ICON…");
  navigator.geolocation.getCurrentPosition(async position=>{
    els.lat.textContent=position.coords.latitude.toFixed(6);
    els.lon.textContent=position.coords.longitude.toFixed(6);
    els.accuracy.textContent=`${Math.round(position.coords.accuracy)} m`;
    const results=await Promise.allSettled(Object.keys(MODELS).map(k=>fetchModel(k,position.coords.latitude,position.coords.longitude)));
    const ok=results.filter(r=>r.status==="fulfilled").map(r=>r.value);
    if(!ok.length){
      els.status.textContent="ERROR";
      setMessage("Ningún modelo respondió. Revisá la conexión e intentá nuevamente.");
      return;
    }
    renderMain(ok,position);
  },showGpsError,{enableHighAccuracy:true,timeout:15000,maximumAge:300000});
}

els.retry.addEventListener("click",loadWeather);
els.consensusBadge.addEventListener("click",()=>{
  els.modelDetails.classList.remove("hidden");
  document.body.style.overflow="hidden";
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    els.modelDetails.classList.add("hidden");
    document.body.style.overflow="";
  }
});
els.closeDetails.addEventListener("click",()=>{els.modelDetails.classList.add("hidden");document.body.style.overflow="";});
loadWeather();

els.modelDetails.addEventListener("click",e=>{if(e.target===els.modelDetails){els.modelDetails.classList.add("hidden");document.body.style.overflow="";}});
