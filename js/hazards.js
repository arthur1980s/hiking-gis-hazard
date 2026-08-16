/* ============================================================
 * hazards.js — 灾害碰撞检测引擎 (Hazard Intersection Engine)
 * 真实数据源:
 *   · 地震: USGS Earthquake API (过去 48 小时, 震级≥2.5, 半径 200km)
 *   · 山火: NASA FIRMS (需 API Key; 2026-08 起 NASA 移除 GIBS 栅格瓦片,
 *           FIRMS 点数据为唯一数据源)
 * 所有网络请求带 8s 超时 (AbortController), 失败自动优雅降级,
 * 绝不让页面卡死; 降级时返回 status 标记, 由 UI 显示提示。
 * 依赖: TrailGeo (geo.js)
 * 注意: 所有 fetch 均带超时, 失败降级为文字提示, 不影响页面。
 * ============================================================ */

/* NASA FIRMS API Key (后台固化, 无需用户配置; 申请地址: https://firms.modaps.eosdis.nasa.gov/api/map_key/) */
const FIRMS_MAP_KEY = '6550b7fd1f2f6dbbd391559e296ca868';

const Hazards = (function () {
  'use strict';

  const TIMEOUT_MS = 8000; // 统一 8 秒超时

  /* ---------- 带超时的 fetch: 超时/网络错误统一抛出 ---------- */
  async function fetchTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /* 返回固化的 FIRMS Key(直接使用后台 Key, 不再依赖 localStorage) */
  function getFirmsKey() {
    return FIRMS_MAP_KEY;
  }

  /* ============================================================
   * 1. 地震: USGS 过去 48 小时, minmagnitude=2.5, 半径 200km
   * ============================================================ */
  async function fetchQuakes(lat, lon) {
    const end = new Date();
    const start = new Date(end.getTime() - 48 * 3600 * 1000); // 48 小时前
    const iso = (d) => d.toISOString().slice(0, 19); // 截断到秒
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query'
      + '?format=geojson'
      + '&starttime=' + iso(start)
      + '&endtime=' + iso(end)
      + '&minmagnitude=2.5'
      + '&latitude=' + lat
      + '&longitude=' + lon
      + '&maxradiuskm=200'
      + '&orderby=time';

    try {
      const res = await fetchTimeout(url);
      const json = await res.json();
      const items = (json.features || []).map((f) => {
        const c = f.geometry.coordinates; // [lon, lat, depth]
        return {
          lat: c[1], lng: c[0], depth: c[2] != null ? c[2] : 0,
          mag: f.properties.mag, place: f.properties.place, time: f.properties.time
        };
      });
      return { items, status: 'ok', message: 'USGS 地震数据已更新 (' + items.length + ' 条)' };
    } catch (err) {
      return {
        items: [], status: 'unreachable',
        message: 'USGS 地震数据源不可达(超时/网络受限), 地震风险未知, 请出发前另行核查',
        i18nKey: 'err.usgs'
      };
    }
  }

  /* ============================================================
   * 2. 山火: NASA FIRMS 点数据 (需 API Key)
   *    ⚠️ 2026-08-16: NASA 已移除 GIBS 旧 PNG 栅格图层
   *    VIIRS_SNPP_Thermal_Anomalies_375m_Tiles(全部 400);
   *    新 MVT 矢量图层为 epsg4326/500m 网格, 与 WebMercator 坐标系
   *    不匹配(瓦片行列语义不同), 无法直接用于 MapLibre raster source,
   *    故山火数据统一走 FIRMS 点数据。
   * ============================================================ */

  /* FIRMS area API (CSV): 需 API Key; 失败静默返回空数组 */
  async function fetchFirmsPoints(lat, lon) {
    const key = getFirmsKey();
    if (!key) return [];
    const pad = 0.3; // 缓冲区外扩约 30km 的经纬度范围
    const bbox = [lon - pad, lat - pad, lon + pad, lat + pad].join(',');
    const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/'
      + key + '/VIIRS_SNPP_NRT/' + bbox + '/2'; // 最近 2 天
    try {
      const res = await fetchTimeout(url, null, 12000); // FIRMS 大陆网络慢, 放宽到 12s
      const text = await res.text();
      const rows = text.split(/\r?\n/).filter((r) => r.trim());
      if (rows.length < 2 || rows[0].toLowerCase().includes('error')) return [];
      const head = rows[0].split(',').map((h) => h.trim().toLowerCase());
      const iLat = head.indexOf('latitude'), iLon = head.indexOf('longitude');
      const iFrp = head.indexOf('frp'), iDate = head.indexOf('acq_date'), iTime = head.indexOf('acq_time');
      if (iLat < 0 || iLon < 0) return [];
      const pts = [];
      for (let i = 1; i < rows.length; i++) {
        const c = rows[i].split(',');
        const la = parseFloat(c[iLat]), lo = parseFloat(c[iLon]);
        if (isNaN(la) || isNaN(lo)) continue;
        pts.push({
          lat: la, lng: lo,
          frp: iFrp >= 0 ? parseFloat(c[iFrp]) || 0 : 0,
          time: ((iDate >= 0 ? c[iDate] : '') + ' ' + (iTime >= 0 ? c[iTime] : '')).trim()
        });
      }
      return pts;
    } catch (e) {
      return []; // FIRMS 不可达 → 空点(山火图层不显示, 状态提示不可达)
    }
  }

  /* 山火总入口: 返回 FIRMS 点 + 状态说明 */
  async function fetchWildfires(lat, lon) {
    // FIRMS 大陆网络实测约 6.5s(限速), 超时放宽到 12s 避免误判不可达
    const points = await fetchFirmsPoints(lat, lon);
    const note = points.length
      ? 'NASA FIRMS 卫星热点 ' + points.length + ' 处'
      : (getFirmsKey()
          ? 'NASA FIRMS 数据源不可达(超时/网络受限), 山火风险未知, 请出发前另行核查'
          : '未配置 NASA FIRMS API Key, 山火点数据不可用');
    // i18nKey: 供 app.js 渲染时按当前语言取词(message 为中文兜底)
    const i18nKey = points.length ? 'ok.firms.points' : (getFirmsKey() ? 'err.firms.unreachable' : 'err.firms.nokey');
    const i18nParams = points.length ? { n: points.length } : undefined;
    return { points, status: points.length ? 'ok' : 'degraded', message: note, i18nKey, i18nParams };
  }

  /* ============================================================
   * 3. 碰撞检测: 灾害点 vs 10km 缓冲区 + 距轨迹最近距离
   *    返回预警列表 [{level, icon, key, params, text, source, time}]
   *    level: danger(红) / warning(黄) / info(灰蓝)
   *    key/params: 供 app.js 按当前语言渲染; text 为中文兜底
   * ============================================================ */
  function checkIntersections(bufferGeoJSON, quakes, firePoints, trailLineCoords) {
    const alerts = [];

    // 地震碰撞检测
    quakes.forEach((q) => {
      if (!TrailGeo.pointInPolygon([q.lat, q.lng], bufferGeoJSON)) return; // 缓冲区外忽略
      const dist = TrailGeo.distancePointToLineKm([q.lat, q.lng], trailLineCoords);
      const mag = q.mag != null ? q.mag.toFixed(1) : '?';
      const level = q.mag >= 5 ? 'danger' : (q.mag >= 4 ? 'warning' : 'info');
      // M≥4.5 追加山体滑坡/落石提示(用不同 i18n key)
      const slide = q.mag >= 4.5;
      alerts.push({
        level,
        icon: '🌋',
        key: slide ? 'alert.quake.slide' : 'alert.quake',
        params: { dist: dist.toFixed(1), mag, place: q.place || '?' },
        text: '距轨迹 ' + dist.toFixed(1) + 'km 发现地震 M' + mag
              + ' (' + (q.place || '未知位置') + ')' + (slide ? ', 注意山体滑坡/落石风险' : ''),
        source: 'USGS',
        time: new Date(q.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      });
    });

    // 山火碰撞检测
    firePoints.forEach((f) => {
      if (!TrailGeo.pointInPolygon([f.lat, f.lng], bufferGeoJSON)) return;
      const dist = TrailGeo.distancePointToLineKm([f.lat, f.lng], trailLineCoords);
      alerts.push({
        level: 'danger',
        icon: '🔥',
        key: 'alert.fire',
        params: { dist: dist.toFixed(1), frp: f.frp ? Math.round(f.frp) : null },
        text: '距轨迹 ' + dist.toFixed(1) + 'km 发现 NASA 卫星山火热点'
              + (f.frp ? ' (辐射功率 ' + Math.round(f.frp) + ' MW)' : ''),
        source: 'NASA FIRMS',
        time: f.time
      });
    });

    return alerts;
  }

  /* 对外导出 */
  return {
    fetchQuakes, fetchWildfires, checkIntersections,
    getFirmsKey, // 暴露固化的 Key(供调试/扩展)
    TIMEOUT_MS
  };
})();
