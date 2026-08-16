/* ============================================================
 * 3d.js — 3D 地形/模型/交互模块 (ES Module, 动态 import 按需加载)
 * 依赖(importmap 映射 + CDN):
 *   · three@0.178.0  (build/three.module.js)
 *   · @dvt3d/maplibre-three-plugin@1.7.1  (ESM, 桥接 MapLibre 与 Three.js)
 *   · three/addons/loaders/GLTFLoader.js
 * 功能:
 *   · 3D 地形: raster-dem(AWS Terrarium) + setTerrain
 *   · 3D 对象: 神湖山峰(锥体 + glTF 演示)、轨迹起/终/最高点、灾害点
 *   · 交互: 地图点击弹窗 + 悬停高亮 + 光照
 * 降级: 模块/DEM 加载失败均不影响 2D 功能(由 app.js catch 处理)
 * ============================================================ */
import * as THREE from 'three';
import * as MTP from 'https://cdn.jsdelivr.net/npm/@dvt3d/maplibre-three-plugin@1.7.1/dist/index.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const App = (typeof window !== 'undefined') ? window.TrailSense : null; // app.js 导出的全局

let enabled = false;        // 3D 是否开启
let mapScene = null;        // MapScene 实例
let scene = null, camera = null, renderer = null;
const objects = [];         // 3D 对象清单: { group, mesh, lngLat, meta }
let hoveredObj = null;      // 当前悬停高亮的对象

/* ---------- Toast(复用 #toast, i18n) ---------- */
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- 按钮状态 ---------- */
function updateButton() {
  const btn = document.getElementById('btn3d');
  if (btn) btn.classList.toggle('active', enabled);
}

/* ============================================================
 * 主开关: toggle3D() 由 app.js 动态 import 后调用
 * ============================================================ */
export async function toggle3D() {
  if (!App || !App.map) return;
  if (enabled) {
    await disable3D();
  } else {
    await enable3D();
  }
}

/* ---------- 开启 3D ---------- */
async function enable3D() {
  const map = App.map;

  // 1) 3D 视角(俯仰)
  map.setPitch(60);

  // 2) 3D 地形: AWS Terrarium 免费 DEM, 失败优雅降级(2D 不受影响)
  try {
    if (!map.getSource('dem')) {
      map.addSource('dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium', // 高程编码必须正确配置
        tileSize: 256,
        maxzoom: 15
      });
    }
    map.setTerrain({ source: 'dem', exaggeration: 1.5 });
  } catch (e) {
    console.warn('3D DEM 地形不可用(网络受限?), 保持平面视角:', e);
  }

  // 3) MapScene 桥接(MapLibre 与 Three.js)
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000000);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(map.getCanvas().clientWidth, map.getCanvas().clientHeight);
  renderer.domElement.style.pointerEvents = 'none'; // 不拦截地图拖拽
  mapScene = new MTP.MapScene(map, { scene, camera, renderer });

  // 4) 光照(环境光 + 方向光)
  mapScene.addLight(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 1, 1);
  mapScene.addLight(dirLight);

  // 5) 3D 对象(山峰/轨迹/灾害点)
  buildObjects();

  // 6) 交互(地图事件 + 经纬度距离判定, 避免 raycaster 与地图拖拽冲突)
  bindInteraction();

  enabled = true;
  updateButton();
  showToast(t('toast.3d.on'));
}

/* ---------- 关闭 3D ---------- */
async function disable3D() {
  const map = App.map;
  if (mapScene) {
    try { mapScene.dispose(); } catch (e) { /* ignore */ }
    // 移除 Three.js 渲染画布
    if (renderer && renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
    mapScene = null;
  }
  objects.length = 0;
  hoveredObj = null;
  // 地形关闭 + 视角回平
  try { map.setTerrain(null); } catch (e) { /* ignore */ }
  map.setPitch(0);
  map.getCanvas().style.cursor = '';
  enabled = false;
  updateButton();
  showToast(t('toast.3d.off'));
}

/* ============================================================
 * 3D 对象构建: 雨崩场景(神湖山峰/起点) + 轨迹起终最高点 + 灾害点
 * ============================================================ */
function buildObjects() {
  if (!mapScene) return;
  const state = App.state;

  /* 通用: 在 [lng,lat,ele] 放置网格并登记元数据 */
  const addObj = (lngLatEle, mesh, meta) => {
    const group = MTP.Creator.createRTCGroup(lngLatEle);
    group.add(mesh);
    mapScene.addObject(group);
    objects.push({ group, mesh, lngLat: [lngLatEle[0], lngLatEle[1]], meta: meta || {} });
    return group;
  };

  /* --- 神湖位置山峰(锥体, 底部立于海拔 4460m) --- */
  const peakGeo = new THREE.ConeGeometry(150, 420, 14);
  const peakMat = new THREE.MeshStandardMaterial({ color: 0xe94560, roughness: 0.7, metalness: 0.1 });
  const peakMesh = new THREE.Mesh(peakGeo, peakMat);
  peakMesh.position.y = 210; // 底部贴地
  addObj([98.786289, 28.359753, 4460], peakMesh, {
    key: 'popup.3d.peak', name: t('popup.3d.peak'), desc: '98.7863, 28.3598 · 4460m'
  });

  /* --- 尝试 GLTFLoader 加载程序化山峰模型(演示; 失败不影响锥体) --- */
  try {
    const loader = new GLTFLoader();
    loader.load('./assets/yubeng-peak.gltf', (gltf) => {
      if (!mapScene || !enabled) return;
      gltf.scene.scale.set(120, 120, 120);
      gltf.scene.position.y = 210;
      gltf.scene.rotation.y = Math.PI / 4;
      const g2 = MTP.Creator.createRTCGroup([98.786289, 28.359753, 4460]);
      g2.add(gltf.scene);
      mapScene.addObject(g2);
      objects.push({ group: g2, mesh: gltf.scene, lngLat: [98.786289, 28.359753], meta: { key: 'popup.3d.peak' } });
    }, undefined, (err) => console.warn('glTF 山峰模型加载失败(已用锥体):', err));
  } catch (e) { /* ignore */ }

  /* --- 起点标记(雨崩村口, 3060m) --- */
  const startGeo = new THREE.CylinderGeometry(60, 90, 60, 10);
  const startMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, roughness: 0.5 });
  const startMesh = new THREE.Mesh(startGeo, startMat);
  startMesh.position.y = 30;
  addObj([98.792835, 28.390854, 3060], startMesh, {
    key: 'popup.3d.start', name: t('popup.3d.start'), desc: '98.7928, 28.3909 · 3060m'
  });

  /* --- 轨迹: 起点/终点/最高点 3D 标记 + 轨迹连线 --- */
  const pts = state.points;
  if (pts && pts.length) {
    const first = pts[0], last = pts[pts.length - 1], peak = TrailPeak(pts);
    // 起点(青)
    const s = ballMesh(0x4fc3f7, 70); s.position.y = 70;
    addObj([first[1], first[0], first[2] || 3000], s, { key: 'popup.3d.start', name: t('popup.3d.start') });
    // 终点(黄)
    const e = ballMesh(0xf5c518, 70); e.position.y = 70;
    addObj([last[1], last[0], last[2] || 3000], e, { key: 'popup.3d.end', name: t('popup.3d.end') });
    // 最高点(红, 放大)
    const p = ballMesh(0xe94560, 100); p.position.y = 100;
    addObj([peak[1], peak[0], peak[2]], p, { key: 'popup.3d.trailpeak', name: t('popup.3d.trailpeak'), desc: '海拔 ' + Math.round(peak[2]) + 'm' });

    // 轨迹连线(THREE.Line, 沿地表高度)
    try {
      const center = [pts[Math.floor(pts.length / 2)][1], pts[Math.floor(pts.length / 2)][0]];
      const verts = [];
      pts.forEach((p) => {
        const off = offsetMeters(p[1], p[0], center[0], center[1]);
        verts.push(off.x, (p[2] || 3000), off.z);
      });
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const lineMat = new THREE.LineBasicMaterial({ color: 0xe94560 });
      const line = new THREE.Line(lineGeo, lineMat);
      const lg = MTP.Creator.createRTCGroup([center[0], center[1], 3000]);
      lg.add(line);
      mapScene.addObject(lg);
    } catch (e) { console.warn('3D 轨迹连线失败:', e); }
  }

  /* --- 灾害点 3D 标记(地震红 / 山火橙) --- */
  const quakes = (state.quakeData && state.quakeData.items) || [];
  quakes.forEach((q) => {
    const m = ballMesh(0xff6b6b, 90); m.position.y = 90;
    addObj([q.lng, q.lat, (q.depth ? 2000 : 2000)], m, {
      key: 'popup.3d.quake', name: t('popup.3d.quake', { mag: q.mag != null ? q.mag.toFixed(1) : '?' }), lngLat: [q.lng, q.lat]
    });
  });
  const fires = (state.fireData && state.fireData.points) || [];
  fires.forEach((f) => {
    const m = ballMesh(0xff6b35, 90); m.position.y = 90;
    addObj([f.lng, f.lat, 2000], m, {
      key: 'popup.3d.fire', name: t('popup.3d.fire'), lngLat: [f.lng, f.lat]
    });
  });
}

/* 小工具: 轨迹最高点 [lat,lng,ele] */
function TrailPeak(points) {
  let peak = points[0];
  points.forEach((p) => { if (p[2] != null && (peak[2] == null || p[2] > peak[2])) peak = p; });
  return peak;
}

/* 球体网格 */
function ballMesh(color, r) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, 14, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 })
  );
}

/* 经纬度差 → RTC 组局部米制偏移(X 东, Z 南) */
function offsetMeters(lng, lat, cLng, cLat) {
  const rad = Math.PI / 180;
  return {
    x: (lng - cLng) * 111320 * Math.cos(cLat * rad),
    z: -(lat - cLat) * 110540
  };
}

/* ============================================================
 * 交互: 地图点击弹窗 + 悬停高亮(用经纬度距离判定, 稳定可靠)
 * ============================================================ */
function bindInteraction() {
  const map = App.map;

  /* 距离(米)判定最近的 3D 对象 */
  const nearest = (lngLat, maxM) => {
    let best = null, bestD = maxM;
    objects.forEach((o) => {
      const d = haversineM(o.lngLat[1], o.lngLat[0], lngLat.lat, lngLat.lng);
      if (d < bestD) { bestD = d; best = o; }
    });
    return best;
  };

  /* 点击 → Popup(复用 MapLibre Popup) */
  map.on('click', (e) => {
    if (!enabled) return;
    const o = nearest(e.lngLat, 400);
    if (o) {
      const meta = o.meta || {};
      new maplibregl.Popup({ offset: 18 })
        .setLngLat(e.lngLat)
        .setHTML('<strong>🧊 ' + (meta.name || '3D') + '</strong><br><span style="font-size:11px;color:#999;">' + (meta.desc || o.lngLat.join(', ')) + '</span>')
        .addTo(map);
    }
  });

  /* 悬停 → 高亮(emissive 增强) + 光标 */
  map.on('mousemove', (e) => {
    if (!enabled) return;
    const o = nearest(e.lngLat, 250);
    if (o !== hoveredObj) {
      if (hoveredObj && hoveredObj.mesh) resetHighlight(hoveredObj.mesh);
      hoveredObj = o || null;
      if (hoveredObj && hoveredObj.mesh) applyHighlight(hoveredObj.mesh);
    }
    map.getCanvas().style.cursor = o ? 'pointer' : '';
  });
  map.on('mouseleave', () => {
    if (hoveredObj && hoveredObj.mesh) resetHighlight(hoveredObj.mesh);
    hoveredObj = null;
    map.getCanvas().style.cursor = '';
  });
}

/* 高亮: 记录原始 emissive 并增强 */
function applyHighlight(mesh) {
  const mat = mesh.material;
  if (mat) {
    if (Array.isArray(mat)) mat.forEach((m) => applyHighlightOne(m));
    else applyHighlightOne(mat);
  }
}
function applyHighlightOne(m) {
  if (m.emissive) {
    m.userData._origEmissive = m.emissive.clone();
    m.emissive.set(0x333333);
  }
}
function resetHighlight(mesh) {
  const mat = mesh.material;
  if (mat) {
    if (Array.isArray(mat)) mat.forEach((m) => resetHighlightOne(m));
    else resetHighlightOne(mat);
  }
}
function resetHighlightOne(m) {
  if (m.emissive && m.userData._origEmissive) {
    m.emissive.copy(m.userData._origEmissive);
    delete m.userData._origEmissive;
  }
}

/* Haversine 米 */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
