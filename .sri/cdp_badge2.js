const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const tab = await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:8099/', { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { res }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evAwait = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? JSON.stringify({ evalError: r.exceptionDetails.text }) : r.result.value; };
  await send('Runtime.enable');
  await sleep(6000);
  await evAwait(`(async () => { try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); localStorage.clear(); } catch(e){} return 1; })()`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(14000);
  const r1 = await evAwait(`(async () => {
    const before = document.getElementById('trailBadge').textContent;
    const lang = i18n.getLang();
    // 手动 setTrailBadge
    window.TrailSense.setTrailBadge(t('trail.name.yubeng'), 'trail.name.yubeng');
    const after1 = document.getElementById('trailBadge').textContent;
    // 手动 loadYubeng
    await window.TrailSense.loadYubeng();
    await new Promise(r => setTimeout(r, 4000));
    const after2 = document.getElementById('trailBadge').textContent;
    return JSON.stringify({ before, lang, after1, after2 });
  })()`);
  console.log(r1);
  ws.close(); process.exit(0);
}
main().catch((e) => { console.error('失败:', e); process.exit(2); });
