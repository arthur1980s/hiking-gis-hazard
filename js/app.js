/* ============================================================
 * app.js — 应用主逻辑 (初始化 / 轨迹加载 / 灾害检测 / 风险面板 / 导出)
 * 地图引擎: MapLibre GL JS 4.7.1 (maplibregl)
 * 依赖: maplibregl + Turf(turf) + Chart.js(Chart) + html2canvas,
 *       TrailGeo(geo.js) + Hazards(hazards.js) + Weather(weather.js)
 * 注意: MapLibre 坐标顺序为 [lng, lat] (与 Leaflet 的 [lat, lng] 相反),
 *       轨迹点数组统一为 [lat, lng, ele] (TrailGeo 约定)。
 * ============================================================ */
(function () {
  'use strict';

  /* ============================================================
   * 1. 全局状态
   * ============================================================ */
  const state = {
    points: null,           // 轨迹点数组 [[lat,lng,ele],...]
    trailName: '雨崩·神湖徒步', // 当前轨迹名称(顶部 badge 显示)
    trailGeoJSON: null,     // 轨迹 FeatureCollection
    lineCoords: null,       // [[lng,lat,ele?],...]
    bufferGeoJSON: null,    // 缓冲区 Feature
    bufferLabel: null,      // 缓冲区标签 DOM Marker
    chart: null,            // Chart.js 实例
    hoverIndexMap: null,    // 剖面图采样索引 → 原始轨迹点索引 映射(hover 红点联动用)
    layers: { fires: true, quakes: true, buffer: true, contour: false, rain: false },
    quakeData: { items: [], status: 'pending' },
    fireData: { points: [], status: 'pending', tileUrl: null },
    weatherData: null,
    hazardsAlerts: [],
    rainFrames: null,       // RainViewer 帧列表
    rainChecked: false,     // 雨带是否已尝试获取
    rainPlayer: null,       // 雨带播放器句柄
    detecting: false,
    toastTimer: null
  };

  /* ============================================================
   * 2. 地图初始化 (MapLibre)
   * ============================================================ */
  const map = new maplibregl.Map({
    container: 'map',
    // 内联 style v8: 预定义三种底图 raster source + 三个底图图层(按需切换 visibility)
    style: {
      version: 8,
      sources: {
        // 注意: MapLibre 不支持 Leaflet 的 {s} 子域占位符, 直接写死子域
        'opentopomap': {
          type: 'raster',
          tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 17, // 超过此级别自动放大最后一级瓦片(等价 Leaflet maxZoom 行为)
          attribution: '© OpenTopoMap (CC-BY-SA)'
        },
        'esri': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          maxzoom: 18,
          attribution: '© Esri World Imagery'
        },
        // 高德矢量底图(大陆极稳, 默认): MapLibre 不支持 {s} 子域, 写死子域 webrd01
        'amap': {
          type: 'raster',
          tiles: ['https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'],
          tileSize: 256,
          maxzoom: 18,
          attribution: '© 高德地图'
        },
        // 高德影像(卫星)
        'amap-sat': {
          type: 'raster',
          tiles: ['https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'],
          tileSize: 256,
          maxzoom: 18,
          attribution: '© 高德地图'
        },
        // OSM 标准(大陆一般可达, 用作降级备用)
        'osm': {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© OpenStreetMap'
        }
      },
      layers: [
        // 默认底图为高德矢量(大陆网络稳定, 避免地图黑屏)
        { id: 'basemap-amap', type: 'raster', source: 'amap', minzoom: 0, maxzoom: 22 },
        { id: 'basemap-amap-sat', type: 'raster', source: 'amap-sat', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' } },
        { id: 'basemap-osm', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' } },
        { id: 'basemap-topo', type: 'raster', source: 'opentopomap', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' } },
        { id: 'basemap-satellite', type: 'raster', source: 'esri', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' } }
      ]
    },
    center: [98.79, 28.37], // [lng, lat] 默认视野: 云南雨崩(梅里雪山)
    zoom: 12,
    pitch: 0,    // 默认 2D 平面视角(降低 GPU 负担); 3D 视角由用户点击「3D」按钮开启
    maxPitch: 85, // 最大俯仰角
    canvasContextAttributes: { antialias: true }, // 抗锯齿(3D 渲染必需)
    attributionControl: true
  });

  // 导航控件(右上角)
  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  /* 地图状态栏: 鼠标坐标 + 缩放级别 (MapLibre 事件对象用 e.lngLat) */
  map.on('mousemove', (e) => {
    document.getElementById('mapStatusbar').textContent =
      '📍 ' + e.lngLat.lat.toFixed(5) + ', ' + e.lngLat.lng.toFixed(5) +
      ' · Zoom ' + map.getZoom().toFixed(1);
  });

  /* ============================================================
   * 3. 图层工具函数 (MapLibre source/layer 管理)
   * ============================================================ */

  /* 自定义图层顺序(自底向上): 底图 < contour < buffer < gibs-fires < fires < quakes < trail < rain */
  const LAYER_ORDER = ['contour', 'buffer', 'gibs-fires', 'fires', 'quakes', 'trail', 'hover-dot', 'rain-layer'];

  /* 按固定顺序插入图层: 插到 LAYER_ORDER 中下一个已存在图层之下, 保证叠放层级稳定 */
  function addLayerOrdered(layer) {
    const idx = LAYER_ORDER.indexOf(layer.id);
    if (idx === -1) { map.addLayer(layer); return; }
    for (let i = idx + 1; i < LAYER_ORDER.length; i++) {
      if (map.getLayer(LAYER_ORDER[i])) { map.addLayer(layer, LAYER_ORDER[i]); return; }
    }
    map.addLayer(layer);
  }

  /* GeoJSON source + 图层的一键重建(先删 layer 再删 source, 避免同 id 冲突报错) */
  function setGeoJSONLayer(id, data, layerDef) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    map.addSource(id, { type: 'geojson', data: data });
    addLayerOrdered(Object.assign({ id: id, source: id }, layerDef));
  }

  /* DOM 标记(起点/终点/景点/缓冲区标签): MapLibre 无 divIcon, 用 maplibregl.Marker 元素方案 */
  const divMarkers = [];
  function clearDivMarkers() {
    divMarkers.forEach((m) => m.remove());
    divMarkers.length = 0;
  }
  function addDivMarker(html, lngLat, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'ml-marker' + (opts.cls ? ' ' + opts.cls : '');
    el.innerHTML = html;
    const m = new maplibregl.Marker({ element: el, anchor: opts.anchor || 'center' })
      .setLngLat(lngLat);
    if (opts.popup) m.setPopup(new maplibregl.Popup({ offset: opts.offset || 18 }).setHTML(opts.popup));
    m.addTo(map);
    divMarkers.push(m);
    return m;
  }

  /* 图层显隐映射: 一个按钮可能控制多个 MapLibre layer */
  const LAYER_MAP = {
    fires: ['gibs-fires', 'fires'],
    quakes: ['quakes'],
    buffer: ['buffer'],
    contour: ['contour']
  };
  function applyLayerVisibility(type) {
    const ids = LAYER_MAP[type];
    if (!ids) return;
    const vis = state.layers[type] ? 'visible' : 'none';
    ids.forEach((id) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis); });
  }

  /* 地图样式就绪后再执行图层操作(MapLibre 在样式加载完成前 addSource 会报错) */
  function whenReady(fn) {
    if (map.isStyleLoaded()) fn();
    else map.once('load', fn);
  }

  /* ============================================================
   * 4. 控件: 底图切换 + 图层开关
   * ============================================================ */
  // 底图四源: 高德矢量(默认) / 地形 / 卫星 / OSM
  const BASEMAP_LAYER = {
    amap: 'basemap-amap',
    topo: 'basemap-topo',
    satellite: 'basemap-satellite',
    osm: 'basemap-osm'
  };
  let currentBasemap = 'amap'; // 默认高德(大陆网络稳定)

  /* 统一底图切换: 更新按钮高亮 + visibility 切换 + 重置瓦片错误计数 */
  function switchBasemap(key) {
    if (!BASEMAP_LAYER[key] || key === currentBasemap) return;
    document.querySelectorAll('[data-basemap]').forEach((b) => {
      b.classList.toggle('active', b.dataset.basemap === key);
    });
    Object.values(BASEMAP_LAYER).forEach((id) => map.setLayoutProperty(id, 'visibility', 'none'));
    map.setLayoutProperty(BASEMAP_LAYER[key], 'visibility', 'visible');
    currentBasemap = key;
    basemapErrorCount = 0; // 手动/自动切换后重置降级计数
  }

  document.querySelectorAll('[data-basemap]').forEach((btn) => {
    btn.addEventListener('click', () => switchBasemap(btn.dataset.basemap));
  });

  /* ============================================================
   * 瓦片加载失败自动降级: 当前底图连续 ERROR_THRESHOLD 次瓦片错误
   * → 沿降级链切换下一备用源(高德 → OSM → OpenTopoMap), 避免地图黑屏
   * ============================================================ */
  const ERROR_THRESHOLD = 5; // 连续瓦片错误阈值
  const BASEMAP_FALLBACK_CHAIN = ['amap', 'osm', 'topo']; // 自动降级顺序
  let basemapErrorCount = 0;

  map.on('error', (e) => {
    // 仅统计瓦片/网络类错误(忽略样式等其他错误)
    const msg = (e && e.error && (e.error.message || '')) || '';
    const isTileError = /tile|fetch|network|timeout|image|status\s*[45]\d\d|Failed to fetch/i.test(msg) || !msg;
    if (!isTileError) return;
    basemapErrorCount++;
    if (basemapErrorCount >= ERROR_THRESHOLD) {
      basemapErrorCount = 0; // 切换后由 switchBasemap 再重置
      const idx = BASEMAP_FALLBACK_CHAIN.indexOf(currentBasemap);
      const next = (idx >= 0 && idx < BASEMAP_FALLBACK_CHAIN.length - 1) ? BASEMAP_FALLBACK_CHAIN[idx + 1] : null;
      if (next && next !== currentBasemap) {
        switchBasemap(next);
        showToast(t('toast.basemap.fallback') + ' → ' + t('map.' + next));
      }
    }
  });

  document.querySelectorAll('[data-layer]').forEach((btn) => {
    btn.addEventListener('click', () => toggleLayer(btn.dataset.layer));
  });

  function toggleLayer(type) {
    state.layers[type] = !state.layers[type];
    const btn = document.querySelector('[data-layer="' + type + '"]');
    if (btn) btn.classList.toggle('active', state.layers[type]);

    if (type === 'rain') { handleRainToggle(); return; }
    if (type === 'contour') { handleContourToggle(); return; }
    applyLayerVisibility(type);
  }

  /* 等高线图层: OpenTopoMap 半透明叠加(任意底图上显示等高线/地形) */
  function handleContourToggle() {
    if (state.layers.contour) {
      if (!map.getLayer('contour')) {
        map.addSource('contour', {
          type: 'raster',
          tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 17
        });
        addLayerOrdered({ id: 'contour', type: 'raster', source: 'contour', paint: { 'raster-opacity': 0.55 } });
      }
      map.setLayoutProperty('contour', 'visibility', 'visible');
    } else if (map.getLayer('contour')) {
      map.setLayoutProperty('contour', 'visibility', 'none');
    }
  }

  /* 雨带图层: 切换时自动拉取 RainViewer 并播放帧动画 */
  function handleRainToggle() {
    if (state.layers.rain) {
      if (state.rainFrames) {
        startRain();
      } else if (state.rainChecked) {
        showToast(t('toast.rain.unreachable'));
        state.layers.rain = false;
        updateLayerBtn('rain');
      } else {
        showToast(t('toast.rain.fetching'));
        Weather.fetchRainRadar().then((frames) => {
          state.rainChecked = true;
          state.rainFrames = frames;
          if (state.layers.rain) {
            if (frames) startRain();
            else {
              showToast(t('toast.rain.unreachable'));
              state.layers.rain = false;
              updateLayerBtn('rain');
            }
          }
        });
      }
    } else {
      stopRain();
    }
  }

  function startRain() {
    stopRain();
    state.rainPlayer = Weather.playRainRadar(map, state.rainFrames, 600);
    if (state.rainPlayer) showToast(t('toast.rain.on'));
  }

  function stopRain() {
    if (state.rainPlayer) { state.rainPlayer.stop(); state.rainPlayer = null; }
  }

  function updateLayerBtn(type) {
    const btn = document.querySelector('[data-layer="' + type + '"]');
    if (btn) btn.classList.toggle('active', state.layers[type]);
  }

  /* ============================================================
   * 5. 轨迹加载主流程
   * ============================================================ */

  /* 雨崩徒步的 GPX 景点(wpt): 牧场 + 神湖 (来自 data/yubeng-hard.gpx) */
  const YUBENG_SPOTS = [
    { name: '牧场', lat: 28.362954, lng: 98.790424, desc: '高海拔牧场, 海拔 4346m' },
    { name: '神湖', lat: 28.359753, lng: 98.786289, desc: '雨崩神湖, 海拔 4460m' }
  ];

  /* 雨崩轨迹降级点: fetch 失败(file:// 打开等)时使用, 保留关键路径点 */
  const YUBENG_FALLBACK = [
    [28.390854, 98.792835, 3060], // 起点(下雨崩)
    [28.375000, 98.794500, 3500],
    [28.362954, 98.790424, 4346], // 牧场
    [28.359753, 98.786289, 4460], // 神湖
    [28.368000, 98.785000, 4200]
  ];

  /* 雨崩轨迹点缓存: 首次 fetch 解析后复用(Discover 与内置按钮共享) */
  let yubengPointsCache = null;

  /* 获取雨崩轨迹点: fetch GPX → 解析; 失败降级为内置精简点 */
  async function loadYubengPoints() {
    if (yubengPointsCache) return yubengPointsCache;
    try {
      const res = await fetch('data/yubeng-hard.gpx');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const pts = TrailGeo.parseGPX(await res.text());
      if (pts.length < 2) throw new Error('GPX 点不足');
      yubengPointsCache = pts;
      return pts;
    } catch (e) {
      console.warn('雨崩 GPX 加载失败, 使用内置精简点:', e);
      return YUBENG_FALLBACK.slice();
    }
  }

  /* 加载雨崩徒步示例(默认轨迹; 同时供「雨崩徒步(内置)」按钮调用) */
  function loadYubeng() {
    loadYubengPoints().then((pts) => loadTrail(pts, '雨崩·神湖徒步'));
  }

  /* 保留武功山加载(向后兼容 window.TrailSense, 不再被任何 UI 调用) */
  function loadWugongshan() {
    const pts = TrailGeo.generateWugongshanTrail();
    loadTrail(pts, '武功山反穿');
  }

  /* 更新顶部导航栏 badge: 跟随当前加载的轨迹名(示例/Discover 路线/上传文件) */
  function setTrailBadge(name) {
    state.trailName = name || '雨崩·神湖徒步';
    const el = document.getElementById('trailBadge');
    if (el) el.textContent = state.trailName;
  }

  async function loadTrail(points, name) {
    state.points = points;

    // 切换轨迹/加载 GPX 时回到 2D 视角: 若 3D 已开启则关闭(按钮状态同步), 否则确保 pitch 0
    try {
      if (window.__trailSense3D && window.__trailSense3D.isEnabled()) {
        await window.__trailSense3D.disable3D();
      } else {
        map.setPitch(0);
      }
    } catch (e) { /* 3D 模块异常不影响轨迹加载 */ }
    setTrailBadge(name); // 统一更新 badge, 未传 name 时默认"雨崩·神湖徒步"

    // 海拔缺失时用 Open-Meteo 高程 API 补齐
    let hasElevation = points.some((p) => p[2] != null && !isNaN(p[2]));
    if (!hasElevation) {
      await Weather.fillElevation(points);
      hasElevation = points.some((p) => p[2] != null && !isNaN(p[2]));
    }

    // 构建 GeoJSON 并保存
    const geojson = TrailGeo.buildLineGeoJSON(points);
    state.trailGeoJSON = geojson;
    state.lineCoords = geojson.features[0].geometry.coordinates; // [lng,lat,ele?]

    // 轨迹统计
    const stats = TrailGeo.computeStats(points);
    document.getElementById('statDistance').textContent = stats.distKm.toFixed(1);
    document.getElementById('statElevation').textContent = stats.hasElevation ? Math.round(stats.ascent) + 'm' : '--';
    document.getElementById('statDescent').textContent = stats.hasElevation ? Math.round(stats.descent) + 'm' : '--';
    document.getElementById('statMaxEle').textContent = stats.hasElevation ? Math.round(stats.maxEle) + 'm' : '--';
    document.getElementById('statMinEle').textContent = stats.hasElevation ? Math.round(stats.minEle) + 'm' : '--';
    document.getElementById('statPoints').textContent = points.length;

    // 海拔剖面图(与地图无关, 先画)
    drawElevationChart(points);

    // 地图渲染 + 灾害检测(等样式就绪)
    whenReady(() => {
      // 清空旧图层(轨迹/缓冲区/灾害点/GIBS)与 DOM 标记
      ['trail', 'buffer', 'fires', 'quakes', 'gibs-fires'].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      });
      clearDivMarkers();
      state.bufferLabel = null;

      // hover 红点图层(剖面图联动, 默认隐藏)
      ensureHoverDot();

      // 绘制轨迹线 (line layer)
      setGeoJSONLayer('trail', geojson, {
        type: 'line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#e94560', 'line-width': 4, 'line-opacity': 0.9 }
      });

      // 起点/终点 DOM 标记: 纯 CSS 定位针(起点红 / 终点绿, 尖部对准坐标) + popup
      const c0 = points[0], cN = points[points.length - 1];
      addDivMarker('<div class="map-pin pin-start"></div>', [c0[1], c0[0]], {
        anchor: 'bottom',
        popup: '<strong>' + t('popup.start') + '</strong><br><span style="font-size:11px;color:#999;">' + c0[0].toFixed(5) + ', ' + c0[1].toFixed(5) + '</span>'
      });
      addDivMarker('<div class="map-pin pin-end"></div>', [cN[1], cN[0]], {
        anchor: 'bottom',
        popup: '<strong>' + t('popup.end') + '</strong><br><span style="font-size:11px;color:#999;">' + cN[0].toFixed(5) + ', ' + cN[1].toFixed(5) + '</span>'
      });

      // 雨崩徒步景点标记(来自 GPX 的 wpt: 牧场/神湖)
      YUBENG_SPOTS.forEach((spot) => {
        addDivMarker('<span style="font-size:22px; line-height:1;">⛰️</span>', [spot.lng, spot.lat], {
          cls: 'spot-marker',
          anchor: 'bottom',
          offset: 26,
          popup: '<strong>' + spot.name + '</strong><br><span style="font-size:12px;color:#999;">' + spot.desc + '</span>'
        });
      });

      // 缓冲区 + 视野适配 (turf.bbox → [minLng,minLat,maxLng,maxLat])
      generateBuffer(getBufferRadius());
      const bbox = turf.bbox(geojson);
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, maxZoom: 13 });

      // 自动触发灾害检测(并发, 不阻塞页面)
      runHazardChecks();
      saveTrailState(); // 轨迹与统计就绪后先保存一次(预警/气象随后刷新)
    });
  }

  /* 读取监测半径(默认 10km) */
  function getBufferRadius() {
    const el = document.getElementById('bufferRadius');
    return el ? parseFloat(el.value) || 10 : 10;
  }

  /* ---------- 10km 缓冲区 (fill layer + DOM 标签) ---------- */
  function generateBuffer(km) {
    if (!state.trailGeoJSON) return;
    try {
      const buffered = TrailGeo.makeBuffer(state.trailGeoJSON, km);
      state.bufferGeoJSON = buffered;
      setGeoJSONLayer('buffer', buffered, {
        type: 'fill',
        paint: {
          'fill-color': '#f5c518',
          'fill-opacity': 0.08,
          'fill-outline-color': '#f5c518'
        }
      });
      // 缓冲区标签
      if (state.bufferLabel) { state.bufferLabel.remove(); state.bufferLabel = null; }
      const c = turf.center(buffered);
      state.bufferLabel = addDivMarker(
        '<span style="background:rgba(245,197,24,0.15);border:1px solid rgba(245,197,24,0.6);color:#f5c518;'
        + 'padding:2px 8px;border-radius:20px;font-size:11px;white-space:nowrap;">' + t('buffer.label', { km: km }) + '</span>',
        [c.geometry.coordinates[0], c.geometry.coordinates[1]]
      );
      if (!state.layers.buffer) applyLayerVisibility('buffer');
    } catch (e) {
      console.warn('缓冲区生成失败:', e);
    }
  }

  /* ============================================================
   * 6. 灾害检测: 并发抓取 地震 + 山火 + 微气象, 再碰撞计算
   * ============================================================ */
  async function runHazardChecks() {
    if (!state.points || state.detecting) return;
    state.detecting = true;
    setDetectStatus(t('status.detecting'), true);

    const center = TrailGeo.midpoint(state.points);          // 轨迹中心(地震检索圆心)
    const peak = TrailGeo.peakPoint(state.points);           // 最高点(微气象取样点)

    // 并发请求(每个都带超时+降级, 互不阻塞)
    const [quakeRes, fireRes, weatherRes] = await Promise.all([
      Hazards.fetchQuakes(center[0], center[1]),
      Hazards.fetchWildfires(center[0], center[1]),
      Weather.fetchMountainWeather(peak[0], peak[1], peak[2])
    ]);

    state.quakeData = quakeRes;
    state.fireData = fireRes;
    state.weatherData = weatherRes;

    // 渲染地震/山火图层 + GIBS 热异常瓦片
    renderQuakeLayer(quakeRes.items);
    renderFireLayer(fireRes.points);
    renderGibsTiles();
    applyLayerVisibility('fires'); // 同时控制 gibs-fires + fires 的显隐

    // 碰撞检测: 灾害点 vs 缓冲区
    state.hazardsAlerts = Hazards.checkIntersections(
      state.bufferGeoJSON, quakeRes.items, fireRes.points, state.lineCoords
    );

    // 更新预警面板 + 风险灯 + 微气象面板 + 风寒计算器
    updateRiskPanel();
    updateWeatherPanel();

    // 雨带雷达(异步拉取, 不阻塞)
    if (!state.rainChecked) {
      Weather.fetchRainRadar().then((frames) => {
        state.rainChecked = true;
        state.rainFrames = frames;
        if (state.layers.rain) {
          if (frames) startRain();
          else { state.layers.rain = false; updateLayerBtn('rain'); }
        }
        updateRiskPanel(); // 雨带状态变化后刷新提示
      });
    }

    const updatedAt = fmtTime(new Date());
    state.lastUpdatedTime = updatedAt; // 供语言切换后重设状态文本
    setDetectStatus(t('status.updated', { time: updatedAt }), false);
    state.detecting = false;
    saveTrailState(); // 预警/气象更新完成后保存
  }

  /* ---------- 地震图层 (circle layer + 点击 popup) ---------- */
  function renderQuakeLayer(items) {
    const features = items.map((q) => {
      const inside = !!(state.bufferGeoJSON && TrailGeo.pointInPolygon([q.lat, q.lng], state.bufferGeoJSON));
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [q.lng, q.lat] },
        properties: {
          mag: q.mag || 0,
          inside: inside,
          popup: '<strong>' + t('popup.quake', { mag: (q.mag != null ? q.mag.toFixed(1) : '?') }) + '</strong><br>'
            + (q.place || t('popup.unknown')) + '<br>' + t('popup.depth', { d: (q.depth || 0).toFixed(1) })
            + (inside ? '<br><span style="color:#e74c3c;">' + t('popup.inBuffer', { km: getBufferRadius() }) + '</span>' : '')
            + '<br><span style="font-size:11px;color:#999;">' + new Date(q.time).toLocaleString('zh-CN') + '</span>'
        }
      };
    });
    setGeoJSONLayer('quakes', { type: 'FeatureCollection', features: features }, {
      type: 'circle',
      paint: {
        // 半径随震级插值, 透明度按是否在缓冲区内
        'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 2.5, 9, 7, 17],
        'circle-color': '#ff6b6b',
        'circle-opacity': ['case', ['get', 'inside'], 0.8, 0.3],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }
    });
    applyLayerVisibility('quakes');
  }

  /* ---------- 山火图层 (circle layer + 点击 popup) ---------- */
  function renderFireLayer(points) {
    const features = points.map((f) => {
      const inside = !!(state.bufferGeoJSON && TrailGeo.pointInPolygon([f.lat, f.lng], state.bufferGeoJSON));
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
        properties: {
          inside: inside,
          popup: '<strong>' + t('popup.fire') + '</strong><br>'
            + 'FRP ' + Math.round(f.frp || 0) + ' MW'
            + (inside ? '<br><span style="color:#e74c3c;">' + t('popup.inBuffer', { km: getBufferRadius() }) + '</span>' : '')
            + '<br><span style="font-size:11px;color:#999;">' + (f.time || '') + '</span>'
        }
      };
    });
    setGeoJSONLayer('fires', { type: 'FeatureCollection', features: features }, {
      type: 'circle',
      paint: {
        'circle-radius': ['case', ['get', 'inside'], 13, 9],
        'circle-color': '#ff6b35',
        'circle-opacity': ['case', ['get', 'inside'], 0.8, 0.35],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }
    });
  }

  /* ---------- GIBS 卫星热异常瓦片 (raster source, 位于山火点层之下) ---------- */
  function renderGibsTiles() {
    const url = state.fireData.tileUrl;
    if (!url) return;
    if (!map.getSource('gibs-fires')) {
      map.addSource('gibs-fires', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 8 });
    }
    if (!map.getLayer('gibs-fires')) {
      addLayerOrdered({ id: 'gibs-fires', type: 'raster', source: 'gibs-fires', paint: { 'raster-opacity': 0.85 } });
    }
  }

  /* ---------- 图层点击 popup: 注册一次即可(按 layerId 触发) ---------- */
  function bindLayerPopups() {
    ['fires', 'quakes'].forEach((layerId) => {
      map.on('click', layerId, (e) => {
        if (!e.features || !e.features.length) return;
        const f = e.features[0];
        new maplibregl.Popup({ offset: 14 })
          .setLngLat(e.lngLat)
          .setHTML(f.properties.popup || '')
          .addTo(map);
      });
      map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    });
  }

  /* 按 i18n key + 参数渲染预警文本(key 缺失时回退 text) */
  function alertText(a) {
    if (!a.key) return a.text || '';
    const p = Object.assign({}, a.params);
    if (a.key === 'alert.fire' && p.frp) p.frp = t('alert.fire.frp', { frp: p.frp }); // FRP 后缀按语言拼装
    return t(a.key, p);
  }

  /* ============================================================
   * 7. 风险面板: 红黄绿灯 + 预警列表
   * ============================================================ */
  function updateRiskPanel() {
    const alerts = [];

    // 1) 灾害碰撞检测结果(i18n 渲染)
    state.hazardsAlerts.forEach((a) => alerts.push(Object.assign({}, a, { text: alertText(a) })));

    // 2) 微气象风险
    const w = state.weatherData;
    if (w && w.status === 'ok') {
      // 失温预警: 体感 < 0°C
      if (w.windChill != null && w.windChill < 0) {
        alerts.push({ level: 'danger', icon: '🥶', text: t('alert.wc.cold', { wc: w.windChill.toFixed(1) }), source: 'Open-Meteo' });
      } else if (w.windChill != null && w.windChill < 5) {
        alerts.push({ level: 'warning', icon: '🧊', text: t('alert.wc.mild', { wc: w.windChill.toFixed(1) }), source: 'Open-Meteo' });
      }
      // 阵风: ≥8级(62km/h)预警
      if (w.maxGust6h != null && w.maxGust6h >= 62) {
        alerts.push({
          level: w.maxGust6h >= 89 ? 'danger' : 'warning', icon: '💨',
          text: t('alert.gust', {
            g: Math.round(w.maxGust6h),
            lv: t(w.maxGust6h >= 89 ? 'alert.gust.lv10' : 'alert.gust.lv8')
          }),
          source: 'Open-Meteo'
        });
      }
      // UV
      if (w.uv != null && w.uv >= 8) {
        alerts.push({ level: 'warning', icon: '☀️', text: t('alert.uv', { uv: w.uv.toFixed(1) }), source: 'Open-Meteo' });
      }
      // 土壤湿度(泥泞/滑坡)
      if (w.soil != null && w.soil >= 0.55) {
        alerts.push({ level: 'warning', icon: '🟤', text: t('alert.soil', { s: Math.round(w.soil * 100) }), source: 'Open-Meteo' });
      }
      // 天气代码
      const codeAlert = Weather.describeCode(w.code);
      if (codeAlert) {
        alerts.push({ level: codeAlert.level, icon: codeAlert.icon, text: t('wx.code.' + codeAlert.key, null, codeAlert.text), source: 'Open-Meteo' });
      }
    }

    // 3) 数据源降级提示(灰色 info, i18n 渲染)
    if (state.quakeData.status === 'unreachable') {
      alerts.push({ level: 'info', icon: '📡', text: state.quakeData.i18nKey ? t(state.quakeData.i18nKey) : state.quakeData.message, source: 'USGS' });
    }
    if (state.fireData.status === 'degraded') {
      alerts.push({ level: 'info', icon: '📡', text: state.fireData.i18nKey ? t(state.fireData.i18nKey, state.fireData.i18nParams) : state.fireData.message, source: 'NASA' });
    }
    if (w && w.status === 'unreachable') {
      alerts.push({ level: 'info', icon: '📡', text: w.i18nKey ? t(w.i18nKey) : w.message, source: 'Open-Meteo' });
    }
    if (state.rainChecked && !state.rainFrames) {
      alerts.push({ level: 'info', icon: '📡', text: t('alert.rain.unreachable'), source: 'RainViewer' });
    }

    // 4) 渲染列表
    const container = document.getElementById('alertList');
    if (!alerts.length) {
      container.innerHTML = '<div class="alert-item safe"><span>✅</span><span class="txt">' + t('alert.none', { km: getBufferRadius() }) + '</span></div>';
    } else {
      container.innerHTML = alerts.map((a) =>
        '<div class="alert-item ' + a.level + '">'
        + '<span>' + a.icon + '</span>'
        + '<span class="txt">' + a.text
        + (a.time ? '<span class="time">🕐 ' + a.time + '</span>' : '')
        + '</span>'
        + '<span class="tag">' + a.source + '</span>'
        + '</div>'
      ).join('');
    }

    // 5) 红黄绿灯
    const hasDanger = alerts.some((a) => a.level === 'danger');
    const hasWarning = alerts.some((a) => a.level === 'warning');
    const dot = document.getElementById('riskDot');
    const label = document.getElementById('riskLabel');
    if (hasDanger) { dot.className = 'risk-dot danger'; label.textContent = t('risk.danger'); }
    else if (hasWarning) { dot.className = 'risk-dot warning'; label.textContent = t('risk.warning'); }
    else { dot.className = 'risk-dot safe'; label.textContent = t('risk.safe'); }

    // 数据源状态摘要(源名保持专名不翻译)
    const src = document.getElementById('sourceStatus');
    const st = [];
    st.push(state.quakeData.status === 'ok' ? '✅ USGS' : (state.quakeData.status === 'unreachable' ? '❌ USGS' : '⏳ USGS'));
    st.push(state.fireData.status === 'ok' ? '✅ NASA' : (state.fireData.status === 'degraded' ? '⚠️ NASA' : '⏳ NASA'));
    st.push(w && w.status === 'ok' ? '✅ Open-Meteo' : (w && w.status === 'unreachable' ? '❌ Open-Meteo' : '⏳ Open-Meteo'));
    st.push(state.rainChecked ? (state.rainFrames ? '✅ RainViewer' : '❌ RainViewer') : '⏳ RainViewer');
    src.textContent = st.join(' · ');
  }

  /* 按当前语言格式化时间(检测状态"已更新"用) */
  function fmtTime(d) {
    return d.toLocaleTimeString(i18n.getLang() === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  }

  /* 检测状态指示 */
  function setDetectStatus(text, busy) {
    const el = document.getElementById('detectStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'status' + (busy ? ' busy' : '');
  }

  /* ============================================================
   * 8. 微气象面板 + 风寒计算器
   * ============================================================ */
  function updateWeatherPanel() {
    const w = state.weatherData;
    const peak = state.points ? TrailGeo.peakPoint(state.points) : null;

    setText('wxPeakEle', peak && peak[2] != null ? Math.round(peak[2]) + ' m' : '--');
    setText('wxTemp', w && w.tempC != null ? w.tempC.toFixed(1) + '°C' : '--');
    setText('wxGust', w && w.gustKmh != null ? Math.round(w.gustKmh) + ' km/h' : '--');
    setText('wxUV', w && w.uv != null ? w.uv.toFixed(1) : (w && w.status === 'unreachable' ? t('wx.na') : '--'));
    setText('wxSoil', w && w.soil != null ? Math.round(w.soil * 100) + '%' : '--');
    setText('wxWc', w && w.windChill != null ? w.windChill.toFixed(1) + '°C' : '--');
    setText('wxGust6h', w && w.maxGust6h != null ? Math.round(w.maxGust6h) + ' km/h' : '--');
    setText('wxWc6h', w && w.minWc6h != null ? w.minWc6h.toFixed(1) + '°C' : '--');
    setText('wxPrecip', w && w.maxPrecipProb != null ? Math.round(w.maxPrecipProb) + '%' : '--');

    // 自动把最高点实时数据填入风寒计算器
    if (w && w.tempC != null) document.getElementById('tempInput').value = Math.round(w.tempC * 10) / 10;
    if (w && w.gustKmh != null) document.getElementById('windInput').value = Math.round(w.gustKmh);
    calcWindChill();
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* 风寒计算器 */
  function calcWindChill() {
    const temp = parseFloat(document.getElementById('tempInput').value);
    const wind = parseFloat(document.getElementById('windInput').value);
    const disp = document.getElementById('windchillDisplay');
    if (isNaN(temp) || isNaN(wind) || wind < 0) {
      disp.textContent = '--';
      disp.className = 'windchill-result';
      return;
    }
    const wc = Weather.calcWindChill(temp, wind);
    disp.textContent = (wc != null ? Math.round(wc * 10) / 10 : '--') + '°C';
    disp.className = 'windchill-result' + (wc != null && wc < 0 ? ' freezing' : (wc != null && wc < 5 ? ' cold' : ''));
  }

  /* ============================================================
   * 9. 海拔剖面图 (Chart.js) + hover 联动地图红点
   *    · x 轴显示「总距离 km」
   *    · 鼠标悬停剖面图时, 地图上红色圆点沿轨迹移动到对应位置
   * ============================================================ */
  function drawElevationChart(points) {
    const ctx = document.getElementById('elevationChart');
    if (!ctx) return;
    if (state.chart) { state.chart.destroy(); state.chart = null; }

    const hasElevation = points.some((p) => p[2] != null && !isNaN(p[2]));
    if (!hasElevation) {
      ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
      return;
    }

    // 采样 ≤ 80 点, x 轴为累计距离(km); 同时记录「采样索引 → 原始轨迹点索引」映射
    const step = Math.max(1, Math.ceil(points.length / 80));
    const sampled = [];
    const indexMap = []; // 采样下标 → 原始 points 下标
    let acc = 0;
    let prev = null;
    points.forEach((p, i) => {
      if (prev) acc += TrailGeo.haversineKm(prev[0], prev[1], p[0], p[1]);
      prev = p;
      if (i % step === 0 || i === points.length - 1) {
        sampled.push({ d: acc, e: p[2], i: i });
        indexMap.push(i);
      }
    });
    state.hoverIndexMap = indexMap; // 供 hover 回调查询对应轨迹点

    state.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: sampled.map((s) => s.d.toFixed(1)),
        datasets: [{
          label: '海拔 (m)',
          data: sampled.map((s) => s.e),
          borderColor: '#e94560',
          backgroundColor: 'rgba(233,69,96,0.15)',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => c.label + 'km @ ' + Math.round(c.parsed.y) + 'm' } }
        },
        scales: {
          x: {
            display: true, // 显示横轴(累计距离)
            title: { display: true, text: '总距离 km', color: 'rgba(255,255,255,0.3)', font: { size: 9 } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 9 }, maxTicksLimit: 6 }
          },
          y: {
            display: true,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 9 } },
            beginAtZero: false
          }
        },
        interaction: { intersect: false, mode: 'index' },
        // hover 联动: 根据当前数据索引移动地图红点
        onHover: (event, activeElements) => {
          if (!activeElements || !activeElements.length) return;
          updateHoverDot(activeElements[0].index);
        }
      }
    });

    // 鼠标离开图表 → 隐藏红点(先移除再添加, 防止重复监听)
    ctx.removeEventListener('mouseleave', hideHoverDot);
    ctx.addEventListener('mouseleave', hideHoverDot);
  }

  /* ---------- hover 红点图层: 红色圆点 + 白色描边, 位于轨迹线之上 ---------- */
  function ensureHoverDot() {
    whenReady(() => {
      if (!map.getSource('hover-dot')) {
        map.addSource('hover-dot', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      }
      if (!map.getLayer('hover-dot')) {
        addLayerOrdered({
          id: 'hover-dot',
          type: 'circle',
          source: 'hover-dot',
          layout: { visibility: 'none' }, // 默认隐藏, hover 时显示
          paint: {
            'circle-radius': 8,
            'circle-color': '#e94560',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
          }
        });
      }
    });
  }

  /* 根据剖面图数据索引, 把红点移动到对应轨迹坐标, 并同步浮动标签 */
  function updateHoverDot(chartIndex) {
    if (!state.points || !state.hoverIndexMap) return; // 空值保护(初始 -- 状态)
    const origIdx = state.hoverIndexMap[chartIndex];
    if (origIdx == null) return;
    const p = state.points[origIdx]; // [lat, lng, ele]
    ensureHoverDot();
    const src = map.getSource('hover-dot');
    if (src) {
      src.setData({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p[1], p[0]] }, // [lng, lat]
        properties: {}
      });
    }
    if (map.getLayer('hover-dot')) map.setLayoutProperty('hover-dot', 'visibility', 'visible');
    updateHoverLabel(chartIndex, p); // 同步浮动标签
  }

  /* 鼠标离开图表 → 隐藏红点与浮动标签 */
  function hideHoverDot() {
    if (map.getLayer('hover-dot')) map.setLayoutProperty('hover-dot', 'visibility', 'none');
    hideHoverLabel();
  }

  /* ---------- 浮动标签: 跟随红点的 DOM 悬浮层(不依赖 glyphs) ---------- */
  function ensureHoverLabel() {
    let el = document.getElementById('hoverLabel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hoverLabel';
      el.className = 'hover-label';
      const wrap = document.querySelector('.map-wrapper');
      if (wrap) wrap.appendChild(el); // 挂在地图容器内, 便于用 project 坐标定位
    }
    return el;
  }

  /* 显示浮动标签: 文字「X.Xkm @ Ym」(里程/海拔), 位置投影到红点上方 */
  function updateHoverLabel(chartIndex, p) {
    const dist = (state.chart && state.chart.data && state.chart.data.labels) ? state.chart.data.labels[chartIndex] : '?';
    const el = ensureHoverLabel();
    el.textContent = dist + 'km @ ' + Math.round(p[2]) + 'm'; // 精简格式, 不受语言影响
    positionHoverLabel([p[1], p[0]]);
    el.style.display = 'block';
    state.hoverLngLat = [p[1], p[0]]; // 记录当前坐标, 地图移动时跟随刷新
  }

  /* 用 map.project 把标签定位到红点屏幕坐标上方 */
  function positionHoverLabel(lngLat) {
    const el = document.getElementById('hoverLabel');
    if (!el) return;
    const screen = map.project(lngLat); // 地图容器内像素坐标
    el.style.left = screen.x + 'px';
    el.style.top = screen.y + 'px';
  }

  /* 隐藏浮动标签 */
  function hideHoverLabel() {
    const el = document.getElementById('hoverLabel');
    if (el) el.style.display = 'none';
    state.hoverLngLat = null;
  }

  /* 地图平移/缩放时, 若标签可见则跟随红点移动 */
  map.on('move', () => {
    if (!state.hoverLngLat) return;
    const el = document.getElementById('hoverLabel');
    if (el && el.style.display !== 'none') positionHoverLabel(state.hoverLngLat);
  });

  /* ============================================================
   * 10. 上传处理: 拖拽 + 点击
   * ============================================================ */
  function bindUpload() {
    const zone = document.getElementById('uploadZone');
    const input = document.getElementById('fileInput');

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', (e) => {
      if (e.target.files.length) handleFile(e.target.files[0]);
      input.value = ''; // 允许重复选择同一文件
    });

    // 监测半径调整
    const radius = document.getElementById('bufferRadius');
    if (radius) {
      radius.addEventListener('change', () => {
        if (!state.trailGeoJSON) return;
        generateBuffer(getBufferRadius());
        runHazardChecks(); // 半径变化后重新碰撞检测
      });
    }

    // 导出报告
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportReport);

    // 风寒计算按钮
    const calcBtn = document.getElementById('calcBtn');
    if (calcBtn) calcBtn.addEventListener('click', calcWindChill);
  }

  async function handleFile(file) {
    try {
      const { points, hasElevation } = await TrailGeo.parseFile(file);
      if (!hasElevation) await Weather.fillElevation(points); // 无海拔 → 高程 API 补齐
      // badge 显示上传文件名(去扩展名), 如 my-trail.gpx → my-trail
      const trailName = (file.name || '上传轨迹').replace(/\.[^.]+$/, '');
      showToast(t('toast.loaded.trail', { name: file.name, n: points.length }));
      loadTrail(points, trailName);
      switchView('hike'); // 上传完成后自动切回 Hike 视图(路线概况/预警/微气象在此)
    } catch (err) {
      showToast(t('toast.parse.fail', { msg: err.message }));
    }
  }

  /* ============================================================
   * 11. 报告导出 (jsPDF A4 多页 PDF: 统计/预警/微气象文本 + 地图/剖面/侧栏截图)
   *     地图用 MapLibre getCanvas() 直读; 侧栏用 html2canvas; 失败逐级降级打印
   * ============================================================ */
  async function exportReport() {
    const btn = document.getElementById('exportBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t('toast.exporting');
    try {
      // jsPDF 未加载 → 降级打印
      if (typeof jspdf === 'undefined') throw new Error('jsPDF 未加载');
      const { jsPDF } = jspdf;
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
      // 注意: jsPDF 默认字体(Helvetica)不含中文字形, PDF 文本层统一用英文渲染(ASCII 安全);
      // 中文内容由侧栏 html2canvas 截图完整呈现(像素级, 不受字体限制)
      const enT = (k, p) => {
        let v = I18N.en[k];
        if (v == null) v = I18N.zh[k]; // 英文缺失回退中文(可能乱码, 极少见)
        if (v == null) return k;
        if (p) Object.keys(p).forEach((kk) => { v = v.replace(new RegExp('\\{' + kk + '\\}', 'g'), p[kk]); });
        return v;
      };
      const enAlertText = (a) => {
        if (!a.key) return a.text || '';
        const p = Object.assign({}, a.params);
        if (a.key === 'alert.fire' && p.frp) p.frp = enT('alert.fire.frp', { frp: p.frp });
        return enT(a.key, p);
      };
      const pageW = 210, pageH = 297, margin = 12;
      let y = margin; // 当前页内容游标

      // 剩余空间不足时自动翻页
      const ensureSpace = (need) => {
        if (y + need > pageH - margin) { pdf.addPage(); y = margin; }
      };

      // ---- 标题 + 生成时间 ----
      pdf.setFontSize(17);
      pdf.setTextColor(233, 69, 96);
      pdf.text(enT('report.title'), margin, y); y += 7;
      pdf.setFontSize(9);
      pdf.setTextColor(130, 130, 130);
      const timeStr = new Date().toLocaleString(i18n.getLang() === 'zh' ? 'zh-CN' : 'en-US');
      pdf.text(enT('report.time', { time: timeStr }), margin, y); y += 7;

      // ---- 1. 轨迹统计(文本) ----
      pdf.setFontSize(12); pdf.setTextColor(30, 30, 30);
      pdf.text(enT('report.stats'), margin, y); y += 6;
      const statPairs = [
        ['stat.dist', 'statDistance'], ['stat.ascent', 'statElevation'], ['stat.descent', 'statDescent'],
        ['stat.maxEle', 'statMaxEle'], ['stat.minEle', 'statMinEle'], ['stat.points', 'statPoints']
      ];
      pdf.setFontSize(10); pdf.setTextColor(70, 70, 70);
      statPairs.forEach(([k, id]) => {
        ensureSpace(6);
        pdf.text(enT(k) + ': ' + (document.getElementById(id) ? document.getElementById(id).textContent : '--'), margin, y);
        y += 6;
      });
      y += 3;

      // ---- 2. 灾害碰撞预警(文本) ----
      pdf.setFontSize(12); pdf.setTextColor(30, 30, 30);
      ensureSpace(8); pdf.text(enT('report.alerts'), margin, y); y += 6;
      pdf.setFontSize(9); pdf.setTextColor(90, 90, 90);
      // 预警文本按结构化数据用英文重渲染(与 UI 当前语言解耦, 避免中文字形乱码)
      const pdfAlerts = [];
      state.hazardsAlerts.forEach((a) => pdfAlerts.push(enAlertText(a)));
      if (state.quakeData.i18nKey) pdfAlerts.push(enT(state.quakeData.i18nKey));
      if (state.fireData.i18nKey) pdfAlerts.push(enT(state.fireData.i18nKey, state.fireData.i18nParams));
      if (state.weatherData && state.weatherData.i18nKey) pdfAlerts.push(enT(state.weatherData.i18nKey));
      if (state.rainChecked && !state.rainFrames) pdfAlerts.push(enT('alert.rain.unreachable'));
      const alertTexts = pdfAlerts.length ? pdfAlerts : [enT('report.none')];
      alertTexts.forEach((txt) => {
        const wrapped = pdf.splitTextToSize(txt, pageW - 2 * margin);
        ensureSpace(wrapped.length * 4 + 2);
        pdf.text(wrapped, margin, y);
        y += wrapped.length * 4 + 2;
      });
      y += 3;

      // ---- 3. 微气象与风寒(文本) ----
      pdf.setFontSize(12); pdf.setTextColor(30, 30, 30);
      ensureSpace(8); pdf.text(enT('report.weather'), margin, y); y += 6;
      const wxPairs = [
        ['wx.peakEle', 'wxPeakEle'], ['wx.temp', 'wxTemp'], ['wx.gust', 'wxGust'], ['wx.uv', 'wxUV'],
        ['wx.soil', 'wxSoil'], ['wx.wc', 'wxWc'], ['wx.gust6h', 'wxGust6h'], ['wx.wc6h', 'wxWc6h'], ['wx.precip', 'wxPrecip']
      ];
      pdf.setFontSize(9); pdf.setTextColor(70, 70, 70);
      wxPairs.forEach(([k, id]) => {
        ensureSpace(5);
        pdf.text(enT(k) + ': ' + (document.getElementById(id) ? document.getElementById(id).textContent : '--'), margin, y);
        y += 5;
      });
      y += 3;

      // ---- 第 2 页: 横向排版(参考 Demo: 上部地图大图 + 下部左右两栏, 最大化利用 A4 横向) ----
      pdf.addPage('a4', 'l'); // 横向 A4: 297 × 210 mm (jsPDF 签名: addPage(format, orientation))
      const lw = 297, lh = 210, lm = 10;
      const colGap = 8;
      const colW = (lw - 2 * lm - colGap) / 2; // 左右栏宽度
      const leftX = lm, rightX = lm + colW + colGap;
      const bottomY = lh - lm; // 页底边界
      let yL = lm + 8, yR = lm + 8;

      // 上部: 地图大图(横贯页宽, 左右小边距)
      try {
        const mapCanvas = map.getCanvas();
        const mapImg = mapCanvas.toDataURL('image/png');
        const mw = lw - 2 * lm;
        const mh = mw * (mapCanvas.height / mapCanvas.width);
        pdf.addImage(mapImg, 'PNG', lm, lm, mw, mh);
        yL = lm + mh + 6;
        yR = lm + mh + 6;
      } catch (e) { /* 地图 canvas 被污染则只显示下方文字栏 */ }

      // ---- 左栏: 路线概况(海拔剖面图 + 轨迹统计) ----
      pdf.setFontSize(11); pdf.setTextColor(30, 30, 30);
      pdf.text(enT('trail.card'), leftX, yL); yL += 6;
      try {
        const chartCanvas = document.getElementById('elevationChart');
        if (chartCanvas && state.chart) {
          const img = chartCanvas.toDataURL('image/png');
          const ih = colW * (chartCanvas.height / chartCanvas.width);
          if (yL + ih < bottomY) { pdf.addImage(img, 'PNG', leftX, yL, colW, ih); yL += ih + 4; }
        }
      } catch (e) { /* 剖面截图失败则跳过 */ }
      pdf.setFontSize(8); pdf.setTextColor(70, 70, 70);
      statPairs.forEach(([k, id]) => {
        if (yL + 4 > bottomY) return;
        pdf.text(enT(k) + ': ' + (document.getElementById(id) ? document.getElementById(id).textContent : '--'), leftX, yL);
        yL += 4;
      });

      // ---- 右栏: 预警列表 + 微气象摘要 ----
      pdf.setFontSize(11); pdf.setTextColor(30, 30, 30);
      pdf.text(enT('report.alerts'), rightX, yR); yR += 6;
      pdf.setFontSize(8); pdf.setTextColor(90, 90, 90);
      alertTexts.forEach((txt) => {
        const wrapped = pdf.splitTextToSize(txt, colW - 4);
        if (yR + wrapped.length * 3.2 > bottomY) return;
        pdf.text(wrapped, rightX, yR);
        yR += wrapped.length * 3.2 + 1.5;
      });
      yR += 3;
      pdf.setFontSize(11); pdf.setTextColor(30, 30, 30);
      pdf.text(enT('report.weather'), rightX, yR); yR += 6;
      pdf.setFontSize(8); pdf.setTextColor(70, 70, 70);
      wxPairs.forEach(([k, id]) => {
        if (yR + 4 > bottomY) return;
        pdf.text(enT(k) + ': ' + (document.getElementById(id) ? document.getElementById(id).textContent : '--'), rightX, yR);
        yR += 4;
      });

      // ---- 第 3 页起: 侧栏 html2canvas 截图(纵向页, 长图分片插入, 自动分页) ----
      pdf.addPage('a4', 'p'); // 回到纵向
      y = margin;
      try {
        if (typeof html2canvas === 'undefined') throw new Error('html2canvas 未加载');
        const panelCanvas = await html2canvas(document.getElementById('sidePanel'), {
          backgroundColor: '#0a0a0f', scale: 1.5, useCORS: true, logging: false
        });
        const imgW = pageW - 2 * margin;
        const imgH = imgW * (panelCanvas.height / panelCanvas.width);
        const availH = pageH - margin - margin;
        let offY = 0;
        while (offY < imgH - 0.5) {
          const sliceH = Math.min(availH, imgH - offY);
          // 从完整画布裁剪一段, 避免长图直接 addImage 溢出页面
          const slice = document.createElement('canvas');
          slice.width = panelCanvas.width;
          slice.height = Math.max(1, Math.round(panelCanvas.height * (sliceH / imgH)));
          slice.getContext('2d').drawImage(
            panelCanvas, 0, Math.round(panelCanvas.height * (offY / imgH)),
            slice.width, slice.height, 0, 0, slice.width, slice.height
          );
          ensureSpace(sliceH);
          pdf.addImage(slice.toDataURL('image/png'), 'PNG', margin, y, imgW, sliceH);
          y += sliceH;
          offY += sliceH;
        }
      } catch (e) { /* 侧栏截图失败则跳过(文本摘要已覆盖) */ }

      // ---- 保存 PDF ----
      pdf.save('TravelerGuide_Report.pdf');
      showToast(t('toast.exported'));
    } catch (e) {
      // jsPDF 缺失或致命错误 → 降级为浏览器打印
      showToast(t('report.notloaded'));
      window.print();
    } finally {
      btn.disabled = false;
      btn.textContent = t('export.btn');
    }
  }

  /* ============================================================
   * 11.5 数据持久化: localStorage 保存/恢复上次分析状态
   * ============================================================ */
  const STATE_KEY = 'travelerTrailState';
  const MAX_POINTS_JSON = 3 * 1024 * 1024; // 轨迹点 JSON 超 3MB 时只存元数据

  /* 保存当前分析状态(轨迹点/预警/气象/统计/缓冲半径/语言/时间戳) */
  function saveTrailState() {
    try {
      if (!state.points || !state.points.length) return;
      const payload = {
        v: 1,
        savedAt: Date.now(),
        trailName: state.trailName || '',
        bufferRadius: getBufferRadius(),
        lang: (function () { try { return localStorage.getItem('lang') || 'zh'; } catch (e) { return 'zh'; } })(),
        points: state.points,
        alerts: state.hazardsAlerts || [],
        weather: state.weatherData || null,
        stats: {
          dist: document.getElementById('statDistance') ? document.getElementById('statDistance').textContent : '--',
          ascent: document.getElementById('statElevation') ? document.getElementById('statElevation').textContent : '--',
          descent: document.getElementById('statDescent') ? document.getElementById('statDescent').textContent : '--',
          maxEle: document.getElementById('statMaxEle') ? document.getElementById('statMaxEle').textContent : '--',
          minEle: document.getElementById('statMinEle') ? document.getElementById('statMinEle').textContent : '--',
          points: document.getElementById('statPoints') ? document.getElementById('statPoints').textContent : '--'
        }
      };
      let json = JSON.stringify(payload);
      // 轨迹点过大(localStorage 5MB 限制) → 丢弃轨迹点, 仅保留元数据
      if (json.length > MAX_POINTS_JSON) {
        delete payload.points;
        payload.pointsOmitted = true;
        json = JSON.stringify(payload);
      }
      localStorage.setItem(STATE_KEY, json);
    } catch (e) {
      console.warn('分析状态保存失败:', e);
    }
  }

  /* 读取上次保存的分析状态; 无效(无轨迹点)时返回 null */
  function restoreTrailState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.points || !data.points.length) return null;
      return data;
    } catch (e) {
      console.warn('分析状态恢复失败:', e);
      return null;
    }
  }

  /* ============================================================
   * 12. Toast 提示
   * ============================================================ */
  function showToast(msg, ms) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }

  /* ============================================================
   * 13. PWA: Service Worker 注册 (仅 http/https 环境)
   * ============================================================ */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const proto = location.protocol;
    if (proto !== 'https:' && proto !== 'http:') return; // file:// 跳过
    // 版本化注册: 新 URL(sw.js?v=11)绕过旧 SW 缓存, 强制更新 SW
    navigator.serviceWorker.register('sw.js?v=11').then((reg) => {
      // 检测到新版本 SW(如 CACHE_NAME bump 后) → 自动刷新加载新版资源,
      // 解决"改版后浏览器一直显示旧缓存"的问题(2026-08-16)
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
            showToast(t('toast.sw.reload'));
            setTimeout(() => location.reload(), 600);
          }
        });
      });
    }).catch(() => { /* 注册失败不影响使用 */ });
  }

  /* ============================================================
   * 14. 视图切换: Hike(默认, 态势感知) / Discover(探索路线)
   *     Gaia GPS 风格左侧垂直导航栏; 切换时联动 .nav-item.active
   *     与侧栏 .view-panel 的显隐。
   * ============================================================ */

  /* Discover 面板内置示例路线(雨崩为真实 GPX, 其余为简化坐标模拟, 海拔用正弦曲线模拟) */
  const DISCOVER_TRAILS = {
    yubeng: {
      name: '雨崩·神湖徒步',
      points: () => loadYubengPoints() // 真实 GPX(异步 fetch+解析), 失败降级内置精简点
    },
  };

  /* 视图切换: 联动左侧导航高亮 + 侧栏面板显隐 */
  function switchView(view) {
    document.querySelectorAll('.app-nav .nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    document.querySelectorAll('.view-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.view === view);
    });
  }

  /* 绑定导航按钮 + Discover 推荐路线加载 */
  function bindNav() {
    document.querySelectorAll('.app-nav .nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Discover 推荐路线: 加载示例轨迹到地图后自动切回 Hike 视图并触发检测
    document.querySelectorAll('[data-trail]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const trail = DISCOVER_TRAILS[btn.dataset.trail];
        if (!trail) return;
        const pts = await trail.points(); // 支持同步数组与异步 Promise(雨崩 GPX)
        loadTrail(pts, trail.name); // badge 同步为路线名
        switchView('hike');
        showToast(t('toast.route', { name: trail.name }));
      });
    });
  }

  /* ============================================================
   * 15. 启动
   * ============================================================ */
  function init() {
    i18n.init(); // 读取 localStorage 语言偏好并应用静态文案
    bindUpload();
    bindLayerPopups();
    bindNav();

    // 3D 模式按钮: 动态 import js/3d.js(ES Module, three/plugin 按需加载), 失败优雅降级 2D
    const btn3d = document.getElementById('btn3d');
    if (btn3d) {
      btn3d.addEventListener('click', async () => {
        try {
          // 动态 import: 非模块脚本中相对路径会相对脚本 URL 解析, 裸说明符会走 importmap;
          // 用 document.baseURI 构造绝对 URL 最稳(兼容子路径部署), three 由 importmap 解析
          const mod = await import(new URL('js/3d.js', document.baseURI).href);
          await mod.toggle3D();
        } catch (e) {
          console.warn('3D 模块加载失败, 保持 2D 模式:', e);
          showToast(t('toast.3d.unavailable'));
        }
      });
    }

    // 语言切换按钮: 中文界面显示「EN」, 英文界面显示「中」, 即时生效并持久化
    const langBtn = document.getElementById('langBtn');
    if (langBtn) {
      langBtn.addEventListener('click', () => {
        i18n.setLang(i18n.getLang() === 'zh' ? 'en' : 'zh');
      });
    }
    // 语言切换后刷新动态面板(预警/微气象/检测状态)
    i18n.onChange(() => {
      updateRiskPanel();
      updateWeatherPanel();
      if (state.points) {
        setDetectStatus(state.detecting ? t('status.detecting') : t('status.updated', { time: state.lastUpdatedTime || '' }), state.detecting);
      }
    });

    // 快捷键 R: 手动刷新风险检测
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'r' || e.key === 'R') && state.points) {
        showToast(t('toast.refresh'));
        runHazardChecks();
      }
    });

    registerSW();

    // 启动: 优先恢复上次分析状态; 无存档则加载默认雨崩示例
    setTimeout(() => {
      const saved = restoreTrailState();
      if (saved) {
        // 先恢复已保存的预警/气象(立即展示), 再加载轨迹并刷新检测
        state.hazardsAlerts = saved.alerts || [];
        state.weatherData = saved.weather || null;
        if (saved.bufferRadius) {
          const sel = document.getElementById('bufferRadius');
          if (sel && ['5', '10', '20', '30'].indexOf(String(saved.bufferRadius)) !== -1) sel.value = saved.bufferRadius;
        }
        if (saved.lang && i18n.getLang() !== saved.lang) i18n.setLang(saved.lang); // 恢复语言偏好
        updateRiskPanel();
        updateWeatherPanel();
        loadTrail(saved.points, saved.trailName || '');
        // 统计以保存值为准(loadTrail 会重算, 双保险)
        if (saved.stats) {
          setText('statDistance', saved.stats.dist);
          setText('statElevation', saved.stats.ascent);
          setText('statDescent', saved.stats.descent);
          setText('statMaxEle', saved.stats.maxEle);
          setText('statMinEle', saved.stats.minEle);
          setText('statPoints', saved.stats.points);
        }
        showToast(t('toast.restored'));
      } else {
        loadYubeng();
        showToast(t('toast.yubeng'));
      }
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 暴露给控制台调试 */
  window.TrailSense = { state, map, loadTrail, loadYubeng, loadWugongshan, updateRiskPanel, calcWindChill, exportReport, switchView, DISCOVER_TRAILS, setTrailBadge };
})();
