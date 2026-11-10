const CACHE = "clima-consenso-v9";
const ASSETS = ["./icons/icon.svg","./","./index.html","./styles.css?v=5","./observation-ui.css?v=1","./app.js?v=17","./observation-ui.js?v=1","./manifest.json?v=2"];

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
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

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

function cleanSmnNotification(data) {
  const rawTitle = String(data.title || "");
  const match = rawTitle.match(/^⚠️\s*Alerta SMN\s+(roja|naranja|amarilla):\s*(.+)$/i);
  if (!match) return data;

  const color = match[1].toLowerCase();
  const event = match[2].trim();
  let body = String(data.body || "").replace(/\s+/g, " ").trim();
  const headline = body.split(/\.\s+/)[0]?.trim() || "";
  if (headline && body.toLowerCase().startsWith(headline.toLowerCase())) {
    body = body.slice(headline.length).replace(/^\.?\s*/, "").trim();
  }

  return {
    ...data,
    title: `⚠️ SMN · Alerta ${color}`,
    body: event + (body ? ` · ${body}` : "")
  };
}

self.addEventListener("push", event => {
  let data = {title:"Clima by richardspulgar", body:"Nueva actualización meteorológica."};
  try {
    if(event.data) data = event.data.json();
  } catch (_) {}
  data = cleanSmnNotification(data);

  event.waitUntil(
    self.registration.showNotification(data.title || "Clima by richardspulgar", {
      body: data.body || "",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: data.tag || "clima-alerta",
      renotify: false,
      data: {url: data.url || "./"}
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./", self.registration.scope);
  if (url.origin === "https://www.smn.gob.ar" || url.origin === "https://ws2.smn.gob.ar") {
    event.waitUntil(clients.openWindow(url.href));
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
      const client = list.find(window => window.url.startsWith(self.registration.scope));
      return client ? client.focus() : clients.openWindow(url.href);
    })
  );
});
