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
    trailGeoJSON: null,     // 轨迹 FeatureCollection
    lineCoords: null,       // [[lng,lat,ele?],...]
    bufferGeoJSON: null,    // 缓冲区 Feature
    bufferLabel: null,      // 缓冲区标签 DOM Marker
    chart: null,            // Chart.js 实例
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
        'cartodb': {
          type: 'raster',
          tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{ratio}.png'], // {ratio}→@2x (高分屏)
          tileSize: 256,
          maxzoom: 19,
          attribution: '© CARTO © OSM'
        }
      },
      layers: [
        { id: 'basemap-topo', type: 'raster', source: 'opentopomap', minzoom: 0, maxzoom: 22 },
        { id: 'basemap-satellite', type: 'raster', source: 'esri', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' } },
        { id: 'basemap-dark', type: 'raster', source: 'cartodb', minzoom: 0, maxzoom: 22, layout: { visibility: 'none' } }
      ]
    },
    center: [114.18, 27.52], // [lng, lat]
    zoom: 12,
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
  const LAYER_ORDER = ['contour', 'buffer', 'gibs-fires', 'fires', 'quakes', 'trail', 'rain-layer'];

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
  const BASEMAP_LAYER = { topo: 'basemap-topo', satellite: 'basemap-satellite', dark: 'basemap-dark' };
  let currentBasemap = 'topo';

  document.querySelectorAll('[data-basemap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-basemap]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const key = btn.dataset.basemap;
      // 切换三个预定义底图图层的 visibility, 不重建地图
      Object.values(BASEMAP_LAYER).forEach((id) => map.setLayoutProperty(id, 'visibility', 'none'));
      map.setLayoutProperty(BASEMAP_LAYER[key], 'visibility', 'visible');
      currentBasemap = key;
    });
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
        showToast('🌧️ 雨带雷达数据源不可达, 已自动关闭');
        state.layers.rain = false;
        updateLayerBtn('rain');
      } else {
        showToast('🌧️ 正在获取雨带雷达数据...');
        Weather.fetchRainRadar().then((frames) => {
          state.rainChecked = true;
          state.rainFrames = frames;
          if (state.layers.rain) {
            if (frames) startRain();
            else {
              showToast('🌧️ 雨带雷达数据源不可达, 已自动关闭');
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
    if (state.rainPlayer) showToast('🌧️ 雨带推演已开启(未来 2 小时)');
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
  function loadWugongshan() {
    const pts = TrailGeo.generateWugongshanTrail();
    loadTrail(pts);
  }

  async function loadTrail(points) {
    state.points = points;

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

      // 绘制轨迹线 (line layer)
      setGeoJSONLayer('trail', geojson, {
        type: 'line',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#e94560', 'line-width': 4, 'line-opacity': 0.9 }
      });

      // 起点/终点 DOM 标记 + popup
      const c0 = points[0], cN = points[points.length - 1];
      addDivMarker('<span style="font-size:20px; line-height:1;">🟢</span>', [c0[1], c0[0]], {
        popup: '<strong>起点</strong><br><span style="font-size:11px;color:#999;">' + c0[0].toFixed(5) + ', ' + c0[1].toFixed(5) + '</span>'
      });
      addDivMarker('<span style="font-size:20px; line-height:1;">🔴</span>', [cN[1], cN[0]], {
        popup: '<strong>终点</strong><br><span style="font-size:11px;color:#999;">' + cN[0].toFixed(5) + ', ' + cN[1].toFixed(5) + '</span>'
      });

      // 武功山景点标记 (锚点底部, 模拟 Leaflet iconAnchor 效果)
      TrailGeo.SCENIC_SPOTS.forEach((spot) => {
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
        + 'padding:2px 8px;border-radius:20px;font-size:11px;white-space:nowrap;">📡 ' + km + 'km 监测区</span>',
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
    setDetectStatus('检测中...', true);

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

    setDetectStatus('已更新 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), false);
    state.detecting = false;
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
          popup: '<strong>M' + (q.mag != null ? q.mag.toFixed(1) : '?') + ' 地震</strong><br>'
            + (q.place || '未知位置') + '<br>深度 ' + (q.depth || 0).toFixed(1) + 'km'
            + (inside ? '<br><span style="color:#e74c3c;">⚠️ 位于监测缓冲区' + getBufferRadius() + 'km内</span>' : '')
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
          popup: '<strong>🔥 卫星山火热点</strong><br>'
            + 'FRP ' + Math.round(f.frp || 0) + ' MW'
            + (inside ? '<br><span style="color:#e74c3c;">⚠️ 位于监测缓冲区' + getBufferRadius() + 'km内</span>' : '')
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

  /* ============================================================
   * 7. 风险面板: 红黄绿灯 + 预警列表
   * ============================================================ */
  function updateRiskPanel() {
    const alerts = [];

    // 1) 灾害碰撞检测结果
    state.hazardsAlerts.forEach((a) => alerts.push(a));

    // 2) 微气象风险
    const w = state.weatherData;
    if (w && w.status === 'ok') {
      // 失温预警: 体感 < 0°C
      if (w.windChill != null && w.windChill < 0) {
        alerts.push({ level: 'danger', icon: '🥶', text: '最高点体感风寒 ' + w.windChill.toFixed(1) + '°C < 0°C, 存在失温风险, 需加强保暖', source: 'Open-Meteo' });
      } else if (w.windChill != null && w.windChill < 5) {
        alerts.push({ level: 'warning', icon: '🧊', text: '最高点体感风寒 ' + w.windChill.toFixed(1) + '°C, 体感偏冷', source: 'Open-Meteo' });
      }
      // 阵风: ≥8级(62km/h)预警
      if (w.maxGust6h != null && w.maxGust6h >= 62) {
        alerts.push({
          level: w.maxGust6h >= 89 ? 'danger' : 'warning', icon: '💨',
          text: '未来 6 小时阵风最大 ' + Math.round(w.maxGust6h) + ' km/h (≥' + (w.maxGust6h >= 89 ? '10级' : '8级') + '), 注意横风与失温', source: 'Open-Meteo'
        });
      }
      // UV
      if (w.uv != null && w.uv >= 8) {
        alerts.push({ level: 'warning', icon: '☀️', text: 'UV 指数 ' + w.uv.toFixed(1) + ', 高海拔紫外线强烈, 注意防晒', source: 'Open-Meteo' });
      }
      // 土壤湿度(泥泞/滑坡)
      if (w.soil != null && w.soil >= 0.55) {
        alerts.push({ level: 'warning', icon: '🟤', text: '土壤湿度 ' + Math.round(w.soil * 100) + '%, 路面泥泞, 滑坡风险升高', source: 'Open-Meteo' });
      }
      // 天气代码
      const codeAlert = Weather.describeCode(w.code);
      if (codeAlert) alerts.push({ level: codeAlert.level, icon: codeAlert.icon, text: codeAlert.text, source: 'Open-Meteo' });
    }

    // 3) 数据源降级提示(灰色 info)
    if (state.quakeData.status === 'unreachable') {
      alerts.push({ level: 'info', icon: '📡', text: state.quakeData.message, source: 'USGS' });
    }
    if (state.fireData.status === 'degraded') {
      alerts.push({ level: 'info', icon: '📡', text: state.fireData.message, source: 'NASA' });
    }
    if (w && w.status === 'unreachable') {
      alerts.push({ level: 'info', icon: '📡', text: w.message, source: 'Open-Meteo' });
    }
    if (state.rainChecked && !state.rainFrames) {
      alerts.push({ level: 'info', icon: '📡', text: 'RainViewer 雨带雷达数据源不可达, 雨带图层不可用', source: 'RainViewer' });
    }

    // 4) 渲染列表
    const container = document.getElementById('alertList');
    if (!alerts.length) {
      container.innerHTML = '<div class="alert-item safe"><span>✅</span><span class="txt">暂无风险 · 周边 ' + getBufferRadius() + 'km 内未检测到灾害</span></div>';
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
    if (hasDanger) { dot.className = 'risk-dot danger'; label.textContent = '综合风险: 高危'; }
    else if (hasWarning) { dot.className = 'risk-dot warning'; label.textContent = '综合风险: 注意'; }
    else { dot.className = 'risk-dot safe'; label.textContent = '综合风险: 安全'; }

    // 数据源状态摘要
    const src = document.getElementById('sourceStatus');
    const st = [];
    st.push(state.quakeData.status === 'ok' ? '✅ USGS' : (state.quakeData.status === 'unreachable' ? '❌ USGS' : '⏳ USGS'));
    st.push(state.fireData.status === 'ok' ? '✅ NASA' : (state.fireData.status === 'degraded' ? '⚠️ NASA' : '⏳ NASA'));
    st.push(w && w.status === 'ok' ? '✅ Open-Meteo' : (w && w.status === 'unreachable' ? '❌ Open-Meteo' : '⏳ Open-Meteo'));
    st.push(state.rainChecked ? (state.rainFrames ? '✅ RainViewer' : '❌ RainViewer') : '⏳ RainViewer');
    src.textContent = st.join(' · ');
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
    setText('wxUV', w && w.uv != null ? w.uv.toFixed(1) : (w && w.status === 'unreachable' ? '不可达' : '--'));
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
   * 9. 海拔剖面图 (Chart.js)
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

    // 采样 ≤ 80 点, x 轴为累计距离(km)
    const step = Math.max(1, Math.ceil(points.length / 80));
    const sampled = [];
    let acc = 0;
    let prev = null;
    points.forEach((p, i) => {
      if (prev) acc += TrailGeo.haversineKm(prev[0], prev[1], p[0], p[1]);
      prev = p;
      if (i % step === 0 || i === points.length - 1) sampled.push({ d: acc, e: p[2] });
    });

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
          tooltip: { callbacks: { label: (c) => c.parsed.y + ' m' } }
        },
        scales: {
          x: { display: false },
          y: {
            display: true,
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: 'rgba(255,255,255,0.3)', font: { size: 9 } },
            beginAtZero: false
          }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  }

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

    // FIRMS API Key 保存
    const keyInput = document.getElementById('firmsKeyInput');
    const keySave = document.getElementById('firmsKeySave');
    if (keyInput && keySave) {
      try { keyInput.value = localStorage.getItem('firmsMapKey') || ''; } catch (e) { /* ignore */ }
      keySave.addEventListener('click', () => {
        try { localStorage.setItem('firmsMapKey', keyInput.value.trim()); } catch (e) { /* ignore */ }
        showToast('✅ FIRMS API Key 已保存(下次检测生效)');
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
      showToast('📂 已加载轨迹: ' + file.name + ' (' + points.length + ' 点)');
      loadTrail(points);
    } catch (err) {
      showToast('❌ 解析失败: ' + err.message);
    }
  }

  /* ============================================================
   * 11. 报告导出 (html2canvas 截图 → PNG; 失败降级打印)
   * ============================================================ */
  async function exportReport() {
    const btn = document.getElementById('exportBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    try {
      if (typeof html2canvas === 'undefined') throw new Error('html2canvas 未加载');
      const canvas = await html2canvas(document.getElementById('app'), {
        backgroundColor: '#0a0a0f',
        scale: Math.min(2, window.devicePixelRatio || 1.5),
        useCORS: true,
        logging: false
      });
      const url = canvas.toDataURL('image/png');
      // 触发下载
      const a = document.createElement('a');
      a.download = 'trail-safety-report-' + new Date().toISOString().slice(0, 10) + '.png';
      a.href = url;
      a.click();
      showToast('📄 报告已生成并下载');
    } catch (e) {
      // MapLibre 的 WebGL canvas 通常无法被 html2canvas 读取(跨域纹理污染) → 降级为打印
      showToast('截图受 WebGL/跨域瓦片影响, 已切换为打印模式 (Ctrl+P 保存 PDF)');
      window.print();
    } finally {
      btn.disabled = false;
      btn.textContent = '📄 导出报告';
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
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // 检测到新版本 SW(如 CACHE_NAME bump 后) → 自动刷新加载新版资源,
      // 解决"改版后浏览器一直显示旧缓存"的问题(2026-08-16)
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
            showToast('🔄 检测到新版本, 正在刷新...');
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

  /* Discover 面板内置示例路线(简化坐标模拟, 海拔用正弦曲线模拟) */
  const DISCOVER_TRAILS = {
    wugongshan: {
      name: '武功山反穿',
      points: () => TrailGeo.generateWugongshanTrail() // 复用既有示例生成器
    },
    fuji: {
      name: '富士山吉田路线',
      // 起点: 富士吉田口五合目 (35.4877, 138.8078) → 山顶 (35.3606, 138.7274)
      points: () => {
        const pts = [];
        const sLat = 35.4877, sLng = 138.8078;
        const eLat = 35.3606, eLng = 138.7274;
        const steps = 120;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const lat = sLat + (eLat - sLat) * t + Math.sin(t * 12) * 0.004;
          const lng = sLng + (eLng - sLng) * t + Math.cos(t * 9) * 0.003;
          // 海拔: 五合目 2305m → 山顶 3776m → 回落
          const ele = 2305 + 1471 * Math.sin(t * Math.PI) + 120 * Math.sin(t * 5) + 40 * Math.cos(t * 3);
          pts.push([lat, lng, Math.round(ele)]);
        }
        return pts;
      }
    },
    halfdome: {
      name: '优胜美地半圆顶',
      // 起点: 优胜美地谷地 trailhead (37.7427, -119.5819) → 半圆顶 (37.7462, -119.5332)
      points: () => {
        const pts = [];
        const sLat = 37.7427, sLng = -119.5819;
        const eLat = 37.7462, eLng = -119.5332;
        const steps = 120;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const lat = sLat + (eLat - sLat) * t + Math.sin(t * 11) * 0.0025;
          const lng = sLng + (eLng - sLng) * t + Math.cos(t * 8) * 0.002;
          // 海拔: 谷底 1219m → 穹顶 2695m
          const ele = 1219 + 1476 * Math.sin(t * Math.PI) + 100 * Math.sin(t * 6);
          pts.push([lat, lng, Math.round(ele)]);
        }
        return pts;
      }
    }
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
      btn.addEventListener('click', () => {
        const trail = DISCOVER_TRAILS[btn.dataset.trail];
        if (!trail) return;
        const pts = trail.points();
        loadTrail(pts);
        switchView('hike');
        showToast('🧭 已加载「' + trail.name + '」, 正在检测周边灾害...');
      });
    });
  }

  /* ============================================================
   * 15. 启动
   * ============================================================ */
  function init() {
    bindUpload();
    bindLayerPopups();
    bindNav();

    // 快捷键 R: 手动刷新风险检测
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'r' || e.key === 'R') && state.points) {
        showToast('🔄 手动刷新灾害检测...');
        runHazardChecks();
      }
    });

    registerSW();

    // 自动加载武功山示例并触发检测(等地图样式加载完成)
    setTimeout(() => {
      loadWugongshan();
      showToast('🏔️ 已加载武功山反穿示例, 正在检测周边灾害...');
    }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 暴露给控制台调试 */
  window.TrailSense = { state, map, loadTrail, loadWugongshan, updateRiskPanel, calcWindChill, exportReport, switchView, DISCOVER_TRAILS };
})();
