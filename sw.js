/* ============================================================
 * sw.js — Service Worker (PWA 离线缓存)
 * 策略: 安装时预缓存应用壳; 运行时同源资源"缓存优先",
 *       跨域 CDN 资源"网络优先、失败回退缓存"(stale-while-revalidate)。
 * 注意: API 请求(USGS/Open-Meteo/RainViewer 等)不做缓存,
 *       保证灾害数据始终是实时抓取。
 * ============================================================ */

const CACHE_NAME = 'trail-sense-v21'; // 图层控件弹出式 + PDF 卡片页重排, bump 强制更新 // 浅色对比度/移动端/去持久化/PDF重排, bump 强制更新 // tempBasemap 作用域修复 + 按需加载报告库 + HSTS // 报告库按需加载 + areTilesLoaded 等待 + HSTS // PDF 地图截图: 隐藏无CORS图层+等idle // CSP data:/s3 + PDF 地图 CORS 切换 // 跨域放行 + 3D 本地导入 + 主题/英文/地形, bump 强制更新 // 3D 依赖本地 vendor 化 + 主题切换 + 默认英文/地形, bump 强制更新

/* 应用壳: 首次访问即离线可用所需的全部本地资源 */
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/i18n.js',
  './js/app.js',
  './js/3d.js',
  './js/geo.js',
  './js/hazards.js',
  './js/weather.js',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './vendor/turf.min.js',
  './vendor/chart.umd.min.js',
  './vendor/html2canvas.min.js',
  './vendor/jspdf.umd.min.js',
  './manifest.json',
  './icons/icon.svg'
];

/* ---------- 安装: 预缓存应用壳(单个失败不阻塞整体) ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url))
      ))
      .then(() => self.skipWaiting())
  );
});

/* ---------- 激活: 清理旧版本缓存 ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- 请求拦截 ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 仅处理 GET; 忽略浏览器扩展等非标准请求
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  // 灾害/气象 API 请求一律走网络(实时性要求高, 不做离线缓存)
  if (isSameOrigin === false && /(usgs\.gov|open-meteo\.com|rainviewer\.com|firms\.modaps|earthdata\.nasa\.gov)/.test(url.hostname)) {
    return; // 交给浏览器原生处理, 页面内已有超时降级逻辑
  }

  if (isSameOrigin) {
    // sw.js 自身永不缓存: 否则旧 SW 会一直给浏览器返回旧版 sw.js,
    // CACHE_NAME bump 也无法触发更新 (浏览器靠字节差异检测 SW 更新)
    if (url.pathname.endsWith('/sw.js')) return;

    // HTML 导航请求: 网络优先(每次拿最新页面), 网络失败才回退缓存 —
    // 否则旧 SW 缓存优先会一直给用户返回旧版 index.html(改版后看不到新功能)
    if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
      event.respondWith(
        fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            }
            return res;
          })
          .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
      );
      return;
    }

    // 同源应用壳(js/css/vendor 等): 缓存优先 → 网络兜底并回填缓存
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            // 仅缓存成功的同源资源
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            }
            return res;
          })
          .catch(() => caches.match('./index.html')); // 彻底离线时兜底首页
      })
    );
  } else {
    // 跨域请求(CDN 备用源/document.write 降级/地图瓦片/API): 直接放行,
    // 交给浏览器原生处理 — SW 不拦截跨域 fetch, 避免被 CSP connect-src 拦截报错,
    // 也不缓存跨域资源(核心库已本地 vendor 化, 无需离线跨域缓存)
    return;
  }
});
