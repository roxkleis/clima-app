const API = "https://api.open-meteo.com/v1/ecmwf";

const $ = (id) => document.getElementById(id);
const els = {
  location: $("location"), updated: $("updated"), status: $("status"),
  icon: $("weatherIcon"), condition: $("condition"),
  temperature: $("temperature"), apparent: $("apparent"),
  rain: $("rain"), humidity: $("humidity"),
  hourly: $("hourly"), daily: $("daily"),
  lat: $("lat"), lon: $("lon"), accuracy: $("accuracy"),
  message: $("message"), retry: $("retry")
};

const weatherMap = {
  0:["☀️","Despejado"], 1:["🌤️","Principalmente despejado"], 2:["⛅","Parcialmente nublado"],
  3:["☁️","Nublado"], 45:["🌫️","Niebla"], 48:["🌫️","Niebla"],
  51:["🌦️","Llovizna ligera"], 53:["🌦️","Llovizna"], 55:["🌧️","Llovizna intensa"],
  56:["🌧️","Llovizna helada"], 57:["🌧️","Llovizna helada intensa"],
  61:["🌦️","Lluvia ligera"], 63:["🌧️","Lluvia"], 65:["🌧️","Lluvia intensa"],
  66:["🌧️","Lluvia helada"], 67:["🌧️","Lluvia helada intensa"],
  71:["🌨️","Nieve ligera"], 73:["🌨️","Nieve"], 75:["❄️","Nieve intensa"],
  77:["🌨️","Granizo de nieve"], 80:["🌦️","Chaparrones ligeros"], 81:["🌧️","Chaparrones"],
  82:["⛈️","Chaparrones intensos"], 85:["🌨️","Nieve"], 86:["❄️","Nieve intensa"],
  95:["⛈️","Tormenta"], 96:["⛈️","Tormenta con granizo"], 99:["⛈️","Tormenta fuerte"]
};

function weatherInfo(code){ return weatherMap[code] || ["🌤️","Condición variable"]; }

function fmtHour(iso){
  return new Intl.DateTimeFormat("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false})
    .format(new Date(iso));
}

function fmtDay(iso){
  return new Intl.DateTimeFormat("es-AR",{weekday:"short",day:"2-digit"})
    .format(new Date(`${iso}T12:00:00`)).replace(".","");
}

function setMessage(text){ els.message.textContent = text; }

async function fetchECMWF(lat, lon){
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    timezone: "auto",
    forecast_days: "7"
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${API}?${params.toString()}`, {
      cache:"no-store",
      signal: controller.signal
    });

    if(!response.ok){
      const body = await response.text().catch(() => "");
      throw new Error(`ECMWF HTTP ${response.status}${body ? `: ${body.slice(0,180)}` : ""}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function renderWeather(data, position){
  if(!data?.hourly?.time?.length) throw new Error("ECMWF devolvió una respuesta sin datos horarios.");

  const h = data.hourly;
  const d = data.daily;

  els.location.textContent = "Mi ubicación";
  els.updated.textContent = `Actualizado ${fmtHour(h.time[0])}`;
  els.status.textContent = "ECMWF OK";

  els.lat.textContent = position.coords.latitude.toFixed(6);
  els.lon.textContent = position.coords.longitude.toFixed(6);
  els.accuracy.textContent = `${Math.round(position.coords.accuracy)} m`;

  const now = Date.now();
  let currentIndex = 0, best = Infinity;

  h.time.forEach((t,i)=>{
    const diff = Math.abs(new Date(t).getTime() - now);
    if(diff < best){ best=diff; currentIndex=i; }
  });

  const code = h.weather_code[currentIndex];
  const [icon, condition] = weatherInfo(code);

  els.icon.textContent = icon;
  els.condition.textContent = condition;
  els.temperature.textContent = Math.round(h.temperature_2m[currentIndex]);
  els.apparent.textContent = Math.round(h.apparent_temperature[currentIndex]);

  const currentPrecip = Number(h.precipitation[currentIndex] ?? 0);
  els.rain.textContent = `${currentPrecip.toFixed(1)} mm`;

  els.humidity.textContent = `${Math.round(h.relative_humidity_2m[currentIndex])}%`;

  els.hourly.innerHTML = "";
  for(let offset=0; offset<6; offset++){
    const i = currentIndex + offset;
    if(i >= h.time.length) break;

    const [ico] = weatherInfo(h.weather_code[i]);
    const precip = Number(h.precipitation[i] ?? 0);

    const el = document.createElement("div");
    el.className = `hour ${offset===0 ? "now" : ""}`;
    el.innerHTML = `
      <div class="time">${offset===0 ? "Ahora" : fmtHour(h.time[i])}</div>
      <div class="icon">${ico}</div>
      <div class="temp">${Math.round(h.temperature_2m[i])}°</div>
      <div class="rain">💧 ${precip.toFixed(1)} mm</div>`;
    els.hourly.appendChild(el);
  }

  els.daily.innerHTML = "";
  for(let i=0;i<Math.min(7,d.time.length);i++){
    const [ico, desc] = weatherInfo(d.weather_code[i]);
    const el = document.createElement("div");
    el.className = "day";
    el.innerHTML = `
      <div class="name">${i===0 ? "Hoy" : fmtDay(d.time[i])}</div>
      <div class="icon">${ico}</div>
      <div class="desc">${desc}</div>
      <div class="max">${Math.round(d.temperature_2m_max[i])}°</div>
      <div class="min">${Math.round(d.temperature_2m_min[i])}°</div>`;
    els.daily.appendChild(el);
  }

  setMessage("ECMWF IFS HRES conectado correctamente. Primera fuente meteorológica de Clima Consenso.");
}

function showGpsError(error){
  els.status.textContent = "GPS";
  const messages = {
    1:"Permiso de ubicación denegado. Habilitalo para este sitio.",
    2:"No fue posible determinar tu ubicación.",
    3:"La solicitud de ubicación tardó demasiado."
  };
  setMessage(messages[error.code] || "No se pudo obtener la ubicación.");
}

function loadWeather(){
  if(!navigator.geolocation){
    els.status.textContent = "ERROR";
    setMessage("Este navegador no admite geolocalización.");
    return;
  }

  els.status.textContent = "BUSCANDO";
  setMessage("Obteniendo ubicación y consultando ECMWF…");

  navigator.geolocation.getCurrentPosition(async (position)=>{
    els.lat.textContent = position.coords.latitude.toFixed(6);
    els.lon.textContent = position.coords.longitude.toFixed(6);
    els.accuracy.textContent = `${Math.round(position.coords.accuracy)} m`;

    try{
      const data = await fetchECMWF(position.coords.latitude, position.coords.longitude);
      renderWeather(data, position);
    }catch(error){
      console.error("Clima Consenso:", error);
      els.status.textContent = "ERROR";
      setMessage(
        error.name === "AbortError"
          ? "ECMWF tardó demasiado en responder. Tocá «Actualizar clima»."
          : `No se pudo consultar ECMWF. ${error.message}`
      );
    }
  }, showGpsError, {
    enableHighAccuracy:true,
    timeout:15000,
    maximumAge:300000
  });
}

els.retry.addEventListener("click", loadWeather);

// Service Worker temporarily disabled during development to avoid stale-cache issues.
loadWeather();
