// 打包产物冒烟测试（build_minitool.py 之后跑）
//   node tools/smoke-dist.mjs
// 服务 dist-minitool/ 并开无头 Chrome 打开它，检查：
//   ① 页面没有抛异常、没有 BUILD-FAIL（半启动的页面会静默「看着像能跑」）
//   ② window.__dbg 建起来了（main.js 走到末尾）
//   ③ 床模型加载完成（bedModel）
//   ④ BGM 默认曲目 = audio.default 指的那首
// 任一项不过 → 退出码 1（方便串进构建脚本/CI）。
// 踩过的坑：`ReferenceError: defIndex is not defined` 这种「少了一个声明」的错
// 不会让语法检查报错，页面照旧渲染草地和天空，只是音频/一部分逻辑静默失效 ——
// 只有真跑一遍才能发现（见 README「打包后的冒烟测试」）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIST = 'E:/workbuddy/cloud-ladder/dist-minitool';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8251, CDB_PORT = 9361;
const WAIT_MS = 35000;

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg' };
const server = http.createServer((req,res)=>{
  let u = req.url.split('?')[0]; if (u === '/') u = '/index.html';
  fs.readFile(path.join(DIST, u), (err, data)=>{
    if (err){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(u)] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
});
await new Promise(r=>server.listen(PORT, r));

const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDB_PORT}`], { stdio:'ignore' });

const errors = [], consoles = [];
let WS = null;
const cleanup = () => { try{ if(WS) WS.close(); }catch{} try{ chrome.kill(); }catch{} try{ server.close(); }catch{} };
process.on('exit', cleanup);

async function cdbGet(){
  for (let i=0;i<60;i++){
    try{ const r = await fetch(`http://127.0.0.1:${CDB_PORT}/json/list`); if (r.ok){ const j = await r.json(); if (j.length) return j; } }catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('chrome devtools not up');
}
const targets = await cdbGet();
const page = targets.find(t=>t.type==='page') || targets[0];   // 必须连 page target
WS = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
const send = (method, params={}) => new Promise((resolve,reject)=>{
  const id = ++msgId; pending.set(id,{resolve,reject});
  WS.send(JSON.stringify({id, method, params}));
});
WS.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)){ const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown'){
    const d = m.params.exceptionDetails || {};
    errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '?');
  } else if (m.method === 'Runtime.consoleAPICalled'){
    const txt = (m.params.args||[]).map(a => a.value !== undefined ? String(a.value) : (a.description||'')).join(' ');
    consoles.push(m.params.type + ': ' + txt.slice(0, 300));
    if (m.params.type === 'error') errors.push('[console.error] ' + txt.slice(0, 300));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error'){
    errors.push('[log] ' + m.params.entry.text);
  }
});
await new Promise(r=>WS.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Page.navigate', { url:`http://127.0.0.1:${PORT}/` });
await new Promise(r=>setTimeout(r, WAIT_MS));

const r = await send('Runtime.evaluate', { expression:`(()=>({
  readyState: document.readyState,
  hasDbg: typeof window.__dbg,
  hasCanvas: !!document.querySelector('canvas'),
  hasConfig: typeof window.CONFIG_JSON,
  hasScene: typeof window.SCENE_JSON,
  hasBedTex: typeof window.BED_TEX,
  bedSrc: window.__bedSrc || null,
  bedModel: !!(window.__dbg && window.__dbg.bed && window.__dbg.bed.userData && window.__dbg.bed.userData.bedModel),
  audioState: window.__audio && window.__audio.state,
  audioIndex: window.__audio && window.__audio.index,
  audioTitle: window.__audio && window.__audio.title,
  audioWant: (window.CONFIG_JSON && window.CONFIG_JSON.audio && window.CONFIG_JSON.audio.default) || null,
  audioFiles: (window.__audio && window.__audio.tracks || []).map(t => t.file)
}))()`, returnByValue:true });
const S = r.result.value;
const expectIdx = S.audioWant && S.audioFiles
  ? S.audioFiles.findIndex(f => String(f).indexOf(String(S.audioWant).replace(/\.json$/, '')) >= 0) : -1;

const checks = [];
const ck = (name, pass, detail) => checks.push({ name, pass, detail });

ck('页面无异常 / 无 BUILD-FAIL', errors.length === 0 && !consoles.some(c => /BUILD-FAIL/.test(c)), errors.slice(0,3).join(' | ') || 'clean');
ck('window.__dbg 已建立', S.hasDbg === 'object', 'typeof=' + S.hasDbg);
ck('内联数据齐备', S.hasConfig === 'object' && S.hasScene === 'object' && S.hasBedTex === 'object',
   `config=${S.hasConfig} scene=${S.hasScene} bedTex=${S.hasBedTex}`);
ck('床模型加载完成', S.bedModel === true, 'via=' + (S.bedSrc && S.bedSrc.via));
ck(`BGM 默认曲 = ${S.audioWant}`, expectIdx >= 0 && S.audioIndex === expectIdx,
   `index=${S.audioIndex} 期望=${expectIdx} title=${S.audioTitle} state=${S.audioState}`);

console.log('=== 产物冒烟测试 ===');
for (const c of checks) console.log((c.pass ? '  ✓ ' : '  ✗ ') + c.name + (c.pass ? '' : '   → ' + c.detail));
if (errors.length){
  console.log('\n--- 异常/console.error (' + errors.length + ') ---');
  errors.slice(0, 8).forEach(e => console.log('  ! ' + e.split('\n')[0].slice(0, 400)));
}
const bad = checks.filter(c => !c.pass).length;
console.log(bad ? `\nFAILED: ${bad} 项未通过` : '\nALL PASS');
cleanup();
process.exit(bad ? 1 : 0);
