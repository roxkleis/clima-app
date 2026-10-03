// Clima by richardspulgar · consensus engine v10 · observación SMN + consenso probabilístico
const MODELS = {
  ecmwf: {name:"ECMWF", flag:"🇪🇺", label:"IFS HRES · 9 km", endpoint:"https://api.open-meteo.com/v1/ecmwf"},
  gfs:   {name:"GFS",   flag:"🇺🇸", label:"NOAA GFS Global · ~13 km", endpoint:"https://api.open-meteo.com/v1/gfs"},
  icon:  {name:"ICON",  flag:"🇩🇪", label:"DWD ICON Global · ~11 km", endpoint:"https://api.open-meteo.com/v1/dwd-icon"},
  smn:   {name:"SMN",   flag:"🇦🇷", label:"WRF Argentina · 4 km", endpoint:"https://clima-consenso-smn.roxkleis.workers.dev/forecast"}
};

const $ = id => document.getElementById(id);
const els = {
  location:$('location'),updated:$('updated'),status:$('status'),icon:$('weatherIcon'),condition:$('condition'),observation:$('observation'),
  temperature:$('temperature'),apparent:$('apparent'),rain:$('rain'),humidity:$('humidity'),
  hourly:$('hourly'),daily:$('daily'),lat:$('lat'),lon:$('lon'),accuracy:$('accuracy'),
  message:$('message'),retry:$('retry'),consensusBadge:$('consensusBadge'),
  consensusTitle:$('consensusTitle'),consensusSub:$('consensusSub'),modelDetails:$('modelDetails'),
  modelCards:$('modelCards'),closeDetails:$('closeDetails')
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
const fmtHour = iso => new Intl.DateTimeFormat('es-AR',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
const fmtDay = iso => new Intl.DateTimeFormat('es-AR',{weekday:'short',day:'2-digit'}).format(new Date(`${iso}T12:00:00`)).replace('.','');
const setMessage = text => els.message.textContent = text;

async function reverseGeocode(lat,lon){
  const key=`clima-location-${lat.toFixed(3)}-${lon.toFixed(3)}`;
  try{
    const cached=sessionStorage.getItem(key);
    if(cached) return JSON.parse(cached);
  }catch(_){}

  const url=`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=es`;
  const r=await fetch(url,{cache:'no-store'});
  if(!r.ok) throw new Error(`Reverse geocoding HTTP ${r.status}`);
  const data=await r.json();

  const locality=data.locality || data.city || data.principalSubdivision || '';
  const province=data.principalSubdivision || '';
  const name=locality && province && locality.toLowerCase()!==province.toLowerCase()
    ? `${locality}, ${province.replace(/ Province$/,'').replace(/ Province of /,'')}`
    : locality || province || 'Mi ubicación';

  const result={name,locality,province};
  try{sessionStorage.setItem(key,JSON.stringify(result));}catch(_){}
  return result;
}


function queryUrl(model, lat, lon){
  const hourly = [
    'temperature_2m','relative_humidity_2m','apparent_temperature',
    'precipitation','weather_code','wind_speed_10m','wind_gusts_10m'
  ];
  if(model === 'gfs' || model === 'icon') hourly.push('precipitation_probability');
  const params = new URLSearchParams({
    latitude:lat, longitude:lon, hourly:hourly.join(','),
    daily:'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    timezone:'auto', forecast_days:'7'
  });
  return `${MODELS[model].endpoint}?${params.toString()}`;
}

async function fetchOpenMeteo(model,lat,lon){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),15000);
  try{
    const r = await fetch(queryUrl(model,lat,lon),{cache:'no-store',signal:controller.signal});
    if(!r.ok) throw new Error(`${model.toUpperCase()} HTTP ${r.status}`);
    const data = await r.json();
    if(!data.hourly?.time?.length) throw new Error(`${model.toUpperCase()} sin datos horarios`);
    return {key:model,data};
  } finally { clearTimeout(timer); }
}

async function fetchSMN(lat,lon){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),15000);
  try{
    const url = `${MODELS.smn.endpoint}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&hours=72`;
    const r = await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!r.ok) throw new Error(`SMN HTTP ${r.status}`);
    const data = await r.json();
    if(!Array.isArray(data.data) || !data.data.length) throw new Error('SMN sin datos horarios');
    return {key:'smn',data};
  } finally { clearTimeout(timer); }
}

function currentIndex(data,targetIso=null){
  const target = targetIso ? new Date(targetIso).getTime() : Date.now();
  let idx=0,best=Infinity;
  data.hourly.time.forEach((t,i)=>{
    const diff=Math.abs(new Date(t).getTime()-target);
    if(diff<best){best=diff;idx=i;}
  });
  return idx;
}

const SMN_OBS_API='https://w2b.smn.gov.ar/oapi';
const SMN_OBS_COLLECTION='urn:wmo:md:ar-smn:autosmn';
const SMN_STATIONS_COLLECTION='stations';

function haversineKm(lat1,lon1,lat2,lon2){
  const R=6371;
  const p1=lat1*Math.PI/180, p2=lat2*Math.PI/180;
  const dp=(lat2-lat1)*Math.PI/180, dl=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

async function fetchJsonWithTimeout(url,timeoutMs=12000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }finally{clearTimeout(timer);}
}

async function fetchNearestSMNObservation(lat,lon){
  const stationUrl=`${SMN_OBS_API}/collections/${SMN_STATIONS_COLLECTION}/items?f=json&limit=200`;
  const stationData=await fetchJsonWithTimeout(stationUrl);
  const stations=(stationData.features||[])
    .map(f=>{
      const c=f.geometry?.coordinates;
      const p=f.properties||{};
      if(!Array.isArray(c)||c.length<2) return null;
      return {
        id:p.id||f.id,
        name:p.name||'Estación SMN',
        lon:Number(c[0]),lat:Number(c[1]),
        status:p.status
      };
    })
    .filter(s=>s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.status!=='standBy')
    .map(s=>({...s,distanceKm:haversineKm(lat,lon,s.lat,s.lon)}))
    .sort((a,b)=>a.distanceKm-b.distanceKm);

  if(!stations.length) throw new Error('SMN sin estaciones georreferenciadas');

  // Probamos las tres estaciones más cercanas: una estación puede estar
  // operativa en el catálogo pero no haber reportado recientemente.
  for(const station of stations.slice(0,3)){
    const params=new URLSearchParams({
      f:'json',
      limit:'40',
      sortby:'-reportTime',
      wigos_station_identifier:station.id
    });
    try{
      const data=await fetchJsonWithTimeout(`${SMN_OBS_API}/collections/${encodeURIComponent(SMN_OBS_COLLECTION)}/items?${params.toString()}`);
      const features=data.features||[];
      const latestReport=features
        .map(f=>f.properties?.reportTime)
        .filter(Boolean)
        .sort((a,b)=>new Date(b)-new Date(a))[0];
      if(!latestReport) continue;

      const sameReport=features.filter(f=>f.properties?.reportTime===latestReport);
      const values={};
      for(const feature of sameReport){
        const p=feature.properties||{};
        if(p.name && Number.isFinite(Number(p.value))) values[p.name]=Number(p.value);
      }

      const temp=values.air_temperature;
      if(!Number.isFinite(temp)) continue;

      const ageMinutes=(Date.now()-new Date(latestReport).getTime())/60000;
      if(ageMinutes>180) continue;

      return {
        station,
        temp,
        humidity:Number.isFinite(values.relative_humidity)?values.relative_humidity:null,
        windSpeed:Number.isFinite(values.wind_speed)?values.wind_speed:null,
        precipitation:Number.isFinite(values.total_precipitation_or_total_water_equivalent)
          ? values.total_precipitation_or_total_water_equivalent : null,
        time:latestReport,
        ageMinutes:Math.max(0,ageMinutes)
      };
    }catch(error){
      console.warn('SMN observación',station.name,error);
    }
  }

  throw new Error('No hay una observación SMN reciente cerca de la ubicación.');
}

function apparentSMN(tempC,rh,windMs){
  if(!Number.isFinite(tempC)) return null;
  if(Number.isFinite(windMs) && tempC <= 10 && windMs > 1.34){
    const v=windMs*3.6;
    return 13.12 + 0.6215*tempC - 11.37*Math.pow(v,0.16) + 0.3965*tempC*Math.pow(v,0.16);
  }
  if(Number.isFinite(rh) && tempC >= 27){
    const T=tempC, R=rh;
    const hi=-8.784695 + 1.61139411*T + 2.338549*R - 0.14611605*T*R - 0.012308094*T*T - 0.016424828*R*R + 0.002211732*T*T*R + 0.00072546*T*R*R - 0.000003582*T*T*R*R;
    return (hi < T) ? T : hi;
  }
  return tempC;
}

function currentSnapshot(item,targetIso=null){
  if(item.key === 'smn'){
    const d=item.data.data[0];
    return {
      key:'smn',name:MODELS.smn.name,flag:MODELS.smn.flag,label:MODELS.smn.label,
      time:d.validTime,temp:Number(d.temperature),apparent:apparentSMN(Number(d.temperature),Number(d.humidity),Number(d.windSpeed)),
      humidity:Number(d.humidity),precipitation:Number(d.precipitation??0),probability:null,
      code:null,wind:Number(d.windSpeed??0),gust:null
    };
  }
  const h=item.data.hourly, i=currentIndex(item.data,targetIso);
  return {
    key:item.key,name:MODELS[item.key].name,flag:MODELS[item.key].flag,label:MODELS[item.key].label,
    time:h.time[i],temp:Number(h.temperature_2m[i]),apparent:Number(h.apparent_temperature[i]),
    humidity:Number(h.relative_humidity_2m[i]),precipitation:Number(h.precipitation[i]??0),
    probability:h.precipitation_probability ? Number(h.precipitation_probability[i]) : null,
    code:Number(h.weather_code[i]),wind:Number(h.wind_speed_10m?.[i]??0),gust:Number(h.wind_gusts_10m?.[i]??0)
  };
}

function clusters(values,tolerance=1){
  // El consenso se calcula sobre la temperatura mostrada (entera),
  // para que 14°, 15° y 16° formen el mismo grupo dentro de ±1 °C.
  const normalized=values.map(x=>({...x,consensusTemp:Math.round(x.temp)}));
  const sorted=[...normalized].sort((a,b)=>a.consensusTemp-b.consensusTemp);

  // Un grupo es coherente si todos sus valores caben dentro de
  // una ventana de ±tolerance alrededor de un valor central.
  // Con tolerance=1 esto equivale a un rango máximo de 2 °C.
  const groups=[];
  let remaining=[...sorted];

  while(remaining.length){
    let best=[];
    for(let i=0;i<remaining.length;i++){
      const candidate=[];
      for(let j=i;j<remaining.length;j++){
        if(remaining[j].consensusTemp - remaining[i].consensusTemp <= tolerance*2){
          candidate.push(remaining[j]);
        }else{
          break;
        }
      }
      if(candidate.length>best.length){
        best=candidate;
      }
    }

    if(!best.length) best=[remaining[0]];

    const bestKeys=new Set(best.map(x=>x.key));
    groups.push(best);
    remaining=remaining.filter(x=>!bestKeys.has(x.key));
  }

  groups.sort((a,b)=>b.length-a.length || a[0].temp-b[0].temp);
  return groups;
}

function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  if(!sorted.length) return null;
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
}

function consensusFor(snaps){
  const usable=snaps.filter(s=>Number.isFinite(s.temp));
  const groups=clusters(usable,1);
  const main=groups[0] || [];
  const count=main.length;
  const mainRange=main.length ? Math.max(...main.map(x=>Math.round(x.temp)))-Math.min(...main.map(x=>Math.round(x.temp))) : Infinity;
  const overallRange=usable.length ? Math.max(...usable.map(x=>Math.round(x.temp)))-Math.min(...usable.map(x=>Math.round(x.temp))) : Infinity;
  const strongMajority=count>=3;
  const hasFullConsensus=count===usable.length;
  const split22=usable.length===4 && groups.length===2 && groups[0].length===2 && groups[1].length===2;
  // Si no existe una mayoría clara, usamos la mediana de todos los modelos
  // para evitar que el resultado dependa del orden de llegada de las APIs.
  const consensusTemp=strongMajority
    ? main.reduce((s,x)=>s+x.temp,0)/count
    : median(usable.map(x=>x.temp));
  const mean=consensusTemp;
  const apparentVals=main.filter(x=>Number.isFinite(x.apparent));
  const humidityVals=main.filter(x=>Number.isFinite(x.humidity));
  const precipVals=main.filter(x=>Number.isFinite(x.precipitation));
  const apparent=apparentVals.length ? apparentVals.reduce((s,x)=>s+x.apparent,0)/apparentVals.length : null;
  const humidity=humidityVals.length ? humidityVals.reduce((s,x)=>s+x.humidity,0)/humidityVals.length : null;
  const precip=precipVals.length ? precipVals.reduce((s,x)=>s+x.precipitation,0)/precipVals.length : 0;
  const codeVals=main.filter(x=>Number.isFinite(x.code));
  const code=codeVals.length ? codeVals[0].code : 0;
  const members=new Set(main.map(x=>x.key));
  let confidence='débil';
  if(hasFullConsensus) confidence='alta';
  else if(strongMajority && mainRange<=2) confidence='media';
  else if(count>=2 && mainRange<=2) confidence='baja';
  return {
    groups,main,count,total:usable.length,temp:mean,apparent,humidity,precipitation:precip,code,
    members,split22,mainRange,overallRange,confidence,hasMajority:strongMajority
  };
}


function consensusWeatherCode(snaps){
  const codes=snaps.filter(s=>Number.isFinite(s.code)).map(s=>s.code);
  if(!codes.length) return 0;
  const counts=new Map();
  for(const code of codes) counts.set(code,(counts.get(code)||0)+1);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1] || a[0]-b[0])[0][0];
}

function renderModelDetails(snaps,consensus){
  els.modelCards.innerHTML='';
  const mainSet=consensus.members;
  const splitGroups=consensus.split22 ? consensus.groups : null;
  for(const s of snaps){
    const card=document.createElement('div');
    let tag='';
    let isOutlier=false;

    if(splitGroups){
      const groupIndex=splitGroups.findIndex(g=>g.some(x=>x.key===s.key));
      const group=groupIndex >= 0 ? splitGroups[groupIndex] : [];
      tag=`Grupo ${String.fromCharCode(65 + Math.max(0, groupIndex))} · ${group.length}/4`;
    }else{
      isOutlier=!mainSet.has(s.key);
      tag=mainSet.has(s.key) ? 'Grupo principal' : 'Diferencia';
    }

    card.className=`model-card ${isOutlier ? 'outlier' : ''}`;
    card.innerHTML=`
      <div class="model-top">
        <div class="model-name">${s.flag} ${s.name}</div>
        <div class="model-tag">${tag}</div>
      </div>
      <div class="model-values">
        <div><span>Temperatura</span><strong>${Number.isFinite(s.temp)?Math.round(s.temp)+'°':'—'}</strong></div>
        <div><span>Sensación</span><strong>${Number.isFinite(s.apparent)?Math.round(s.apparent)+'°':'—'}</strong></div>
        <div><span>Humedad</span><strong>${Number.isFinite(s.humidity)?Math.round(s.humidity)+'%':'—'}</strong></div>
        <div><span>Precipitación</span><strong>${Number.isFinite(s.precipitation)?s.precipitation.toFixed(1)+' mm':'—'}</strong></div>
      </div>`;
    els.modelCards.appendChild(card);
  }
}

function renderMain(items,position,placeName=null,observation=null){
  const smn=items.find(x=>x.key==='smn');
  const targetIso=smn?.data?.data?.[0]?.validTime || null;
  const snaps=items.map(x=>currentSnapshot(x,targetIso));
  const c=consensusFor(snaps);
  const [icon,condition]=weatherInfo(consensusWeatherCode(snaps));

  els.location.textContent=placeName || 'Mi ubicación';
  els.updated.textContent=`Actualizado ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}`;
  els.status.textContent=`${items.length} MODELOS OK`;
  els.icon.textContent=icon;
  els.condition.textContent=condition;
  // AHORA: observación meteorológica real de la estación SMN más cercana.
  // Si no hay una observación reciente, se conserva el consenso como fallback.
  const observed=observation && Number.isFinite(observation.temp);
  els.temperature.textContent=observed ? Math.round(observation.temp) : (Number.isFinite(c.temp)?Math.round(c.temp):'—');
  els.apparent.textContent=observed
    ? Math.round(apparentSMN(observation.temp,observation.humidity,null) ?? observation.temp)
    : (Number.isFinite(c.apparent)?Math.round(c.apparent):'—');
  els.rain.textContent=`${c.precipitation.toFixed(1)} mm`;
  els.humidity.textContent=observed && Number.isFinite(observation.humidity)
    ? `${Math.round(observation.humidity)}%`
    : (Number.isFinite(c.humidity)?`${Math.round(c.humidity)}%`:'—');

  if(els.observation){
    if(observed){
      const age=observation.ageMinutes<1 ? 'ahora' : `hace ${Math.round(observation.ageMinutes)} min`;
      els.observation.textContent=`📍 Observación SMN · ${observation.station.name} · ${age} · ${observation.station.distanceKm.toFixed(1)} km`;
      els.observation.classList.remove('fallback');
    }else{
      els.observation.textContent='🔮 Temperatura actual estimada por modelos · sin observación SMN reciente';
      els.observation.classList.add('fallback');
    }
  }
  els.lat.textContent=position.coords.latitude.toFixed(6);
  els.lon.textContent=position.coords.longitude.toFixed(6);
  els.accuracy.textContent=`${Math.round(position.coords.accuracy)} m`;

  if(c.split22){
    els.consensusTitle.textContent='Consenso dividido 2/2';
  }else if(c.count>=3){
    els.consensusTitle.textContent=`Consenso ${c.count} de ${c.total}`;
  }else if(c.count===2){
    els.consensusTitle.textContent=`Consenso parcial 2 de ${c.total}`;
  }else{
    els.consensusTitle.textContent='Sin consenso mayoritario';
  }

  const dispersion=c.overallRange;
  els.consensusSub.textContent=`${Math.round(c.temp)}° · confianza ${c.confidence} · dispersión ${dispersion}° · ${snaps.map(s=>s.name).join(' · ')}`;
  els.consensusBadge.classList.toggle('warn',c.confidence!=='alta');
  els.consensusBadge.classList.toggle('split',c.split22);

  renderModelDetails(snaps,c);
  renderHourly(items);
  renderDaily(items);

  const failed=Object.keys(MODELS).filter(k=>!items.some(x=>x.key===k));
  setMessage(failed.length
    ? `Conectados: ${items.map(x=>MODELS[x.key].name).join(', ')}. Sin respuesta: ${failed.map(k=>MODELS[k].name).join(', ')}.`
    : 'SMN, ECMWF, GFS e ICON conectados correctamente.');
}

function findOpenMeteoIndexByTime(data, targetTime){
  return currentIndex(data,targetTime);
}

function renderHourly(items){
  const smn=items.find(x=>x.key==='smn');
  const smnHours=smn?.data?.data || [];
  const fallback=items.find(x=>x.key!=='smn');
  const base=fallback?.data?.hourly;
  els.hourly.innerHTML='';

  for(let off=0;off<6;off++){
    const targetTime=smnHours[off]?.validTime || (base ? base.time[currentIndex(fallback.data)] : null);
    if(!targetTime) break;
    const vals=[];

    for(const item of items){
      if(item.key==='smn'){
        const d=smnHours[off];
        if(d && Number.isFinite(Number(d.temperature))) vals.push({temp:Number(d.temperature),precip:Number(d.precipitation??0),code:null});
      } else {
        const h=item.data.hourly;
        const j=findOpenMeteoIndexByTime(item.data,targetTime);
        vals.push({temp:Number(h.temperature_2m[j]),precip:Number(h.precipitation[j]??0),code:Number(h.weather_code[j])});
      }
    }
    if(!vals.length) continue;
    const groups=clusters(vals,1);
    const main=groups[0] || vals;
    const temp=main.reduce((s,x)=>s+x.temp,0)/main.length;
    const precip=main.reduce((s,x)=>s+x.precip,0)/main.length;
    const codeVals=main.filter(x=>Number.isFinite(x.code)).map(x=>x.code);
    const code=codeVals.length ? codeVals[Math.floor(codeVals.length/2)] : 0;
    const [ico]=weatherInfo(code);
    const el=document.createElement('div');
    el.className=`hour ${off===0?'now':''}`;
    el.innerHTML=`<div class="time">${off===0?'Ahora':fmtHour(targetTime)}</div><div class="icon">${ico}</div><div class="temp">${Math.round(temp)}°</div><div class="rain">💧 ${precip.toFixed(1)} mm</div>`;
    els.hourly.appendChild(el);
  }
}

function smnDailyMap(smn){
  const result=new Map();
  for(const d of (smn?.data?.data || [])){
    const day=d.validTime.slice(0,10);
    const temp=Number(d.temperature);
    if(!result.has(day)) result.set(day,{temps:[],precips:[],codes:[]});
    const x=result.get(day);
    if(Number.isFinite(temp)) x.temps.push(temp);
    if(Number.isFinite(Number(d.precipitation))) x.precips.push(Number(d.precipitation));
  }
  return result;
}

function renderDaily(items){
  const openItems=items.filter(x=>x.key!=='smn');
  const base=openItems[0]?.data.daily;
  const smn=items.find(x=>x.key==='smn');
  const smnDays=smnDailyMap(smn);
  els.daily.innerHTML='';
  if(!base) return;

  for(let i=0;i<Math.min(7,base.time.length);i++){
    const dayKey=base.time[i];
    const max=[],min=[],codes=[];
    for(const item of openItems){
      const d=item.data.daily;
      max.push(Number(d.temperature_2m_max[i])); min.push(Number(d.temperature_2m_min[i])); codes.push(Number(d.weather_code[i]));
    }

    const smnDay=smnDays.get(dayKey);
    if(smnDay?.temps?.length){
      max.push(Math.max(...smnDay.temps));
      min.push(Math.min(...smnDay.temps));
    }

    const maxGroups=clusters(max.map((temp,i)=>({key:i,temp})),1);
    const minGroups=clusters(min.map((temp,i)=>({key:i,temp})),1);
    const maxMain=maxGroups[0] || [];
    const minMain=minGroups[0] || [];
    const consensusMax=maxMain.length ? maxMain.reduce((s,x)=>s+x.temp,0)/maxMain.length : null;
    const consensusMin=minMain.length ? minMain.reduce((s,x)=>s+x.temp,0)/minMain.length : null;
    const code=codes.length ? codes[Math.floor(codes.length/2)] : 0;
    const [ico,desc]=weatherInfo(code);
    const modelCount=smnDay?.temps?.length ? items.length : openItems.length;
    const el=document.createElement('div');
    el.className='day';
    el.innerHTML=`<div class="name">${i===0?'Hoy':fmtDay(dayKey)}</div><div class="icon">${ico}</div><div class="desc">${desc} · ${modelCount} mod.</div><div class="max">${Math.round(consensusMax)}°</div><div class="min">${Math.round(consensusMin)}°</div>`;
    els.daily.appendChild(el);
  }
}

function showGpsError(error){
  els.status.textContent='GPS';
  setMessage({1:'Permiso de ubicación denegado. Habilitalo para este sitio.',2:'No fue posible determinar tu ubicación.',3:'La solicitud de ubicación tardó demasiado.'}[error.code]||'No se pudo obtener la ubicación.');
}

function getPosition(options){
  return new Promise((resolve,reject)=>{
    if(!navigator.geolocation){
      reject({code:2,message:'Geolocalización no disponible en este navegador.'});
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve,reject,options);
  });
}

async function getBestPosition(){
  // Android Chrome suele resolver antes la ubicación por red que el GPS puro.
  // Primero intentamos una ubicación rápida y suficientemente útil para una
  // grilla meteorológica de 4 km; si falla, hacemos un segundo intento con GPS.
  try{
    return await getPosition({
      enableHighAccuracy:false,
      timeout:10000,
      maximumAge:300000
    });
  }catch(firstError){
    if(firstError?.code===1) throw firstError;

    return await getPosition({
      enableHighAccuracy:true,
      timeout:30000,
      maximumAge:60000
    });
  }
}

async function loadWeather(){
  els.status.textContent='BUSCANDO';
  setMessage('Obteniendo ubicación…');

  try{
    const position=await getBestPosition();

    els.lat.textContent=position.coords.latitude.toFixed(6);
    els.lon.textContent=position.coords.longitude.toFixed(6);
    els.accuracy.textContent=`${Math.round(position.coords.accuracy)} m`;

    const lat=position.coords.latitude, lon=position.coords.longitude;
    let placeName='Mi ubicación';
    try{
      const place=await reverseGeocode(lat,lon);
      placeName=place.name || placeName;
      els.location.textContent=placeName;
    }catch(error){
      console.warn('Reverse geocoding:',error);
    }
    setMessage('Ubicación obtenida. Consultando observación SMN y modelos…');

    let observation=null;
    try{
      observation=await fetchNearestSMNObservation(lat,lon);
    }catch(error){
      console.warn('Observación SMN:',error);
    }

    const requests=[
      fetchOpenMeteo('ecmwf',lat,lon),
      fetchOpenMeteo('gfs',lat,lon),
      fetchOpenMeteo('icon',lat,lon),
      fetchSMN(lat,lon)
    ];
    const results=await Promise.allSettled(requests);
    const ok=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    if(!ok.length){
      els.status.textContent='ERROR';
      setMessage('Ningún modelo respondió. Revisá la conexión e intentá nuevamente.');
      return;
    }
    renderMain(ok,position,placeName,observation);
  }catch(error){
    showGpsError(error);
  }
}

els.retry.addEventListener('click',loadWeather);
function setDetails(open){
  els.modelDetails.classList.toggle('hidden', !open);
  els.consensusBadge.setAttribute('aria-expanded', String(open));
}
els.consensusBadge.addEventListener('click',()=>setDetails(els.modelDetails.classList.contains('hidden')));
els.closeDetails.addEventListener('click',()=>setDetails(false));
loadWeather();

// PWA: registro del Service Worker + instalación Android
let deferredInstallPrompt = null;
const installApp = document.getElementById('installApp');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=12').catch(err => console.warn('SW:', err));
  });
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installApp) installApp.classList.remove('hidden');
});

if (installApp) {
  installApp.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installApp.classList.add('hidden');
  });
}

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installApp) installApp.classList.add('hidden');
});

// ─────────────────────────────────────────────────────────────
// NOTIFICACIONES WEB PUSH
// ─────────────────────────────────────────────────────────────
const notificationEls = {
  section: document.getElementById('notifications'),
  status: document.getElementById('notificationStatus'),
  state: document.getElementById('notificationState'),
  button: document.getElementById('enableNotifications'),
  options: document.getElementById('notificationOptions'),
  smn: document.getElementById('alertsSmn'),
  storm: document.getElementById('alertsStorm'),
  daily: document.getElementById('dailySummary')
};
const PUSH_API = 'https://clima-consenso-smn.roxkleis.workers.dev';

function notificationSetStatus(text, enabled=false){
  if(notificationEls.status) notificationEls.status.textContent=text;
  if(notificationEls.state){
    notificationEls.state.textContent=enabled?'ON':'OFF';
    notificationEls.state.classList.toggle('on',enabled);
  }
}

async function getPushSubscription(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Este navegador no admite Web Push.');
  const registration=await navigator.serviceWorker.ready;
  let subscription=await registration.pushManager.getSubscription();
  if(subscription) return subscription;

  const config=await fetch(PUSH_API+'/push/config',{cache:'no-store'}).then(r=>{
    if(!r.ok) throw new Error('No se pudo obtener la configuración de notificaciones.');
    return r.json();
  });
  if(!config.publicKey) throw new Error('Falta la clave pública VAPID.');

  const permission=await Notification.requestPermission();
  if(permission!=='granted') throw new Error('Permiso de notificaciones no concedido.');

  subscription=await registration.pushManager.subscribe({
    userVisibleOnly:true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey)
  });
  return subscription;
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const raw=atob((base64String+padding).replace(/-/g,'+').replace(/_/g,'/'));
  const output=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) output[i]=raw.charCodeAt(i);
  return output;
}

async function savePushSubscription(){
  const subscription=await getPushSubscription();
  const json=subscription.toJSON();
  const position=await getBestPosition().catch(()=>null);
  const payload={
    endpoint:json.endpoint,
    keys:json.keys,
    lat:position?.coords?.latitude ?? null,
    lon:position?.coords?.longitude ?? null,
    alerts_smn:notificationEls.smn.checked,
    alerts_storm:notificationEls.storm.checked,
    daily_summary:notificationEls.daily.checked,
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Argentina/Buenos_Aires'
  };
  const r=await fetch(PUSH_API+'/push/subscribe',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || 'No se pudo registrar el dispositivo.');
  return subscription;
}

async function updatePushPreferences(){
  const subscription=await navigator.serviceWorker.ready.then(r=>r.pushManager.getSubscription());
  if(!subscription) return;
  const json=subscription.toJSON();
  const position=await getBestPosition().catch(()=>null);
  await fetch(PUSH_API+'/push/subscribe',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      endpoint:json.endpoint,
      keys:json.keys,
      lat:position?.coords?.latitude ?? null,
      lon:position?.coords?.longitude ?? null,
      alerts_smn:notificationEls.smn.checked,
      alerts_storm:notificationEls.storm.checked,
      daily_summary:notificationEls.daily.checked,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Argentina/Buenos_Aires'
    })
  });
}

async function initNotifications(){
  if(!notificationEls.button) return;
  if(!('Notification' in window) || !('PushManager' in window)){
    notificationSetStatus('Este navegador no admite notificaciones push.',false);
    notificationEls.button.disabled=true;
    return;
  }
  const permission=Notification.permission;
  const registration=await navigator.serviceWorker.ready;
  const subscription=await registration.pushManager.getSubscription();
  if(permission==='granted' && subscription){
    notificationSetStatus('Alertas activadas en este dispositivo.',true);
    notificationEls.options.classList.remove('hidden');
    notificationEls.button.textContent='🔔 Alertas activadas';
  }else if(permission==='denied'){
    notificationSetStatus('Las notificaciones están bloqueadas para este sitio. Habilitalas desde los permisos del navegador.',false);
  }
}

notificationEls.button?.addEventListener('click',async()=>{
  notificationEls.button.disabled=true;
  try{
    await savePushSubscription();
    notificationSetStatus('Alertas activadas en este dispositivo.',true);
    notificationEls.options.classList.remove('hidden');
    notificationEls.button.textContent='🔔 Alertas activadas';
  }catch(error){
    notificationSetStatus(error?.message || 'No se pudieron activar las notificaciones.',false);
  }finally{
    notificationEls.button.disabled=false;
  }
});

[notificationEls.smn,notificationEls.storm,notificationEls.daily].forEach(input=>{
  input?.addEventListener('change',()=>updatePushPreferences().catch(console.warn));
});

initNotifications().catch(console.warn);
