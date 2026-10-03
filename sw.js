const CACHE = "clima-consenso-v4";
const ASSETS = ["./icons/icon.svg","./","./index.html","./styles.css?v=6","./app.js?v=13","./manifest.json?v=2"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.hostname === "api.open-meteo.com") return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});


self.addEventListener("push", event => {
  let data = {title:"Clima by richardspulgar", body:"Nueva actualización meteorológica."};
  try {
    if(event.data) data = event.data.json();
  } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(data.title || "Clima by richardspulgar", {
      body: data.body || "",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: data.tag || "clima-alerta",
      data: {url: data.url || "./"}
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification.data?.url || "./";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list => {
    for(const client of list){
      if("focus" in client){ client.navigate(target); return client.focus(); }
    }
    if(clients.openWindow) return clients.openWindow(target);
  }));
});
