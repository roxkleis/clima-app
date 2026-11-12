// Clima by richardspulgar · consensus engine v11 · observación SMN + consenso probabilístico
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
  todayMax:$('todayMax'),todayMin:$('todayMin'),
  hourly:$('hourly'),daily:$('daily'),lat:$('lat'),lon:$('lon'),accuracy:$('accuracy'),
  message:$('message'),retry:$('retry'),consensusBadge:$('consensusBadge'),
  consensusTitle:$('consensusTitle'),consensusSub:$('consensusSub'),modelDetails:$('modelDetails'),
  modelCards:$('modelCards'),closeDetails:$('closeDetails')
};

const weatherMap = {
  0:["sunny","Despejado"],1:["mostly_sunny","Principalmente despejado"],2:["partly_cloudy","Parcialmente nublado"],3:["cloudy","Nublado"],
  45:["cloudy","Niebla"],48:["cloudy","Niebla"],51:["drizzle","Llovizna ligera"],53:["drizzle","Llovizna"],
  55:["drizzle","Llovizna intensa"],56:["wintry_mix","Llovizna helada"],57:["wintry_mix","Llovizna helada intensa"],
  61:["scattered_showers","Lluvia ligera"],63:["showers","Lluvia"],65:["heavy","Lluvia intensa"],66:["wintry_mix","Lluvia helada"],
  67:["wintry_mix","Lluvia helada intensa"],71:["flurries","Nieve ligera"],73:["snow_showers","Nieve"],75:["heavy_snow","Nieve intensa"],
  77:["sleet_hail","Granizo de nieve"],80:["scattered_showers","Chaparrones ligeros"],81:["showers","Chaparrones"],
  82:["heavy","Chaparrones intensos"],85:["scattered_snow","Nieve"],86:["heavy_snow","Nieve intensa"],
  95:["isolated_tstorms","Tormenta"],96:["strong_tstorms","Tormenta con granizo"],99:["strong_tstorms","Tormenta fuerte"]
};
const weatherInfo = code => weatherMap[code] || ["partly_cloudy","Condición variable"];
const nightIcons = { sunny:"clear", mostly_sunny:"mostly_clear", partly_cloudy:"partly_clear" };
const weatherIconSrc = icon => `./icons/weather/${icon}_dark.svg`;

// Iconografía adaptada al ciclo solar real de la ubicación.
// De noche, los estados despejados/parcialmente despejados usan luna
// en lugar de sol; lluvia, nieve, niebla y tormenta mantienen sus iconos.
function isNightTime(date,lat,lon){
  if(!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) return date.getHours() < 7 || date.getHours() >= 19;

  const dayOfYear = Math.floor((Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()) - Date.UTC(date.getFullYear(),0,0)) / 86400000);
  const gamma = 2*Math.PI/365 * (dayOfYear - 1 + (date.getHours() - 12)/24);
  const eqtime = 229.18 * (
    0.000075 + 0.001868*Math.cos(gamma) - 0.032077*Math.sin(gamma)
    - 0.014615*Math.cos(2*gamma) - 0.040849*Math.sin(2*gamma)
  );
  const decl = 0.006918 - 0.399912*Math.cos(gamma) + 0.070257*Math.sin(gamma)
    - 0.006758*Math.cos(2*gamma) + 0.000907*Math.sin(2*gamma)
    - 0.002697*Math.cos(3*gamma) + 0.00148*Math.sin(3*gamma);
  const zenith = 90.833 * Math.PI/180;
  const latRad = lat * Math.PI/180;
  const cosHour = (Math.cos(zenith) / (Math.cos(latRad)*Math.cos(decl))) - Math.tan(latRad)*Math.tan(decl);

  // Polar day/night: si no hay amanecer/atardecer calculable, usamos
  // la elevación solar aproximada como respaldo horario.
  if(cosHour > 1 || cosHour < -1) return date.getHours() < 7 || date.getHours() >= 19;

  const hourAngle = Math.acos(cosHour) * 180/Math.PI;
  const sunriseUTC = 720 - 4*(lon + hourAngle) - eqtime;
  const sunsetUTC = 720 - 4*(lon - hourAngle) - eqtime;
  const offsetMinutes = -date.getTimezoneOffset();
  const minutesUTC = date.getUTCHours()*60 + date.getUTCMinutes() + date.getUTCSeconds()/60;
  const sunriseLocal = (sunriseUTC + offsetMinutes + 1440) % 1440;
  const sunsetLocal = (sunsetUTC + offsetMinutes + 1440) % 1440;
  const localMinutes = date.getHours()*60 + date.getMinutes() + date.getSeconds()/60;

  return localMinutes < sunriseLocal || localMinutes >= sunsetLocal;
}

function weatherInfoAtTime(code,date,lat,lon){
  const [icon,desc] = weatherInfo(code);
  return [isNightTime(date,lat,lon) ? (nightIcons[icon] || icon) : icon, desc];
}

const fmtHour = iso => new Intl.DateTimeFormat('es-AR',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
const fmtDay = iso => new Intl.DateTimeFormat('es-AR',{weekday:'short',day:'2-digit'}).format(new Date(`${iso}T12:00:00`)).replace('.','');
const setMessage = text => els.message.textContent = text;
const formatTemperature = temp => Number.isFinite(temp) ? `${Math.round(temp)}°` : '—';
const LOCAL_WEATHER_ACCURACY = 4000;
const LOCATION_KEY = 'clima-selected-location';

function readSelectedLocation(){
  try{
    const place=JSON.parse(localStorage.getItem(LOCATION_KEY));
    if(typeof place?.name==='string' && Number.isFinite(place.latitude) && Math.abs(place.latitude)<=90 &&
       Number.isFinite(place.longitude) && Math.abs(place.longitude)<=180) return place;
  }catch(_){}
  return null;
}

let selectedLocation=readSelectedLocation();

function selectLocation(place){
  selectedLocation=place;
  try{
    if(place) localStorage.setItem(LOCATION_KEY,JSON.stringify(place));
    else localStorage.removeItem(LOCATION_KEY);
  }catch(_){}
  $('locationDialog').close();
  loadWeather();
}

let locationSearchId=0;
$('changeLocation').addEventListener('click',()=>{
  locationSearchId++;
  $('locationFeedback').textContent='';
  $('locationResults').replaceChildren();
  $('locationDialog').showModal();
});
$('closeLocation').addEventListener('click',()=>$('locationDialog').close());
$('useAutomaticLocation').addEventListener('click',()=>selectLocation(null));
$('locationSearch').addEventListener('submit',async event=>{
  event.preventDefault();
  const searchId=++locationSearchId;
  const results=$('locationResults');
  const feedback=$('locationFeedback');
  const name=$('cityQuery').value.trim();
  results.replaceChildren();
  if(name.length<2){
    feedback.textContent='Ingresá al menos dos caracteres.';
    return;
  }
  feedback.textContent='Buscando ciudades…';
  try{
    const query=new URLSearchParams({name,language:'es',count:10});
    const data=await fetchJsonWithTimeout('https://geocoding-api.open-meteo.com/v1/search?'+query);
    if(searchId!==locationSearchId || !$('locationDialog').open) return;
    for(const {name,admin1,admin2,country,latitude,longitude} of data.results ?? []){
      if(!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const item=document.createElement('li');
      const button=document.createElement('button');
      button.type='button';
      button.textContent=[...new Set([name,admin2,admin1,country].filter(Boolean))].join(', ');
      const label=[...new Set([name,admin1,country].filter(Boolean))].join(', ');
      button.addEventListener('click',()=>selectLocation({name:label,latitude,longitude}));
      item.appendChild(button);
      results.appendChild(item);
    }
    feedback.textContent=results.childElementCount ? 'Elegí tu ciudad en los resultados.' : 'No encontramos esa ciudad.';
  }catch(_){
    if(searchId===locationSearchId && $('locationDialog').open) feedback.textContent='No pudimos buscar ciudades. Intentá de nuevo.';
  }
});

async function fetchJsonWithTimeout(url,timeout=10000){
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(timeout)});
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function reverseGeocode(lat,lon){
  const key=`clima-location-${lat.toFixed(3)}-${lon.toFixed(3)}`;
  try{
    const cached=sessionStorage.getItem(key);
    if(cached) return JSON.parse(cached);
  }catch(_){}

  const url=`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=es`;
  const data=await fetchJsonWithTimeout(url);

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

const SMN_OBS_PROXY='https://clima-consenso-smn.roxkleis.workers.dev/observation';

async function fetchNearestSMNObservation(lat,lon){
  const url=`${SMN_OBS_PROXY}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const data=await fetchJsonWithTimeout(url,15000);
  if(!data?.ok || !data.observation) throw new Error(data?.error || 'SMN sin observación');
  return data.observation.station?.distanceKm <= 50 ? data.observation : null;
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

function observationWeatherInfo(observation,lat,lon){
  if(!observation) return null;
  const cloud=observation.cloudCover == null ? NaN : Number(observation.cloudCover);
  const observationDate=new Date(observation.time || Date.now());
  const night=isNightTime(observationDate,lat,lon);
  if(Number.isFinite(cloud)){
    if(cloud <= 10) return [night ? "clear" : "sunny","Despejado"];
    if(cloud <= 50) return [night ? "partly_clear" : "partly_cloudy","Parcialmente nublado"];
    if(cloud <= 85) return [night ? "mostly_cloudy_night" : "mostly_cloudy","Nublado"];
    return ["cloudy","Cubierto"];
  }
  const text=String(observation.presentWeather||'').toLowerCase();
  if(text.includes('thunder') || text.includes('torment')) return weatherInfo(95);
  if(text.includes('rain') || text.includes('lluv')) return weatherInfo(63);
  if(text.includes('drizzle') || text.includes('lloviz')) return weatherInfo(53);
  if(text.includes('fog') || text.includes('niebla')) return weatherInfo(45);
  return null;
}

function renderMain(items,position,placeName=null,observation=null){
  const smn=items.find(x=>x.key==='smn');
  const targetIso=smn?.data?.data?.[0]?.validTime || null;
  const snaps=items.map(x=>currentSnapshot(x,targetIso));
  const c=consensusFor(snaps);
  const lat=position.coords.latitude;
  const lon=position.coords.longitude;
  const currentDate=new Date(observation?.time || targetIso || Date.now());
  const observedCondition=observationWeatherInfo(observation,lat,lon);
  const [icon,condition]=observedCondition || weatherInfoAtTime(consensusWeatherCode(snaps),currentDate,lat,lon);

  els.location.textContent=placeName || 'Mi ubicación';
  els.updated.textContent=`Actualizado ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}`;
  if(position.coords.accuracy>LOCAL_WEATHER_ACCURACY) els.updated.textContent+=' · Ubicación aproximada';
  els.status.textContent=`${items.length} MODELOS OK`;
  els.icon.src=weatherIconSrc(icon);
  els.condition.textContent=condition;
  // AHORA: observación meteorológica real de la estación SMN más cercana.
  // Si no hay una observación reciente, se conserva el consenso como fallback.
  const observed=observation && Number.isFinite(observation.temp);
  els.temperature.textContent=observed ? Math.round(observation.temp) : (Number.isFinite(c.temp)?Math.round(c.temp):'—');
  els.apparent.textContent=observed
    ? Math.round(apparentSMN(observation.temp,observation.humidity,observation.windSpeed) ?? observation.temp)
    : (Number.isFinite(c.apparent)?Math.round(c.apparent):'—');
  els.rain.textContent=`${c.precipitation.toFixed(1)} mm`;
  els.humidity.textContent=observed && Number.isFinite(observation.humidity)
    ? `${Math.round(observation.humidity)}%`
    : (Number.isFinite(c.humidity)?`${Math.round(c.humidity)}%`:'—');

  if(els.observation){
    if(observed){
      const observationTime=new Date(observation.time);
      const clock=Number.isNaN(observationTime.getTime())
        ? ''
        : observationTime.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
      const age=observation.ageMinutes<1 ? 'ahora' : `hace ${Math.round(observation.ageMinutes)} min`;
      els.observation.textContent=`📍 Observación SMN · ${observation.station.name} · ${clock} · ${age} · ${observation.station.distanceKm.toFixed(1)} km`;
      els.observation.classList.remove('fallback');
    }else{
      els.observation.textContent='🔮 Temperatura actual estimada por modelos · sin observación SMN reciente';
      els.observation.classList.add('fallback');
    }
  }
  els.lat.textContent=position.coords.latitude.toFixed(6);
  els.lon.textContent=position.coords.longitude.toFixed(6);
  els.accuracy.textContent=position.coords.accuracy==null ? 'Ubicación elegida' : `${Math.round(position.coords.accuracy)} m`;

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
  els.consensusSub.textContent=`Pronóstico · ${Math.round(c.temp)}° · confianza ${c.confidence} · dispersión ${dispersion}° · ${snaps.map(s=>s.name).join(' · ')}`;
  els.consensusBadge.classList.toggle('warn',c.confidence!=='alta');
  els.consensusBadge.classList.toggle('split',c.split22);

  renderModelDetails(snaps,c);
  renderHourly(items,lat,lon);
  renderDaily(items,lat,lon);

  const failed=Object.keys(MODELS).filter(k=>!items.some(x=>x.key===k));
  setMessage(failed.length
    ? `Conectados: ${items.map(x=>MODELS[x.key].name).join(', ')}. Sin respuesta: ${failed.map(k=>MODELS[k].name).join(', ')}.`
    : 'SMN, ECMWF, GFS e ICON conectados correctamente.');
}

function findOpenMeteoIndexByTime(data, targetTime){
  return currentIndex(data,targetTime);
}

function renderHourly(items,lat=null,lon=null){
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
    const hourlySnaps=vals.map((x,i)=>({...x,key:String(i),name:items[i]?.key ? MODELS[items[i].key]?.name || String(i) : String(i)}));
    const hc=consensusFor(hourlySnaps);
    const temp=hc.temp;
    const main=hc.main.length>=2 ? hc.main : hourlySnaps;
    const precipVals=main.map(x=>x.precip).filter(Number.isFinite);
    const precip=hc.main.length>=2
      ? (precipVals.length ? precipVals.reduce((s,x)=>s+x,0)/precipVals.length : 0)
      : (precipVals.length ? median(precipVals) : 0);
    const codeVals=main.filter(x=>Number.isFinite(x.code)).map(x=>x.code);
    const code=codeVals.length ? codeVals[Math.floor(codeVals.length/2)] : 0;
    const [ico,desc]=weatherInfoAtTime(code,new Date(targetTime),lat,lon);
    const el=document.createElement('div');
    el.className=`hour ${off===0?'now':''}`;
    el.innerHTML=`<div class="time">${off===0?'Ahora':fmtHour(targetTime)}</div><img class="icon" src="${weatherIconSrc(ico)}" alt="${desc}"><div class="temp">${Math.round(temp)}°</div><div class="rain">💧 ${precip.toFixed(1)} mm</div>`;
    els.hourly.appendChild(el);
  }
}

function smnDailyMap(smn,timezone){
  const result=new Map();
  const dateAtLocation=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  for(const d of (smn?.data?.data || [])){
    const date=new Date(d.validTime);
    if(Number.isNaN(date.getTime())) continue;
    const day=dateAtLocation.format(date);
    const temp=d.temperature;
    if(!result.has(day)) result.set(day,{temps:[],precips:[],codes:[]});
    const x=result.get(day);
    if(Number.isFinite(temp)) x.temps.push(temp);
    if(Number.isFinite(Number(d.precipitation))) x.precips.push(Number(d.precipitation));
  }
  return result;
}

function renderDaily(items,lat=null,lon=null){
  const openItems=items.filter(x=>x.key!=='smn' && x.data.daily?.time?.length);
  const base=openItems[0]?.data.daily;
  const smn=items.find(x=>x.key==='smn');
  els.daily.innerHTML='';
  els.todayMax.textContent='—';
  els.todayMin.textContent='—';
  if(!base) return;
  const smnDays=smnDailyMap(smn,openItems[0].data.timezone || 'UTC');

  for(let i=0;i<Math.min(7,base.time.length);i++){
    const dayKey=base.time[i];
    const max=[],min=[],codes=[];
    for(const item of openItems){
      const d=item.data.daily;
      const dayIndex=d.time.indexOf(dayKey);
      if(dayIndex<0) continue;
      max.push(d.temperature_2m_max?.[dayIndex]);
      min.push(d.temperature_2m_min?.[dayIndex]);
      codes.push(d.weather_code?.[dayIndex]);
    }

    const smnDay=smnDays.get(dayKey);
    // Los extremos de hoy necesitan el día completo, no solo las horas restantes del WRF.
    const hasSmn=smnDay?.temps.length >= (i===0 ? 24 : 1);
    if(hasSmn){
      max.push(Math.max(...smnDay.temps));
      min.push(Math.min(...smnDay.temps));
    }

    const maxConsensus=consensusFor(max.map((temp,i)=>({key:String(i),name:String(i),temp})));
    const minConsensus=consensusFor(min.map((temp,i)=>({key:String(i),name:String(i),temp})));
    const consensusMax=maxConsensus.temp;
    const consensusMin=minConsensus.temp;
    if(i===0){
      els.todayMax.textContent=formatTemperature(consensusMax);
      els.todayMin.textContent=formatTemperature(consensusMin);
    }
    const code=codes.length ? codes[Math.floor(codes.length/2)] : 0;
    // El resumen diario representa principalmente las horas diurnas,
    // por eso conserva la iconografía solar de cada condición.
    const [ico,desc]=weatherInfo(code);
    const modelCount=openItems.length + Number(hasSmn);
    const el=document.createElement('div');
    el.className='day';
    el.innerHTML=`<div class="name">${i===0?'Hoy':fmtDay(dayKey)}</div><img class="icon" src="${weatherIconSrc(ico)}" alt="${desc}"><div class="desc">${desc} · ${modelCount} mod.</div><div class="max">${formatTemperature(consensusMax)}</div><div class="min">${formatTemperature(consensusMin)}</div>`;
    els.daily.appendChild(el);
  }
}

function showGpsError(error){
  els.status.textContent='GPS';
  els.location.textContent='Ubicación sin confirmar';
  els.updated.textContent='Elegí tu ciudad en Cambiar ubicación.';
  setMessage({1:'Permiso de ubicación denegado.',2:'No fue posible determinar tu ubicación.',3:'La solicitud de ubicación tardó demasiado.'}[error.code]||'No se pudo obtener la ubicación.');
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
  let estimate;
  try{
    estimate=await getPosition({
      enableHighAccuracy:false,
      timeout:10000,
      maximumAge:0
    });
  }catch(firstError){
    if(firstError?.code===1) throw firstError;
  }
  if(estimate?.coords.accuracy<=LOCAL_WEATHER_ACCURACY) return estimate;
  try{
    const precise=await getPosition({
      enableHighAccuracy:true,
      timeout:12000,
      maximumAge:0
    });
    return !estimate || precise.coords.accuracy<estimate.coords.accuracy ? precise : estimate;
  }catch(error){
    if(estimate) return estimate;
    throw error;
  }
}

let weatherRequestId=0;
async function loadWeather(){
  const requestId=++weatherRequestId;
  const place=selectedLocation;
  els.status.textContent='BUSCANDO';
  setMessage('Obteniendo ubicación…');

  let position;
  try{
    position=place ? {coords:{latitude:place.latitude,longitude:place.longitude,accuracy:null}} : await getBestPosition();
  }catch(error){
    if(requestId===weatherRequestId) showGpsError(error);
    return;
  }
  if(requestId!==weatherRequestId) return;
  const {latitude:lat,longitude:lon}=position.coords;
  setMessage('Consultando observación SMN y modelos…');

  const [location,observation,results]=await Promise.all([
    place || reverseGeocode(lat,lon).catch(()=>null),
    fetchNearestSMNObservation(lat,lon).catch(()=>null),
    Promise.allSettled([
      fetchOpenMeteo('ecmwf',lat,lon),fetchOpenMeteo('gfs',lat,lon),
      fetchOpenMeteo('icon',lat,lon),fetchSMN(lat,lon)
    ])
  ]);
  if(requestId!==weatherRequestId) return;
  const models=results.filter(result=>result.status==='fulfilled').map(result=>result.value);
  if(!models.length){
    els.status.textContent='ERROR';
    els.updated.textContent='No se pudo actualizar el pronóstico.';
    setMessage('Ningún modelo respondió. Revisá la conexión e intentá nuevamente.');
    return;
  }
  renderMain(models,position,location?.name,observation);
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
    navigator.serviceWorker.register('./sw.js?v=19').catch(err => console.warn('SW:', err));
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
  test: document.getElementById('testNotification'),
  options: document.getElementById('notificationOptions'),
  smn: document.getElementById('alertsSmn'),
  storm: document.getElementById('alertsStorm'),
  daily: document.getElementById('dailySummary'),
  night: document.getElementById('nightSummary')
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

async function pushRequest(path, payload) {
  const response = await fetch(PUSH_API + "/push/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const data=path==="test" ? await response.json().catch(()=>null) : null;
    throw Object.assign(new Error(data?.error || "No se pudieron guardar o consultar tus avisos."), {status:response.status});
  }
  return response.json();
}

const preferenceInputs = {
  alerts_smn: notificationEls.smn,
  alerts_storm: notificationEls.storm,
  daily_summary: notificationEls.daily,
  night_minimum: notificationEls.night
};
let activeSubscription;
let savedPreferences;

function displayPreferences(preferences) {
  for (const [key, input] of Object.entries(preferenceInputs)) input.checked = Boolean(preferences[key]);
}

async function savePushSubscription(subscription, position = null) {
  const preferences = Object.fromEntries(Object.entries(preferenceInputs).map(([key, input]) => [key, input.checked]));
  await pushRequest("subscribe", {
    ...subscription.toJSON(),
    lat: position?.coords?.latitude ?? null,
    lon: position?.coords?.longitude ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...preferences
  });
  savedPreferences = preferences;
}

function showActiveSubscription(subscription) {
  activeSubscription = subscription;
  notificationSetStatus("Avisos activos en este dispositivo · hora argentina.", true);
  notificationEls.options.classList.remove("hidden");
  notificationEls.button.textContent = "🔔 Actualizar registro";
}

async function initNotifications() {
  if (!notificationEls.button) return;
  if (!("Notification" in window) || !("PushManager" in window)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    notificationSetStatus(ios
      ? "En iPhone o iPad, agregá la app a la pantalla de inicio y abrila desde ahí."
      : "Este navegador no admite notificaciones push.");
    notificationEls.button.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    notificationSetStatus("Las notificaciones están bloqueadas. Habilitalas desde los permisos del navegador.");
    return;
  }
  if (Notification.permission !== "granted") return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const { preferences } = await pushRequest("preferences", subscription.toJSON());
  if (!preferences) return;
  savedPreferences = preferences;
  displayPreferences(preferences);
  showActiveSubscription(subscription);
}

notificationEls.button?.addEventListener("click", async () => {
  notificationEls.button.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Permiso de notificaciones no concedido.");
    const subscription = await getPushSubscription();
    const position = notificationEls.storm.checked ? await getBestPosition().catch(() => null) : null;
    await savePushSubscription(subscription, position);
    showActiveSubscription(subscription);
  } catch (error) {
    notificationSetStatus(error.message, Boolean(activeSubscription));
  } finally {
    notificationEls.button.disabled = false;
  }
});

for (const input of Object.values(preferenceInputs)) {
  input?.addEventListener("change", async () => {
    if (!activeSubscription) return;
    notificationEls.button.disabled = true;
    for (const option of Object.values(preferenceInputs)) option.disabled = true;
    try {
      const position = input === notificationEls.storm && input.checked ? await getBestPosition().catch(() => null) : null;
      await savePushSubscription(activeSubscription, position);
      showActiveSubscription(activeSubscription);
    } catch (error) {
      displayPreferences(savedPreferences);
      notificationSetStatus(error.message, true);
    } finally {
      for (const option of Object.values(preferenceInputs)) option.disabled = false;
      notificationEls.button.disabled = false;
    }
  });
}

notificationEls.test?.addEventListener("click", async () => {
  if (!activeSubscription) return;
  notificationEls.test.disabled=true;
  try {
    await pushRequest("test",activeSubscription.toJSON());
    notificationSetStatus("Prueba enviada. Revisá las notificaciones de este dispositivo.",true);
  } catch(error) {
    if (error.status===410) {
      await activeSubscription.unsubscribe().catch(()=>{});
      activeSubscription=null;
      notificationEls.options.classList.add("hidden");
      notificationEls.button.textContent="🔔 Activar avisos";
    }
    notificationSetStatus(error.message,Boolean(activeSubscription));
  } finally {
    notificationEls.test.disabled=false;
  }
});

initNotifications().catch(error => notificationSetStatus(error.message));
