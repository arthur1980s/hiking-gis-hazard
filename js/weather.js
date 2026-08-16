/* ============================================================
 * weather.js — 山地微气象与风寒指数模块 (Mountain Micro-Climate)
 * 真实数据源:
 *   · Open-Meteo: 轨迹最高点实时温度/阵风/UV/土壤湿度 + 未来 6h 阵风
 *   · RainViewer: 雨带雷达帧 (past + nowcast, 可轮播动画)
 * 风寒公式(规格):
 *   WindChill = 13.12 + 0.6215·T − 11.37·V^0.16 + 0.3965·T·V^0.16
 *   T: 气温 °C, V: 10m 风速 km/h (风速过低时公式不适用, 直接返回气温)
 * 所有请求 8s 超时 + 优雅降级。
 * ============================================================ */
const Weather = (function () {
  'use strict';

  const TIMEOUT_MS = 8000;

  /* ---------- 带超时的 fetch ---------- */
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

  /* ============================================================
   * 1. 风寒指数计算 (规格公式)
   * ============================================================ */
  function calcWindChill(tempC, windKmh) {
    if (tempC == null || windKmh == null || isNaN(tempC) || isNaN(windKmh)) return null;
    // 加拿大环境部标准: 风速 < 4.8 km/h 时公式不适用, 体感≈气温
    if (windKmh < 4.8) return tempC;
    const v = Math.pow(windKmh, 0.16);
    return 13.12 + 0.6215 * tempC - 11.37 * v + 0.3965 * tempC * v;
  }

  /* ---------- WMO weather_code 描述与风险分级 (key 供 i18n 渲染, text 中文兜底) ---------- */
  function describeCode(code) {
    if (code == null) return null;
    const rules = [
      { codes: [96, 99], level: 'danger', key: 'hail', icon: '⛈️', text: '雷暴伴冰雹, 山脊线极度危险' },
      { codes: [95], level: 'warning', key: 'thunder', icon: '⛈️', text: '雷暴天气, 注意山顶雷击' },
      { codes: [65, 67], level: 'warning', key: 'rainheavy', icon: '🌧️', text: '强降雨/冻雨, 警惕山洪与泥石流' },
      { codes: [82], level: 'warning', key: 'shower', icon: '🌧️', text: '强阵雨, 注意湿滑' },
      { codes: [75, 86], level: 'warning', key: 'snowheavy', icon: '🌨️', text: '强降雪/雪暴' },
      { codes: [77], level: 'warning', key: 'ice', icon: '❄️', text: '冰粒, 路面结冰风险' },
      { codes: [71, 73, 85], level: 'info', key: 'snow', icon: '🌨️', text: '降雪' },
      { codes: [61, 63, 80, 81], level: 'info', key: 'rain', icon: '🌦️', text: '降雨' },
      { codes: [51, 53, 55, 56, 57], level: 'info', key: 'drizzle', icon: '🌫️', text: '毛毛雨/冻毛毛雨' },
      { codes: [45, 48], level: 'info', key: 'fog', icon: '🌫️', text: '雾, 能见度低' }
    ];
    for (const r of rules) {
      if (r.codes.indexOf(code) !== -1) return { level: r.level, icon: r.icon, key: r.key, text: r.text };
    }
    return null;
  }

  /* ============================================================
   * 2. 轨迹最高点实时气象 (Open-Meteo)
   *    按最高点海拔插值请求; 若 API 不接受扩展参数则自动回退
   * ============================================================ */
  async function fetchMountainWeather(lat, lon, elevation) {
    const common = '?latitude=' + lat + '&longitude=' + lon
      + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,uv_index,soil_moisture_0_to_1cm'
      + '&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=2';

    // 依次尝试: 带海拔插值 → 标准参数 → 最小参数集
    const tryUrls = [];
    if (elevation && !isNaN(elevation)) {
      tryUrls.push('https://api.open-meteo.com/v1/forecast' + common + '&elevation=' + Math.round(elevation));
    }
    tryUrls.push('https://api.open-meteo.com/v1/forecast' + common);
    tryUrls.push('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon
      + '&current=temperature_2m,wind_speed_10m,wind_gusts_10m,weather_code'
      + '&hourly=temperature_2m,wind_gusts_10m&timezone=auto&forecast_days=2');

    for (const url of tryUrls) {
      try {
        const res = await fetchTimeout(url);
        const j = await res.json();
        if (!j || !j.current) continue; // error JSON → 换下一个 URL

        const c = j.current;
        const hourly = j.hourly || {};

        /* 未来 6 小时最大阵风 & 最低体感(风寒) */
        let maxGust6h = c.wind_gusts_10m != null ? c.wind_gusts_10m : 0;
        let minWc6h = null;
        if (hourly.time && hourly.time.length) {
          const now = Date.now();
          for (let i = 0; i < hourly.time.length; i++) {
            const t = new Date(hourly.time[i]).getTime(); // timezone=auto → 本地时间
            if (t >= now - 3600e3 && t <= now + 7 * 3600e3) {
              const g = hourly.wind_gusts_10m ? hourly.wind_gusts_10m[i] : null;
              const tmp = hourly.temperature_2m ? hourly.temperature_2m[i] : null;
              if (g != null && g > maxGust6h) maxGust6h = g;
              if (tmp != null && g != null) {
                const wc = calcWindChill(tmp, g);
                if (wc != null && (minWc6h == null || wc < minWc6h)) minWc6h = wc;
              }
            }
          }
        }

        /* 未来 2 天最大降水概率 */
        let maxPrecipProb = 0;
        const daily = j.daily || {};
        if (daily.precipitation_probability_max) {
          daily.precipitation_probability_max.forEach((p) => { if (p > maxPrecipProb) maxPrecipProb = p; });
        }

        return {
          tempC: c.temperature_2m,
          windKmh: c.wind_speed_10m,
          gustKmh: c.wind_gusts_10m,
          humidity: c.relative_humidity_2m,
          code: c.weather_code,
          uv: c.uv_index,
          soil: c.soil_moisture_0_to_1cm,
          windChill: calcWindChill(c.temperature_2m, c.wind_speed_10m),
          maxGust6h, minWc6h, maxPrecipProb,
          daily,
          status: 'ok',
          message: 'Open-Meteo 微气象数据已更新'
        };
      } catch (e) {
        /* 尝试下一个 URL */
      }
    }

    return {
      tempC: null, windKmh: null, gustKmh: null, humidity: null,
      code: null, uv: null, soil: null, windChill: null,
      maxGust6h: null, minWc6h: null, maxPrecipProb: 0, daily: {},
      status: 'unreachable',
      message: 'Open-Meteo 气象数据源不可达(超时/网络受限), 微气象与风寒数据缺失',
      i18nKey: 'err.weather'
    };
  }

  /* ---------- 海拔补齐: 轨迹无海拔时调用 Open-Meteo 高程 API ---------- */
  async function fillElevation(points) {
    try {
      const latStr = points.map((p) => p[0]).join(',');
      const lonStr = points.map((p) => p[1]).join(',');
      const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + latStr + '&longitude=' + lonStr;
      const res = await fetchTimeout(url);
      const j = await res.json();
      if (j.elevation && j.elevation.length === points.length) {
        j.elevation.forEach((e, i) => { points[i][2] = Math.round(e); });
      }
    } catch (e) {
      /* 补齐失败则保持原值, 不影响主流程 */
    }
  }

  /* ============================================================
   * 3. 雨带雷达: RainViewer (无需 Key, CORS 开放)
   *    返回帧数组 [{time, url}] — tile 模板: /256/{z}/{x}/{y}/2/1_1.png
   * ============================================================ */
  async function fetchRainRadar() {
    try {
      const res = await fetchTimeout('https://api.rainviewer.com/public/weather-maps.json');
      const j = await res.json();
      if (!j || !j.radar) return null;
      const host = j.host || 'https://tilecache.rainviewer.com';
      const past = (j.radar.past || []).map((f) => ({
        time: f.time,
        url: host + f.path + '/256/{z}/{x}/{y}/2/1_1.png'
      }));
      const nowcast = (j.radar.nowcast || []).map((f) => ({
        time: f.time,
        url: host + f.path + '/256/{z}/{x}/{y}/2/1_1.png'
      }));
      const frames = past.concat(nowcast);
      return frames.length ? frames : null;
    } catch (e) {
      return null; // 雨带数据源不可达
    }
  }

  /* ---------- 雨带播放器: 按帧轮播 MapLibre raster source ----------
   * 复用单个 'rain-source' raster source + 'rain-layer' 图层,
   * 每帧只调用 source.setTiles([url]) 切换瓦片模板, 无需反复建图层。
   * 返回 { stop, current }; 函数签名保持 (map, frames, intervalMs) 不变。 */
  function playRainRadar(map, frames, intervalMs) {
    if (!map || !frames || !frames.length) return null;
    const SOURCE = 'rain-source';
    const LAYER = 'rain-layer';
    try {
      if (!map.getSource(SOURCE)) {
        map.addSource(SOURCE, { type: 'raster', tiles: [frames[0].url], tileSize: 256 });
      }
      if (!map.getLayer(LAYER)) {
        map.addLayer({
          id: LAYER,
          type: 'raster',
          source: SOURCE,
          paint: { 'raster-opacity': 0.65 } // 半透明, 显示在轨迹/缓冲区之上
        });
      }
    } catch (e) {
      return null; // 地图未就绪等情况 → 播放失败, 由调用方降级
    }

    let idx = 0, timer = null;

    function show(i) {
      const s = map.getSource(SOURCE);
      if (s && typeof s.setTiles === 'function') s.setTiles([frames[i].url]);
      if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'visible');
    }

    show(0);
    timer = setInterval(() => {
      idx = (idx + 1) % frames.length;
      show(idx);
    }, intervalMs || 600);

    return {
      stop() {
        if (timer) { clearInterval(timer); timer = null; }
        if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
      },
      current() { return frames[idx]; }
    };
  }

  /* 对外导出 */
  return {
    calcWindChill, describeCode,
    fetchMountainWeather, fillElevation,
    fetchRainRadar, playRainRadar,
    TIMEOUT_MS
  };
})();
