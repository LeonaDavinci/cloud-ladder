/* 模块加载诊断：把页面加载过程中
     · 每个 .js 请求的 状态码 / MIME
     · Runtime 异常（含模块链接错误）
     · console 输出
   全部打出来。模块图链接失败时页面上只有一句「脚本加载失败」，
   看不到具体原因 —— 这个脚本就是用来把原因挖出来的。 */
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9444);
const URL_ = process.argv[2];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const prof = (process.env.TEMP || '/tmp') + '/_mod_probe_' + Date.now();
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--no-first-run', '--window-size=1280,720',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, 'about:blank'
], { stdio: 'ignore' });

let ws;
try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0; const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const id = ++msgId; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (/\.js|\.html/.test(r.url)) console.log('[net] %s  %s  %s', r.status, r.mimeType, r.url);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.log('[EXC] %s: %s', d.text || '', (d.exception && d.exception.description) || '');
      if (d.url) console.log('      at %s:%s', d.url, d.lineNumber);
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      console.log('[log/%s] %s  %s', e.level, e.text, e.url || '');
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(m.params.type)) {
      console.log('[console.%s] %s', m.params.type,
        m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
    }
  };

  const tgt = await send('Target.createTarget', { url: 'about:blank' });
  const att = await send('Target.attachToTarget', { targetId: tgt.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Network.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Log.enable', {}, sid);
  await send('Page.navigate', { url: URL_ }, sid);
  await sleep(7000);

  const r = await send('Runtime.evaluate', {
    expression: "(function(){return JSON.stringify({dbg:!!window.__dbg, errs:window.__errs||null, boot:(document.getElementById('boot-error')||{}).style?document.getElementById('boot-error').style.display:'-'});})()",
    returnByValue: true
  }, sid);
  console.log('[state] ' + JSON.stringify(r.result && r.result.result && r.result.result.value));
} catch (e) {
  console.log('probe error: ' + e.message);
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
}
