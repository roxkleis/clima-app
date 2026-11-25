const CACHE_PREFIX = "clima-consenso-v";
const CACHE = `${CACHE_PREFIX}26`;
const WEATHER_ICONS = [
  "clear", "cloudy", "drizzle", "flurries", "heavy", "heavy_snow", "isolated_tstorms",
  "mostly_clear", "mostly_cloudy", "mostly_cloudy_night", "mostly_sunny", "partly_clear",
  "partly_cloudy", "scattered_showers", "scattered_snow", "showers", "sleet_hail",
  "snow_showers", "strong_tstorms", "sunny", "wintry_mix"
];
const ASSETS = [
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
  "./", "./index.html", "./styles.css?v=14", "./observation-ui.css?v=1", "./gemini-ui.css?v=2",
  "./atmosphere.css?v=1", "./app.js?v=33", "./observation-ui.js?v=1", "./gemini-ui.js?v=5", "./manifest.json?v=3",
  ...WEATHER_ICONS.map(icon => `./icons/weather/${icon}_dark.svg`)
];
const APP_URL = new URL("./", self.registration.scope);
const INDEX_URL = new URL("./index.html", APP_URL);
const CACHEABLE_URLS = new Set(ASSETS.map(asset => new URL(asset, APP_URL).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== APP_URL.origin) return;
  const appNavigation = event.request.mode === "navigate" &&
    (url.pathname === APP_URL.pathname || url.pathname === INDEX_URL.pathname);
  if (!appNavigation && !CACHEABLE_URLS.has(url.href)) return;
  const key = appNavigation ? APP_URL.href : url.href;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE).catch(() => null);
    try {
      const response = await fetch(event.request);
      if (response.ok && cache) await cache.put(key, response.clone()).catch(() => {});
      if (response.status >= 500 && cache) return await cache.match(key) || response;
      return response;
    } catch {
      return (await cache?.match(key)) || Response.error();
    }
  })());
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
