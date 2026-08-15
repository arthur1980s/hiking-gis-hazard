/* ============================================================
 * app.js — 应用主逻辑 (初始化 / 轨迹加载 / 灾害检测 / 风险面板 / 导出)
 * 依赖: Leaflet(L) + Turf(turf) + Chart.js(Chart) + html2canvas,
 *       TrailGeo(geo.js) + Hazards(hazards.js) + Weather(weather.js)
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
    chart: null,            // Chart.js 实例
    markers: { fires: [], quakes: [] },
    layers: { fires: true, quakes: true, buffer: true, contour: false, rain: false },
    quakeData: { items: [], status: 'pending' },
    fireData: { points: [], status: 'pending', tileLayer: null },
    weatherData: null,
    hazardsAlerts: [],
    rainFrames: null,       // RainViewer 帧列表
    rainChecked: false,     // 雨带是否已尝试获取
    rainPlayer: null,       // 雨带播放器句柄
    contourLayer: null,
    detecting: false,
    toastTimer: null
  };

  /* ============================================================
   * 2. 地图初始化
   * ============================================================ */
  const map = L.map('map', { center: [27.52, 114.18], zoom: 12, zoomControl: true });

  // 三种底图
  const basemaps = {
    topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)'
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18, attribution: '© Esri World Imagery'
    }),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, attribution: '© CARTO © OSM'
    })
  };
  let currentBasemap = 'topo';
  basemaps.topo.addTo(map);

  // 图层组: 轨迹/缓冲区/山火/地震/雨带/景点
  const layerGroups = {
    trail: L.layerGroup().addTo(map),
    buffer: L.layerGroup().addTo(map),
    fires: L.layerGroup().addTo(map),
    quakes: L.layerGroup().addTo(map),
    rain: L.layerGroup().addTo(map),
    scenic: L.layerGroup().addTo(map)
  };

  /* 地图状态栏: 鼠标坐标 + 缩放级别 */
  map.on('mousemove', (e) => {
    document.getElementById('mapStatusbar').textContent =
      '📍 ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5) +
      ' · Zoom ' + map.getZoom();
  });

  /* ============================================================
   * 3. 控件: 底图切换 + 图层开关
   * ============================================================ */
  document.querySelectorAll('[data-basemap]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-basemap]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const key = btn.dataset.basemap;
      Object.values(basemaps).forEach((l) => map.removeLayer(l));
      basemaps[key].addTo(map);
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

    const group = layerGroups[type];
    if (!group) return;
    if (state.layers[type]) map.addLayer(group); else map.removeLayer(group);
  }

  /* 等高线图层: OpenTopoMap 半透明叠加(任意底图上显示等高线/地形) */
  function handleContourToggle() {
    if (state.layers.contour) {
      if (!state.contourLayer) {
        state.contourLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          maxZoom: 17, opacity: 0.55, attribution: '© OpenTopoMap'
        });
      }
      map.addLayer(state.contourLayer);
    } else if (state.contourLayer) {
      map.removeLayer(state.contourLayer);
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
   * 4. 轨迹加载主流程
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
    state.lineCoords = geojson.features[0].geometry.coordinates;

    // 清空旧图层
    Object.values(layerGroups).forEach((g) => g.clearLayers());
    state.markers = { fires: [], quakes: [] };

    // 绘制轨迹线
    L.geoJSON(geojson, {
      style: { color: '#e94560', weight: 4, opacity: 0.9 }
    }).addTo(layerGroups.trail);

    // 起点/终点标记
    const c0 = points[0], cN = points[points.length - 1];
    L.marker([c0[0], c0[1]], { icon: L.divIcon({ html: '🟢', className: 'marker-icon', iconSize: [22, 22] }) })
      .addTo(layerGroups.trail).bindPopup('<strong>起点</strong><br><span style="font-size:11px;color:#999;">' + c0[0].toFixed(5) + ', ' + c0[1].toFixed(5) + '</span>');
    L.marker([cN[0], cN[1]], { icon: L.divIcon({ html: '🔴', className: 'marker-icon', iconSize: [22, 22] }) })
      .addTo(layerGroups.trail).bindPopup('<strong>终点</strong><br><span style="font-size:11px;color:#999;">' + cN[0].toFixed(5) + ', ' + cN[1].toFixed(5) + '</span>');

    // 武功山景点标记
    const spotIcon = L.divIcon({
      html: '⛰️', className: 'spot-marker', iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -28]
    });
    TrailGeo.SCENIC_SPOTS.forEach((spot) => {
      L.marker([spot.lat, spot.lng], { icon: spotIcon })
        .addTo(layerGroups.scenic)
        .bindPopup('<strong>' + spot.name + '</strong><br><span style="font-size:12px;color:#999;">' + spot.desc + '</span>');
    });

    // 轨迹统计
    const stats = TrailGeo.computeStats(points);
    document.getElementById('statDistance').textContent = stats.distKm.toFixed(1);
    document.getElementById('statElevation').textContent = stats.hasElevation ? Math.round(stats.ascent) + 'm' : '--';
    document.getElementById('statDescent').textContent = stats.hasElevation ? Math.round(stats.descent) + 'm' : '--';
    document.getElementById('statMaxEle').textContent = stats.hasElevation ? Math.round(stats.maxEle) + 'm' : '--';
    document.getElementById('statMinEle').textContent = stats.hasElevation ? Math.round(stats.minEle) + 'm' : '--';
    document.getElementById('statPoints').textContent = points.length;

    // 缓冲区 + 视野适配
    generateBuffer(getBufferRadius());
    map.fitBounds(L.geoJSON(geojson).getBounds(), { padding: [60, 60], maxZoom: 13 });

    // 海拔剖面图
    drawElevationChart(points);

    // 自动触发灾害检测(并发, 不阻塞页面)
    runHazardChecks();
  }

  /* 读取监测半径(默认 10km) */
  function getBufferRadius() {
    const el = document.getElementById('bufferRadius');
    return el ? parseFloat(el.value) || 10 : 10;
  }

  /* ---------- 10km 缓冲区 ---------- */
  function generateBuffer(km) {
    layerGroups.buffer.clearLayers();
    if (!state.trailGeoJSON) return;
    try {
      const buffered = TrailGeo.makeBuffer(state.trailGeoJSON, km);
      state.bufferGeoJSON = buffered;
      L.geoJSON(buffered, {
        style: { color: '#f5c518', weight: 2, opacity: 0.6, fillColor: '#f5c518', fillOpacity: 0.08, dashArray: '6 4' }
      }).addTo(layerGroups.buffer);
      const c = turf.center(buffered);
      L.marker([c.geometry.coordinates[1], c.geometry.coordinates[0]], {
        icon: L.divIcon({ html: '📡 ' + km + 'km 监测区', className: 'buffer-label', iconSize: [120, 24] })
      }).addTo(layerGroups.buffer);
      if (!state.layers.buffer) map.removeLayer(layerGroups.buffer);
    } catch (e) {
      console.warn('缓冲区生成失败:', e);
    }
  }

  /* ============================================================
   * 5. 灾害检测: 并发抓取 地震 + 山火 + 微气象, 再碰撞计算
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

    // 渲染地震/山火标记
    renderQuakeMarkers(quakeRes.items);
    renderFireMarkers(fireRes.points);

    // GIBS 卫星热异常瓦片加入山火图层组(尽力而为, 无需 Key)
    if (fireRes.tileLayer) {
      layerGroups.fires.addLayer(fireRes.tileLayer);
      if (!state.layers.fires) map.removeLayer(layerGroups.fires);
    }

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

  /* ---------- 地震标记 ---------- */
  function renderQuakeMarkers(items) {
    layerGroups.quakes.clearLayers();
    state.markers.quakes = [];
    items.forEach((q) => {
      const inside = state.bufferGeoJSON && TrailGeo.pointInPolygon([q.lat, q.lng], state.bufferGeoJSON);
      const m = L.circleMarker([q.lat, q.lng], {
        radius: Math.min(6 + (q.mag || 3) * 1.6, 16),
        color: '#ff6b6b', weight: 2, opacity: 0.9,
        fillColor: '#ff6b6b', fillOpacity: inside ? 0.75 : 0.3
      });
      m.bindPopup('<strong>M' + (q.mag != null ? q.mag.toFixed(1) : '?') + ' 地震</strong><br>'
        + (q.place || '未知位置') + '<br>深度 ' + (q.depth || 0).toFixed(1) + 'km'
        + (inside ? '<br><span style="color:#e74c3c;">⚠️ 位于监测缓冲区' + getBufferRadius() + 'km内</span>' : '')
        + '<br><span style="font-size:11px;color:#999;">' + new Date(q.time).toLocaleString('zh-CN') + '</span>');
      m.addTo(layerGroups.quakes);
      state.markers.quakes.push(m);
    });
    if (state.layers.quakes) map.addLayer(layerGroups.quakes);
  }

  /* ---------- 山火标记 ---------- */
  function renderFireMarkers(points) {
    layerGroups.fires.clearLayers(); // 注意: 会清掉 GIBS 瓦片, 需重新添加
    state.markers.fires = [];
    points.forEach((f) => {
      const inside = state.bufferGeoJSON && TrailGeo.pointInPolygon([f.lat, f.lng], state.bufferGeoJSON);
      const m = L.circleMarker([f.lat, f.lng], {
        radius: inside ? 13 : 9,
        color: '#ff6b35', weight: 2, opacity: 0.9,
        fillColor: '#ff6b35', fillOpacity: inside ? 0.75 : 0.35
      });
      m.bindPopup('<strong>🔥 卫星山火热点</strong><br>'
        + 'FRP ' + Math.round(f.frp || 0) + ' MW'
        + (inside ? '<br><span style="color:#e74c3c;">⚠️ 位于监测缓冲区' + getBufferRadius() + 'km内</span>' : '')
        + '<br><span style="font-size:11px;color:#999;">' + (f.time || '') + '</span>');
      m.addTo(layerGroups.fires);
      state.markers.fires.push(m);
    });
    // 重新叠加 GIBS 瓦片(保持显示层级在点之下)
    if (state.fireData.tileLayer) {
      state.fireData.tileLayer.setZIndex && state.fireData.tileLayer.setZIndex(400);
      layerGroups.fires.addLayer(state.fireData.tileLayer);
    }
    if (state.layers.fires) map.addLayer(layerGroups.fires);
  }

  /* ============================================================
   * 6. 风险面板: 红黄绿灯 + 预警列表
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
   * 7. 微气象面板 + 风寒计算器
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
   * 8. 海拔剖面图 (Chart.js)
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
   * 9. 上传处理: 拖拽 + 点击
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
   * 10. 报告导出 (html2canvas 截图 → PNG; 失败降级打印)
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
      // 瓦片跨域可能污染 canvas → 降级为浏览器打印
      showToast('截图受跨域瓦片影响, 已切换为打印模式 (Ctrl+P 保存 PDF)');
      window.print();
    } finally {
      btn.disabled = false;
      btn.textContent = '📄 导出报告';
    }
  }

  /* ============================================================
   * 11. Toast 提示
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
   * 12. PWA: Service Worker 注册 (仅 http/https 环境)
   * ============================================================ */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const proto = location.protocol;
    if (proto !== 'https:' && proto !== 'http:') return; // file:// 跳过
    navigator.serviceWorker.register('sw.js').catch(() => { /* 注册失败不影响使用 */ });
  }

  /* ============================================================
   * 13. 启动
   * ============================================================ */
  function init() {
    bindUpload();

    // 快捷键 R: 手动刷新风险检测
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'r' || e.key === 'R') && state.points) {
        showToast('🔄 手动刷新灾害检测...');
        runHazardChecks();
      }
    });

    registerSW();

    // 自动加载武功山示例并触发检测
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
  window.TrailSense = { state, map, loadTrail, loadWugongshan, updateRiskPanel, calcWindChill, exportReport };
})();
