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
  const r = JSON.parse(await evAwait(`JSON.stringify((() => {
    return { lang: i18n.getLang(), badge: document.getElementById('trailBadge').textContent, tYubeng: t('trail.name.yubeng'), badgeI18nAttr: document.getElementById('trailBadge').getAttribute('data-i18n'), trailNameKey: window.TrailSense.state.trailNameKey, trailName: window.TrailSense.state.trailName };
  })())`));
  console.log(JSON.stringify(r));
  ws.close(); process.exit(0);
}
main().catch((e) => { console.error('失败:', e); process.exit(2); });
