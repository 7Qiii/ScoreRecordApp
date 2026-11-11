const CACHE_NAME = "exam-tracker-vue-cache-v4";
// 图标一并预缓存：装到桌面后即使离线，主屏幕图标也要能正常显示
const ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png"
];

/**
 * 只有 /assets/ 下的东西可以走 cache-first。
 *
 * Vite 给这些文件名带了内容 hash（index-BaI_D3fS.js），内容变了名字就变，
 * 所以「缓存里的一定是对的」。图标、manifest 的名字是固定的，重新生成后
 * URL 不变 —— 对它们做 cache-first 会一直发旧的，所以照旧走 network-first。
 */
function isImmutable(url) {
  return url.pathname.startsWith("/assets/");
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => (key === CACHE_NAME ? undefined : caches.delete(key))))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // 只管自己家的请求。
  //
  // 以前不过滤 origin，Supabase / R2 的跨域响应也会被塞进 Cache Storage ——
  // 既白占空间，又让「缓存里到底存了什么」变得没法预期。跨域请求直接放行走网络。
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (isImmutable(url)) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  // 其余（HTML、图标、manifest）保持 network-first：保证能拿到新版，
  // 断网时再回落到缓存。注意只有 200 才写缓存，免得把 404 也存进去。
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("/");
        return Response.error();
      })
  );
});
