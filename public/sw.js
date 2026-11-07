// 简易 Service Worker（PRD-04 §3.6）
//
// 原则：
// - 只缓存静态资源（HTML/CSS/JS/图标/manifest）
// - **绝不缓存** Socket.IO 请求（/socket.io/ 一律走网络）
// - 版本号 + skipWaiting，避免更新不生效

const CACHE_NAME = 'poker-v1.4.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './client.js',
  './sound.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(() => {
        // 单个资源失败不应阻塞安装
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 只处理同源 GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Socket.IO（含 WebSocket 升级、轮询）绝不缓存
  if (url.pathname.startsWith('/socket.io/')) return;

  // 静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);

      return cached || network;
    })
  );
});
