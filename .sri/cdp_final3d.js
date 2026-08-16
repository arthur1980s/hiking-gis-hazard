const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const tab = await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:8099/', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const appErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') appErrors.push('EX: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = JSON.stringify(m.params.args.map(a => a.value || a.description));
      if (!txt.includes('gibs.earthdata.nasa.gov')) appErrors.push('CE: ' + txt.slice(0, 200));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { res }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evAwait = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? JSON.stringify({ evalError: r.exceptionDetails.text }) : r.result.value; };
  await send('Runtime.enable');
  await sleep(12000);
  // 3D toggle(本地 vendor)
  const r = await evAwait(`(async () => {
    try {
      const mod = await import('/js/3d.js');
      await mod.toggle3D();
      const map = window.TrailSense.map;
      const local3d = performance.getEntriesByType('resource').filter(x => x.name.includes('/vendor/three')).length;
      return 'OK pitch=' + map.getPitch() + ' terrain=' + (map.getTerrain() ? 'yes' : 'no') + ' localThreeFiles=' + local3d;
    } catch (e) { return 'FAIL: ' + (e && e.message); }
  })()`);
  console.log('3D(本地vendor) →', r);
  console.log('应用错误:', appErrors.length, appErrors.slice(0, 3));
  ws.close(); process.exit(0);
}
main().catch((e) => { console.error('失败:', e); process.exit(2); });
