const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const tab = await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:8099/', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const appErrors = []; const downloads = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
    else if (m.method === 'Page.downloadWillBegin') downloads.push(m.params.suggestedFilename);
    else if (m.method === 'Runtime.exceptionThrown') appErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = JSON.stringify(m.params.args.map(a => a.value || a.description));
      if (!txt.includes('gibs.earthdata.nasa.gov')) appErrors.push('CE: ' + txt.slice(0, 200));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { res }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evAwait = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? JSON.stringify({ evalError: r.exceptionDetails.text }) : r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/home/Tiger/hiking-gis-hazard/.sri/dl' });
  await sleep(5000);
  await evAwait(`(async () => { try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); localStorage.clear(); } catch(e){} return 1; })()`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(14000);

  // 1) 默认地形 + 默认英文
  const s1 = JSON.parse(await evAwait(`JSON.stringify((() => {
    const map = window.TrailSense.map;
    return { activeBtn: document.querySelector('[data-basemap].active').dataset.basemap, topoVis: map.getLayoutProperty('basemap-topo','visibility'),
      brand: document.querySelector('[data-i18n="brand.name"]').textContent, badge: document.getElementById('trailBadge').textContent,
      langBtn: document.getElementById('langBtn').textContent, savedLang: localStorage.getItem('lang') };
  })())`));
  console.log('[1] 默认地形+英文:', JSON.stringify(s1));

  // 2) 3D(本地 vendor)
  await evAwait(`document.getElementById('btn3d').click(); 'ok'`);
  await sleep(7000);
  const s2 = JSON.parse(await evAwait(`JSON.stringify((() => { const map = window.TrailSense.map;
    return { pitch: map.getPitch(), terrain: map.getTerrain() ? 'yes' : 'no', btnActive: document.getElementById('btn3d').classList.contains('active'),
      threeLocal: performance.getEntriesByType('resource').filter(x => x.name.includes('/vendor/three')).length,
      cdn3d: performance.getEntriesByType('resource').filter(x => x.name.includes('cdn.jsdelivr') && (x.name.includes('three') || x.name.includes('maplibre-three'))).length };
  })())`));
  console.log('[2] 3D:', JSON.stringify(s2));

  // 3) 主题切换
  await evAwait(`document.getElementById('themeBtn').click(); 'ok'`);
  await sleep(500);
  const s3 = JSON.parse(await evAwait(`JSON.stringify({ theme: document.documentElement.getAttribute('data-theme'), bodyBg: getComputedStyle(document.body).backgroundColor, savedTheme: localStorage.getItem('theme') })`));
  console.log('[3] 主题:', JSON.stringify(s3));

  // 4) badge 英文(i18n) + 语言按钮
  console.log('[4] badge 英文: 见 [1] =', s1.badge);

  // 5) 导出 PDF(第2页地图图)
  await evAwait(`document.getElementById('exportBtn').click(); 'ok'`);
  await sleep(9000);
  console.log('[5] 下载:', JSON.stringify(downloads));
  console.log('[RESULT] 应用错误:', appErrors.length, appErrors.slice(0, 3));
  ws.close();
  process.exit(appErrors.length ? 1 : 0);
}
main().catch((e) => { console.error('失败:', e); process.exit(2); });
