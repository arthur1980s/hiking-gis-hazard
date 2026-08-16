/* ============================================================
 * hazards.js — 灾害碰撞检测引擎 (Hazard Intersection Engine)
 * 真实数据源:
 *   · 地震: USGS Earthquake API (过去 48 小时, 震级≥2.5, 半径 200km)
 *   · 山火: NASA FIRMS (需 API Key, 国内网络通常不可达)
 *           + NASA GIBS 卫星热异常瓦片 (无需 Key, 尽力而为)
 * 所有网络请求带 8s 超时 (AbortController), 失败自动优雅降级,
 * 绝不让页面卡死; 降级时返回 status 标记, 由 UI 显示提示。
 * 依赖: TrailGeo (geo.js)
 * 注意: GIBS 瓦片在此只返回 URL 模板字符串(不依赖具体地图引擎),
 *       由 app.js 负责用 MapLibre 创建 raster source/layer。
 * ============================================================ */

/* NASA FIRMS API Key (后台固化, 无需用户配置; 申请地址: https://firms.modaps.eosdis.nasa.gov/api/map_key/) */
const FIRMS_MAP_KEY = '6550b7fd1f2f6dbbd391559e296ca868';

const Hazards = (function () {
  'use strict';

  const TIMEOUT_MS = 8000; // 统一 8 秒超时

  /* ---------- 带超时的 fetch: 超时/网络错误统一抛出 ---------- */
  async function fetchTimeout(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
   * 2. 山火:
   *    a) NASA GIBS 卫星热异常瓦片 URL (无需 Key, 国内网络可能不可达,
   *       瓦片加载失败时该图层自动不显示, 不影响页面)
   *    b) NASA FIRMS 点数据 (需 API Key, 网络通常不通 → 自动跳过)
   * ============================================================ */

  /* GIBS 热异常瓦片 URL 模板: 375m VIIRS 夜间/昼间火点
   * 返回纯 URL 字符串(含 {z}/{y}/{x} 占位符), 由 app.js 建 MapLibre raster source。
   * 注意: MapLibre 的 {x} 表示瓦片列、{y} 表示瓦片行, 该模板顺序即 WMTS 的
   *       TileRow/TileCol, 语义正确, 与引擎无关。 */
  function gibsFireTileUrl() {
    try {
      // FIRMS 产品通常滞后约 1~2 天, 取昨天日期
      const d = new Date(Date.now() - 24 * 3600 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      return 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/'
        + 'VIIRS_SNPP_Thermal_Anomalies_375m_Tiles/default/'
        + dateStr + '/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
    } catch (e) {
      return null;
    }
  }

  /* FIRMS area API (CSV): 需 API Key; 失败静默返回空数组 */
  async function fetchFirmsPoints(lat, lon) {
    const key = getFirmsKey();
    if (!key) return [];
    const pad = 0.3; // 缓冲区外扩约 30km 的经纬度范围
    const bbox = [lon - pad, lat - pad, lon + pad, lat + pad].join(',');
    const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/'
      + key + '/VIIRS_SNPP_NRT/' + bbox + '/2'; // 最近 2 天
    try {
      const res = await fetchTimeout(url);
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
      return []; // FIRMS 不可达 → 降级(仅保留 GIBS 瓦片)
    }
  }

  /* 山火总入口: 返回 GIBS 瓦片 URL + FIRMS 点 + 状态说明 */
  async function fetchWildfires(lat, lon) {
    const tileUrl = gibsFireTileUrl();              // 无需 Key 的瓦片 URL
    const points = await fetchFirmsPoints(lat, lon); // 需 Key 的点数据
    const note = points.length
      ? 'NASA FIRMS 卫星热点 ' + points.length + ' 处'
      : (getFirmsKey()
          ? 'NASA FIRMS 数据源不可达(超时/网络受限), 已降级: 山火仅显示 GIBS 卫星热异常瓦片(若未显示说明数据源不通)'
          : '未配置 NASA FIRMS API Key, 山火点数据不可用; 已叠加 GIBS 卫星热异常瓦片(无需 Key, 尽力而为)');
    // i18nKey: 供 app.js 渲染时按当前语言取词(message 为中文兜底)
    const i18nKey = points.length ? 'ok.firms.points' : (getFirmsKey() ? 'err.firms.unreachable' : 'err.firms.nokey');
    const i18nParams = points.length ? { n: points.length } : undefined;
    return { tileUrl, points, status: points.length ? 'ok' : 'degraded', message: note, i18nKey, i18nParams };
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
