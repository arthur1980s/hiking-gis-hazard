/* ============================================================
 * i18n.js — 轻量中英文国际化 (无框架, 无依赖)
 * · 静态文案: 元素加 data-i18n="key" / data-i18n-title="key" /
 *            data-i18n-placeholder="key", 切换语言时自动替换
 * · 动态文案: 调用 t('key', {参数}) 返回当前语言文本
 * · 语言偏好存 localStorage('lang'), 默认中文
 * ============================================================ */

const I18N = {
  /* ---------- 中文 ---------- */
  zh: {
    /* 顶部导航 */
    'brand.name': 'Traveler Guide 你好啊旅行者',
    'lang.btn': 'EN', // 中文界面显示「EN」(切换到英文)
    'risk.title': '综合风险等级',
    'risk.detecting': '综合风险: 检测中',
    'risk.danger': '综合风险: 高危',
    'risk.warning': '综合风险: 注意',
    'risk.safe': '综合风险: 安全',
    'export.btn': '📄 导出报告',

    /* 左侧导航 */
    'nav.hike': 'Hike',
    'nav.hike.title': 'Hike · 徒步态势感知',
    'nav.discover': 'Discover',
    'nav.discover.title': 'Discover · 探索推荐路线',

    /* 地图浮层按钮 */
    'map.topo': '地形',
    'map.topo.title': 'OpenTopoMap 地形图',
    'map.satellite': '卫星',
    'map.satellite.title': 'Esri 卫星影像',
    'layer.fires': '山火',
    'layer.fires.title': 'NASA FIRMS/GIBS 卫星山火热点',
    'layer.quakes': '地震',
    'layer.quakes.title': 'USGS 48h 地震',
    'layer.buffer': '缓冲区',
    'layer.buffer.title': '10km 监测缓冲区',
    'layer.contour': '等高线',
    'layer.contour.title': '等高线叠加层',
    'layer.rain': '雨带',
    'layer.rain.title': 'RainViewer 雨带雷达(2小时推演)',

    /* Hike 面板: 路线概况 */
    'trail.card': '路线概况',
    'stat.dist': '总距离 km',
    'stat.ascent': '累计爬升',
    'stat.descent': '累计下降',
    'stat.maxEle': '最高海拔',
    'stat.minEle': '最低海拔',
    'stat.points': '轨迹点数',
    'chart.x': '总距离 km',

    /* Hike 面板: 预警 */
    'hazard.card': '灾害碰撞检测 · 预警列表',
    'hazard.init': '⏳ 数据源初始化中...',
    'hazard.loading': '正在加载示例轨迹并检测...',
    'alert.none': '暂无风险 · 周边 {km}km 内未检测到灾害',
    'alert.quake': '距轨迹 {dist}km 发现地震 M{mag} ({place}){extra}',
    'alert.quake.extra': ', 注意山体滑坡/落石风险',
    'alert.fire': '距轨迹 {dist}km 发现 NASA 卫星山火热点{extra}',
    'alert.fire.frp': ' (辐射功率 {frp} MW)',
    'alert.wc.cold': '最高点体感风寒 {wc}°C < 0°C, 存在失温风险, 需加强保暖',
    'alert.wc.mild': '最高点体感风寒 {wc}°C, 体感偏冷',
    'alert.gust': '未来 6 小时阵风最大 {g} km/h (≥{lv}), 注意横风与失温',
    'alert.gust.lv10': '10级',
    'alert.gust.lv8': '8级',
    'alert.uv': 'UV 指数 {uv}, 高海拔紫外线强烈, 注意防晒',
    'alert.soil': '土壤湿度 {s}%, 路面泥泞, 滑坡风险升高',
    'alert.rain.unreachable': 'RainViewer 雨带雷达数据源不可达, 雨带图层不可用',
    'err.usgs': 'USGS 地震数据源不可达(超时/网络受限), 地震风险未知, 请出发前另行核查',
    'err.weather': 'Open-Meteo 气象数据源不可达(超时/网络受限), 微气象与风寒数据缺失',
    'err.firms.nokey': 'NASA FIRMS 数据源未配置, 山火点数据不可用; 已叠加 GIBS 卫星热异常瓦片(尽力而为)',
    'err.firms.unreachable': 'NASA FIRMS 数据源不可达(超时/网络受限), 已降级: 山火仅显示 GIBS 卫星热异常瓦片(若未显示说明数据源不通)',
    'ok.firms.points': 'NASA FIRMS 卫星热点 {n} 处',

    /* 微气象天气代码 */
    'wx.code.hail': '雷暴伴冰雹, 山脊线极度危险',
    'wx.code.thunder': '雷暴天气, 注意山顶雷击',
    'wx.code.rainheavy': '强降雨/冻雨, 警惕山洪与泥石流',
    'wx.code.shower': '强阵雨, 注意湿滑',
    'wx.code.snowheavy': '强降雪/雪暴',
    'wx.code.ice': '冰粒, 路面结冰风险',
    'wx.code.snow': '降雪',
    'wx.code.rain': '降雨',
    'wx.code.drizzle': '毛毛雨/冻毛毛雨',
    'wx.code.fog': '雾, 能见度低',

    /* Hike 面板: 微气象 */
    'wx.card': '高海拔微气象 · 风寒指数',
    'wx.peakEle': '最高点海拔',
    'wx.temp': '实时气温',
    'wx.gust': '当前阵风',
    'wx.uv': 'UV 指数',
    'wx.soil': '土壤湿度',
    'wx.wc': '体感风寒',
    'wx.gust6h': '6h最大阵风',
    'wx.wc6h': '6h最低体感',
    'wx.precip': '2日降水概率',
    'wx.temp.ph': '气温 °C',
    'wx.wind.ph': '风速 km/h',
    'wx.calc': '计算',
    'wx.na': '不可达',
    'wx.note.risk': '⚠️ 体感 < 0°C 时存在失温风险',
    'wx.note.formula': '公式: WC = 13.12 + 0.6215T − 11.37V^0.16 + 0.3965T·V^0.16',
    'wx.note.source': '数据源: Open-Meteo (按轨迹最高点海拔插值)',

    /* Discover 面板 */
    'upload.card': '📤 上传轨迹 (GPX / KML / GeoJSON)',
    'upload.drop': '拖拽或点击选择文件',
    'upload.hint': '支持 .gpx .kml .geojson · 最大 10MB',
    'upload.yubeng': '🏞️ 雨崩徒步（内置）',
    'upload.clear': '🗑️ 清除',
    'upload.radius.title': '监测缓冲区半径',
    'discover.card': '🧭 探索 · 世界知名徒步路线',
    'discover.intro': '选择一条示例路线加载到地图, 系统会自动进行 10km 灾害碰撞检测、高海拔微气象评估与风寒指数计算。加载完成后自动返回 Hike 视图。',
    'route.load': '加载并检测',
    'route.yubeng.name': '雨崩·神湖徒步',
    'route.yubeng.sub': '云南梅里雪山 · 高海拔徒步 · 最高 4460m',
    'discover.tips.title': '💡 使用提示',
    'discover.tips.line1': '· 雨崩徒步为真实轨迹 (GPX)',
    'discover.tips.line2': '· 在上方上传自己的 GPX / KML / GeoJSON 轨迹, 加载后自动回到 Hike 视图',
    'discover.tips.line3': '· 点击地图上的 🔴 起点 / 🟢 终点 / ⛰️ 景点可查看详情',

    /* 地图标记 popup / 缓冲区标签 */
    'popup.start': '起点',
    'popup.end': '终点',
    'popup.quake': 'M{mag} 地震',
    'popup.unknown': '未知位置',
    'popup.depth': '深度 {d}km',
    'popup.inBuffer': '⚠️ 位于监测缓冲区 {km}km内',
    'popup.fire': '🔥 卫星山火热点',
    'buffer.label': '📡 {km}km 监测区',

    /* Toast 动态消息 */
    'toast.rain.unreachable': '🌧️ 雨带雷达数据源不可达, 已自动关闭',
    'toast.rain.fetching': '🌧️ 正在获取雨带雷达数据...',
    'toast.rain.on': '🌧️ 雨带推演已开启(未来 2 小时)',
    'toast.loaded.trail': '📂 已加载轨迹: {name} ({n} 点)',
    'toast.parse.fail': '❌ 解析失败: {msg}',
    'toast.exporting': '⏳ 生成中...',
    'toast.exported': '📄 报告已生成并下载',
    'toast.print': '截图受 WebGL/跨域瓦片影响, 已切换为打印模式 (Ctrl+P 保存 PDF)',
    'toast.sw.reload': '🔄 检测到新版本, 正在刷新...',
    'toast.refresh': '🔄 手动刷新灾害检测...',
    'toast.yubeng': '🏞️ 已加载雨崩徒步示例, 正在检测周边灾害...',
    'toast.route': '🧭 已加载「{name}」, 正在检测周边灾害...',

    /* 检测状态 */
    'status.detecting': '检测中...',
    'status.updated': '已更新 {time}'
  },

  /* ---------- 英文 ---------- */
  en: {
    'brand.name': 'Traveler Guide',
    'lang.btn': '中', // 英文界面显示「中」(切回中文)
    'risk.title': 'Overall Risk Level',
    'risk.detecting': 'Risk: Detecting',
    'risk.danger': 'Risk: HIGH',
    'risk.warning': 'Risk: CAUTION',
    'risk.safe': 'Risk: SAFE',
    'export.btn': '📄 Export Report',

    'nav.hike': 'Hike',
    'nav.hike.title': 'Hike · Trail Awareness',
    'nav.discover': 'Discover',
    'nav.discover.title': 'Discover · Explore Routes',

    'map.topo': 'Terrain',
    'map.topo.title': 'OpenTopoMap terrain',
    'map.satellite': 'Satellite',
    'map.satellite.title': 'Esri satellite imagery',
    'layer.fires': 'Fires',
    'layer.fires.title': 'NASA FIRMS/GIBS satellite hotspots',
    'layer.quakes': 'Quakes',
    'layer.quakes.title': 'USGS 48h earthquakes',
    'layer.buffer': 'Buffer',
    'layer.buffer.title': '10km monitoring buffer',
    'layer.contour': 'Contours',
    'layer.contour.title': 'Contour overlay',
    'layer.rain': 'Rain',
    'layer.rain.title': 'RainViewer radar (2h forecast)',

    'trail.card': 'Trail Overview',
    'stat.dist': 'Distance km',
    'stat.ascent': 'Ascent',
    'stat.descent': 'Descent',
    'stat.maxEle': 'Max Elev.',
    'stat.minEle': 'Min Elev.',
    'stat.points': 'Points',
    'chart.x': 'Total Distance km',

    'hazard.card': 'Hazard Detection · Alerts',
    'hazard.init': '⏳ Initializing sources...',
    'hazard.loading': 'Loading sample trail & scanning...',
    'alert.none': 'No hazards detected within {km}km',
    'alert.quake': 'Earthquake M{mag} ({place}) {dist}km from trail{extra}',
    'alert.quake.extra': ', watch landslide/rockfall',
    'alert.fire': 'NASA fire hotspot {dist}km from trail{extra}',
    'alert.fire.frp': ' (FRP {frp} MW)',
    'alert.wc.cold': 'Wind chill {wc}°C < 0°C at peak, hypothermia risk, keep warm',
    'alert.wc.mild': 'Wind chill {wc}°C at peak, feels cold',
    'alert.gust': 'Max gust {g} km/h in next 6h (≥{lv}), watch crosswind & cold',
    'alert.gust.lv10': '10',
    'alert.gust.lv8': '8',
    'alert.uv': 'UV {uv}, intense at altitude, use sunscreen',
    'alert.soil': 'Soil moisture {s}%, muddy, landslide risk up',
    'alert.rain.unreachable': 'RainViewer unavailable, rain layer disabled',
    'err.usgs': 'USGS unreachable (timeout/network), earthquake risk unknown, verify before departure',
    'err.weather': 'Open-Meteo unreachable, micro-climate & wind chill data missing',
    'err.firms.nokey': 'NASA FIRMS source not configured; using GIBS thermal tiles (best effort)',
    'err.firms.unreachable': 'NASA FIRMS unreachable (timeout/network), degraded to GIBS thermal tiles (blank if source is down)',
    'ok.firms.points': '{n} NASA FIRMS hotspots',

    'wx.code.hail': 'Thunderstorm with hail, ridge extremely dangerous',
    'wx.code.thunder': 'Thunderstorm, mind lightning on peaks',
    'wx.code.rainheavy': 'Heavy/freezing rain, flash flood & landslide risk',
    'wx.code.shower': 'Heavy showers, slippery',
    'wx.code.snowheavy': 'Heavy snow/blizzard',
    'wx.code.ice': 'Ice pellets, icy trails',
    'wx.code.snow': 'Snow',
    'wx.code.rain': 'Rain',
    'wx.code.drizzle': 'Drizzle / freezing drizzle',
    'wx.code.fog': 'Fog, low visibility',

    'wx.card': 'High-altitude Micro-climate · Wind Chill',
    'wx.peakEle': 'Peak Elev.',
    'wx.temp': 'Temp',
    'wx.gust': 'Gust',
    'wx.uv': 'UV Index',
    'wx.soil': 'Soil Moist.',
    'wx.wc': 'Wind Chill',
    'wx.gust6h': '6h Max Gust',
    'wx.wc6h': '6h Min Chill',
    'wx.precip': '2d Precip. Prob.',
    'wx.temp.ph': 'Temp °C',
    'wx.wind.ph': 'Wind km/h',
    'wx.calc': 'Calc',
    'wx.na': 'N/A',
    'wx.note.risk': '⚠️ Hypothermia risk when feels like < 0°C',
    'wx.note.formula': 'Formula: WC = 13.12 + 0.6215T − 11.37V^0.16 + 0.3965T·V^0.16',
    'wx.note.source': 'Source: Open-Meteo (interpolated at peak elevation)',

    'upload.card': '📤 Upload Trail (GPX / KML / GeoJSON)',
    'upload.drop': 'Drag & drop or click to select',
    'upload.hint': 'Supports .gpx .kml .geojson · max 10MB',
    'upload.yubeng': '🏞️ Yubeng Hike (Built-in)',
    'upload.clear': '🗑️ Clear',
    'upload.radius.title': 'Monitoring buffer radius',
    'discover.card': '🧭 Discover · Famous Hiking Trails',
    'discover.intro': 'Pick a sample trail to load onto the map. The system will run a 10km hazard scan, high-altitude micro-climate and wind chill assessment, then return to the Hike view.',
    'route.load': 'Load & Scan',
    'route.yubeng.name': 'Yubeng · Holy Lake Hike',
    'route.yubeng.sub': 'Meili Snow Mt., Yunnan · High-altitude · max 4460m',
    'discover.tips.title': '💡 Tips',
    'discover.tips.line1': '· Yubeng hike is a real GPX trail',
    'discover.tips.line2': '· Upload your own GPX / KML / GeoJSON above; auto-returns to Hike view',
    'discover.tips.line3': '· Click 🔴 start / 🟢 end / ⛰️ spots on the map for details',

    'popup.start': 'Start',
    'popup.end': 'End',
    'popup.quake': 'Earthquake M{mag}',
    'popup.unknown': 'Unknown location',
    'popup.depth': 'Depth {d}km',
    'popup.inBuffer': '⚠️ Inside {km}km monitoring buffer',
    'popup.fire': '🔥 Satellite fire hotspot',
    'buffer.label': '📡 {km}km zone',

    'toast.rain.unreachable': '🌧️ Rain radar unavailable, turned off',
    'toast.rain.fetching': '🌧️ Fetching rain radar data...',
    'toast.rain.on': '🌧️ Rain animation on (next 2h)',
    'toast.loaded.trail': '📂 Trail loaded: {name} ({n} pts)',
    'toast.parse.fail': '❌ Parse failed: {msg}',
    'toast.exporting': '⏳ Generating...',
    'toast.exported': '📄 Report generated & downloaded',
    'toast.print': 'Screenshot blocked by WebGL/cross-origin tiles, switched to print (Ctrl+P for PDF)',
    'toast.sw.reload': '🔄 New version detected, refreshing...',
    'toast.refresh': '🔄 Refreshing hazard scan...',
    'toast.yubeng': '🏞️ Yubeng sample loaded, scanning hazards...',
    'toast.route': '🧭 "{name}" loaded, scanning hazards...',

    'status.detecting': 'Scanning...',
    'status.updated': 'Updated {time}'
  }
};

/* ---------- i18n 运行时: 取词/切换/静态应用 ---------- */
const i18n = (function () {
  'use strict';

  let lang = 'zh'; // 默认中文
  const listeners = [];

  /* 读取当前语言 */
  function getLang() {
    return lang;
  }

  /* 取词: t('key', {参数}, fallback) → 当前语言文本; 缺失时回退 fallback → 中文 → key 本身 */
  function t(key, params, fallback) {
    let val = (I18N[lang] && I18N[lang][key]);
    if (val == null && lang !== 'zh') val = I18N.zh[key]; // 英文缺失时回退中文
    if (val == null) val = fallback; // 调用方兜底(通常是已生成的中文文本)
    if (val == null) return key;
    if (params) {
      Object.keys(params).forEach((k) => {
        val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
      });
    }
    return val;
  }

  /* 应用所有 data-i18n 静态文案(含 title/placeholder 变体) */
  function applyStatic() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = t(el.getAttribute('data-i18n'));
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const v = t(el.getAttribute('data-i18n-title'));
      if (v != null) el.setAttribute('title', v);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const v = t(el.getAttribute('data-i18n-placeholder'));
      if (v != null) el.setAttribute('placeholder', v);
    });
  }

  /* 切换语言(持久化 + 应用静态文案 + 通知监听者刷新动态文案) */
  function setLang(l) {
    if (!I18N[l]) return lang;
    lang = l;
    try { localStorage.setItem('lang', lang); } catch (e) { /* ignore */ }
    applyStatic();
    listeners.forEach((fn) => { try { fn(lang); } catch (e) { /* ignore */ } });
    return lang;
  }

  /* 注册语言切换监听(app.js 用来刷新预警/微气象等动态面板) */
  function onChange(fn) {
    listeners.push(fn);
  }

  /* 初始化: 读 localStorage + 应用文案 */
  function init() {
    try {
      const saved = localStorage.getItem('lang');
      if (saved === 'en' || saved === 'zh') lang = saved;
    } catch (e) { /* ignore */ }
    applyStatic();
    return lang;
  }

  return { getLang, t, setLang, onChange, init };
})();

/* 全局便捷取词函数: 供各模块直接调用 t('key', {参数}, fallback) */
const t = i18n.t.bind(i18n);
