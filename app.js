const locationEl = document.getElementById("location");
const coordsEl = document.getElementById("coords");
const latEl = document.getElementById("lat");
const lonEl = document.getElementById("lon");
const accuracyEl = document.getElementById("accuracy");
const messageEl = document.getElementById("message");
const statusEl = document.getElementById("status");
const retryBtn = document.getElementById("retry");

function setMessage(text) {
  messageEl.textContent = text;
}

function showPosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  latEl.textContent = latitude.toFixed(6);
  lonEl.textContent = longitude.toFixed(6);
  accuracyEl.textContent = `${Math.round(accuracy)} m`;
  coordsEl.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  locationEl.textContent = "Ubicación detectada";
  statusEl.textContent = "GPS OK";
  setMessage("GPS obtenido correctamente. En el siguiente paso conectaremos los datos meteorológicos.");
}

function showError(error) {
  statusEl.textContent = "GPS";
  const messages = {
    1: "Permiso de ubicación denegado. Habilitalo para esta PWA desde los permisos del navegador.",
    2: "No fue posible determinar la ubicación. Probá nuevamente.",
    3: "La solicitud de ubicación tardó demasiado. Probá nuevamente."
  };
  setMessage(messages[error.code] || "No se pudo obtener la ubicación.");
}

function getLocation() {
  if (!("geolocation" in navigator)) {
    setMessage("Este navegador no admite geolocalización.");
    return;
  }
  statusEl.textContent = "BUSCANDO";
  setMessage("Solicitando ubicación al teléfono…");
  navigator.geolocation.getCurrentPosition(showPosition, showError, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 300000
  });
}

retryBtn.addEventListener("click", getLocation);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

getLocation();
