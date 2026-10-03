const CACHE = "clima-consenso-v1-ecmwf";
const ASSETS = ["./","./index.html","./styles.css","./app.js","./manifest.json"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{
  // Never cache live Open-Meteo requests.
  if(event.request.url.includes("api.open-meteo.com")) return;
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
