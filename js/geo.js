/* ============================================================
 * geo.js — 地理信息与轨迹处理模块 (GIS & Trail Processing)
 * 职责: GPX/KML/GeoJSON 解析、轨迹统计、10km 缓冲区、
 *       内置武功山反穿示例轨迹与景点标记。
 * 依赖: Turf.js (window.turf); 无 turf 时部分函数自动降级。
 * 无构建步骤, 浏览器直接可用。
 * ============================================================ */
const TrailGeo = (function () {
  'use strict';

  /* ---------- 基础: Haversine 球面距离 (km) ---------- */
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球平均半径 km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /* ---------- GPX 解析 (trkpt lat/lon + ele) ---------- */
  function parseGPX(text) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const points = [];
    const trkpts = xml.querySelectorAll('trkpt');
    trkpts.forEach((trkpt) => {
      const lat = parseFloat(trkpt.getAttribute('lat'));
      const lon = parseFloat(trkpt.getAttribute('lon'));
      const eleEl = trkpt.querySelector('ele');
      const ele = eleEl ? parseFloat(eleEl.textContent) : null;
      if (!isNaN(lat) && !isNaN(lon)) points.push([lat, lon, ele]);
    });
    return points;
  }

  /* ---------- KML 解析: 优先 gx:Track, 其次标准 coordinates ---------- */
  function parseKML(text) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const points = [];

    // gx:Track 格式 (Google 地球轨迹)
    const gxCoords = xml.getElementsByTagNameNS('http://www.google.com/kml/ext/2.2', 'coord');
    if (gxCoords.length > 0) {
      for (const el of gxCoords) {
        const parts = el.textContent.trim().split(/\s+/);
        if (parts.length >= 2) {
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          const ele = parts.length >= 3 ? parseFloat(parts[2]) : null;
          if (!isNaN(lat) && !isNaN(lon)) points.push([lat, lon, ele]);
        }
      }
      return points;
    }

    // 标准 coordinates 标签
    const coordEls = xml.getElementsByTagName('coordinates');
    for (const el of coordEls) {
      const textContent = el.textContent.trim();
      const lines = textContent.split(/\s+/);
      for (const line of lines) {
        const parts = line.split(',').map(Number);
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          points.push([parts[1], parts[0], parts.length >= 3 ? parts[2] : null]);
        }
      }
    }
    return points;
  }

  /* ---------- GeoJSON 解析: 支持 LineString / MultiLineString ---------- */
  function parseGeoJSON(text) {
    const geojson = JSON.parse(text);
    const points = [];
    const walk = (coords) => {
      coords.forEach((c) => {
        if (typeof c[0] === 'number') {
          // 单个坐标点 [lng, lat, ele?]
          points.push([c[1], c[0], c.length >= 3 ? c[2] : null]);
        } else {
          walk(c); // 嵌套数组(MultiLineString 等)
        }
      });
    };
    if (geojson.type === 'FeatureCollection') {
      geojson.features.forEach((f) => walk(f.geometry.coordinates));
    } else if (geojson.type === 'Feature') {
      walk(geojson.geometry.coordinates);
    } else {
      walk(geojson.coordinates);
    }
    return points;
  }

  /* ---------- 文件解析入口: 按扩展名分发, 返回 [lat,lng,ele][] ---------- */
  function parseFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const name = (file.name || '').toLowerCase();
          let points = [];
          if (name.endsWith('.gpx')) points = parseGPX(text);
          else if (name.endsWith('.kml') || name.endsWith('.kmz')) points = parseKML(text);
          else if (name.endsWith('.geojson') || name.endsWith('.json')) points = parseGeoJSON(text);
          else { reject(new Error('不支持的文件格式, 请上传 GPX / KML / GeoJSON')); return; }
          if (points.length < 2) reject(new Error('轨迹点不足(至少 2 个点)'));
          else resolve({ points, hasElevation: points.some((p) => p[2] != null && !isNaN(p[2])) });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(file);
    });
  }

  /* ---------- 构建轨迹 GeoJSON: 点数组 [lat,lng,ele] → LineString ---------- */
  function buildLineGeoJSON(points) {
    const coords = points.map((p) => {
      const c = [p[1], p[0]]; // GeoJSON 顺序: [lng, lat]
      if (p[2] != null && !isNaN(p[2])) c.push(p[2]);
      return c;
    });
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { name: '徒步路线' }
      }]
    };
  }

  /* ---------- 轨迹统计: 距离(turf.length)/累计爬升/累计下降/极值 ---------- */
  function computeStats(points) {
    const hasElevation = points.some((p) => p[2] != null && !isNaN(p[2]));

    // 总距离: 优先 turf.length, 否则 Haversine 逐段累加(带 typeof 保护, 任一层失败都降级)
    let distKm = 0;
    const haversineSum = () => {
      let d = 0;
      for (let i = 1; i < points.length; i++) {
        d += haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
      }
      return d;
    };
    try {
      if (typeof window !== 'undefined' && window.turf && typeof turf.length === 'function') {
        distKm = turf.length(buildLineGeoJSON(points).features[0], { units: 'kilometers' });
      } else {
        distKm = haversineSum();
      }
    } catch (e) {
      distKm = haversineSum(); // turf 计算异常 → Haversine 兜底
    }

    // 累计爬升 / 下降: 逐点正差 / 负差之和
    let ascent = 0, descent = 0, maxEle = -Infinity, minEle = Infinity;
    if (hasElevation) {
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1][2], cur = points[i][2];
        if (prev == null || cur == null) continue;
        const diff = cur - prev;
        if (diff > 0) ascent += diff; else descent += -diff;
      }
      points.forEach((p) => {
        if (p[2] == null || isNaN(p[2])) return;
        if (p[2] > maxEle) maxEle = p[2];
        if (p[2] < minEle) minEle = p[2];
      });
      if (!isFinite(maxEle)) { maxEle = 0; minEle = 0; }
    } else {
      maxEle = 0; minEle = 0;
    }

    return { distKm, ascent, descent, maxEle, minEle, hasElevation, pointCount: points.length };
  }

  /* ---------- 10km 缓冲区 (turf.buffer) ---------- */
  function makeBuffer(geojson, km) {
    const line = geojson.features[0];
    return turf.buffer(line, km, { units: 'kilometers' });
  }

  /* ---------- 点是否落在缓冲区多边形内 (turf.booleanPointInPolygon) ---------- */
  function pointInPolygon(point, bufferFeature) {
    if (!bufferFeature) return false;
    try {
      return turf.booleanPointInPolygon(turf.point([point[1], point[0]]), bufferFeature);
    } catch (e) {
      return false;
    }
  }

  /* ---------- 点到轨迹线最近距离 km (turf.pointToLineDistance, 带降级) ---------- */
  function distancePointToLineKm(point, lineCoords) {
    // point: [lat, lng]; lineCoords: [[lng, lat, ele?], ...]
    try {
      if (window.turf && turf.pointToLineDistance) {
        const line = turf.lineString(lineCoords.map((c) => [c[0], c[1]]));
        return turf.pointToLineDistance(turf.point([point[1], point[0]]), line, { units: 'kilometers' });
      }
    } catch (e) { /* 降级到下面的分段距离 */ }

    // 兜底: 局部等距投影 + 点到线段最短距离 (1°纬度 ≈ 111.32km)
    const proj = (lat, lng) => ({
      x: lng * Math.cos(lat * Math.PI / 180),
      y: lat
    });
    const segDist = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    const p = proj(point[0], point[1]);
    let best = Infinity;
    for (let i = 1; i < lineCoords.length; i++) {
      const a = proj(lineCoords[i - 1][1], lineCoords[i - 1][0]);
      const b = proj(lineCoords[i][1], lineCoords[i][0]);
      const d = segDist(p, a, b);
      if (d < best) best = d;
    }
    return best * 111.32;
  }

  /* ---------- 轨迹中心点 / 最高点 ---------- */
  function midpoint(points) { return points[Math.floor(points.length / 2)]; }

  function peakPoint(points) {
    let peak = points[0];
    points.forEach((p) => {
      if (p[2] != null && !isNaN(p[2]) && (peak[2] == null || p[2] > peak[2])) peak = p;
    });
    return peak;
  }

  /* ============================================================
   * 内置示例: 武功山反穿轨迹 (保留 demo 的生成逻辑)
   * 起点 龙山村登山口 → 金顶, 经发云界/绝望坡等关键点
   * ============================================================ */
  function generateWugongshanTrail() {
    const points = [];
    const startLat = 27.53795, startLng = 114.17172; // 龙山村登山口
    const endLat = 27.47079, endLng = 114.14914;     // 金顶附近
    const steps = 150;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // 纬度由北向南, 经度由东向西, 叠加蜿蜒摆动
      const lat = startLat + (endLat - startLat) * t + Math.sin(t * 10) * 0.015;
      const lng = startLng + (endLng - startLng) * t + Math.cos(t * 8) * 0.01;
      // 海拔: 500m → 1910m 峰值 → 回落
      const ele = 500 + 1400 * Math.sin(t * Math.PI) + 200 * Math.sin(t * 6) + 50 * Math.cos(t * 4);
      points.push([lat, lng, Math.round(ele)]);
    }
    return points;
  }

  /* 武功山反穿沿途景点标记 (参照 demo) */
  const SCENIC_SPOTS = [
    { name: '龙山村登山口', lat: 27.5379, lng: 114.1717, desc: '反穿起点, 从竹海出发' },
    { name: '发云界之巅', lat: 27.5220, lng: 114.1880, desc: '核心打卡点, 观草甸日落' },
    { name: '风车口', lat: 27.5130, lng: 114.1920, desc: '山脊线上的重要地标' },
    { name: '千丈岩', lat: 27.5040, lng: 114.1980, desc: '高山草甸, 绝美观景台' },
    { name: '好汉坡', lat: 27.4960, lng: 114.1970, desc: '挑战爬升, 观日落好去处' },
    { name: '绝望坡', lat: 27.4880, lng: 114.1930, desc: '陡峭挑战, 翻越后视野绝佳' },
    { name: '观音宕', lat: 27.4760, lng: 114.1840, desc: '山脊营地, 草甸全景' },
    { name: '吊马桩', lat: 27.4700, lng: 114.1580, desc: '景区地标, 草甸景色绝美' },
    { name: '金顶 (1918m)', lat: 27.4618, lng: 114.1525, desc: '武功山最高峰, 日出云海' }
  ];

  /* 对外导出 */
  return {
    haversineKm,
    parseGPX, parseKML, parseGeoJSON, parseFile,
    buildLineGeoJSON, computeStats, makeBuffer,
    pointInPolygon, distancePointToLineKm,
    midpoint, peakPoint,
    generateWugongshanTrail, SCENIC_SPOTS
  };
})();
