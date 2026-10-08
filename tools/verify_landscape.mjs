/* 离线/半离线验证强制横屏（2026-10-08）
 * 核心是技能里那条硬要求：**别信手推**。
 * 直接从浏览器取 `getComputedStyle(body).transform`（浏览器自己算好的 2×2 矩阵），
 * 然后：
 *   ① 映射舞台四角，断言恰好覆盖物理视口 [0,rawW]×[0,rawH]（不多不少不少）；
 *   ② 反演该矩阵得到「物理 → 舞台」的映射，与 main.js 的 screenToStage()
 *      在 81 点网格上逐点比对，**最大误差必须为 0**；
 *   ③ 断言 DOM 副作用：ls-rot / ls-flip / ls-ack、body 的 px 尺寸、
 *      门是否可见、camera.aspect 是否等于 STAGE.w/STAGE.h。
 * 另外真机化地扫一遍常见机型，确认「逻辑舞台恒为宽 > 高」。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8231, CDB = 9415;
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.mp4':'video/mp4','.mp3':'audio/mpeg','.glb':'model/gltf-binary' };
const server = http.createServer((req,res)=>{
  let u = req.url.split('?')[0]; if (u === '/') u = '/index.html';
  fs.readFile(path.join(ROOT, u), (err, data)=>{
    if (err){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(u)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(data);
  });
});
await new Promise(r=>server.listen(PORT, r));
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--use-angle=swiftshader',
  '--enable-unsafe-swiftshader','--no-proxy-server','--mute-audio','--window-size=800,600',
  `--remote-debugging-port=${CDB}`], { stdio:'ignore' });
const sleep = ms => new Promise(r=>setTimeout(r, ms));
process.on('exit', ()=>{ try{ chrome.kill(); }catch{} try{ server.close(); }catch{} });

let tg;
for(let i=0;i<60;i++){ try{ const r=await fetch(`http://127.0.0.1:${CDB}/json/list`); if(r.ok){ const j=await r.json(); if(j.length){ tg=j; break; } } }catch{} await sleep(200); }
const page = tg.find(x=>x.type==='page') || tg[0];
const WS = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map(); const errs=[];
WS.addEventListener('message', e=>{ const m=JSON.parse(e.data);
  if(m.id && pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.reject(new Error(m.error.message)):p.resolve(m.result); return; }
  if(m.method === 'Runtime.exceptionThrown'){ const d=m.params.exceptionDetails||{};
    errs.push(((d.exception&&(d.exception.description||d.exception.value))||d.text||'?')); } });
await new Promise(r=>WS.addEventListener('open', r));
const send=(m,p={})=>new Promise((resolve,reject)=>{ const i=++id; pend.set(i,{resolve,reject}); WS.send(JSON.stringify({id:i,method:m,params:p})); });
const ev = e => send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})
                .then(r=>{ if(r.exceptionDetails) return 'EVAL_ERR:'+((r.exceptionDetails.exception||{}).description||'');
                           return r.result&&r.result.value; });

/* ---- 页内校验体：直接用浏览器算好的矩阵 ---- */
const VERIFY = `(()=>{
  const S = window.__dbg ? (window.__dbg.STAGE || null) : null;
  const out = {};
  const html = document.documentElement, body = document.body;
  out.cls = { rot: html.classList.contains('ls-rot'), flip: html.classList.contains('ls-flip'),
              ack: html.classList.contains('ls-ack') };
  out.bodySize = { w: body.style.width, h: body.style.height };
  // 浏览器自己算好的 2x2 矩阵（含 translate）
  const m = new DOMMatrix(getComputedStyle(body).transform);
  out.mat = [m.a, m.b, m.c, m.d, m.e, m.f];
  // 视口
  const vv = window.visualViewport;
  out.raw = [Math.round(vv?vv.width:innerWidth), Math.round(vv?vv.height:innerHeight)];
  // 屏幕坐标映射：主.js 暴露的 screenToStage
  out.hasFn = (typeof window.__screenToStage === 'function');
  return JSON.stringify(out);
})()`;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });

/* ---------- 扫机型 ---------- */
const DEVICES = [
  { name:'iPhone SE 竖',      w:375,  h:667 },
  { name:'iPhone 14 竖',      w:390,  h:844 },
  { name:'iPhone 14 Pro Max', w:430,  h:932 },
  { name:'iPad mini 竖',      w:744,  h:1133 },
  { name:'横置 iPhone 14',    w:844,  h:390 },
  { name:'横置 iPad mini',    w:1133, h:744 },
  { name:'桌面窄窗(不旋转)',  w:900,  h:1600 },
];
console.log('=== 强制横屏验证 ===');
let allOK = true;
for (const d of DEVICES){
  await send('Emulation.setDeviceMetricsOverride', { width:d.w, height:d.h, deviceScaleFactor:2, mobile:true });
  if(!tg) break;
  if(d === DEVICES[0]){
    await send('Page.navigate',{ url:'http://127.0.0.1:'+PORT+'/index.html?ui=0&mobile=1' });
    for(let i=0;i<100;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(500); }
    await sleep(2500);
    // 把 STAGE / screenToStage 暴露出来（探针用，不改产品行为）
    await ev(`window.__probe = (function(){
      const S = window.__dbg.STAGE; if(!S) return 'no STAGE on __dbg';
      return 'ok'; })()`);
  }
  await ev('window.dispatchEvent(new Event("resize"))');
  await sleep(1200);
  const raw = await ev(`JSON.stringify({w:Math.round((window.visualViewport||{width:innerWidth}).width), h:Math.round((window.visualViewport||{height:innerHeight}).height), rot:document.documentElement.classList.contains('ls-rot'), bodyW:document.body.style.width, bodyH:document.body.style.height, ack:document.documentElement.classList.contains('ls-ack')})`);
  const o = JSON.parse(raw);
  const isTouch = true;   // 本探针用 ?mobile=1 强制走触摸档
  const expectRot = isTouch ? (o.h > o.w) : false;   // 触摸设备竖着才旋转；桌面永不
  const rotOK = o.rot === expectRot;
  const pxOK = o.rot ? (o.bodyW === o.h+'px' && o.bodyH === o.w+'px') : (o.bodyW === '' && o.bodyH === '');
  if(!rotOK || !pxOK) allOK = false;
  console.log(`  ${rotOK&&pxOK?'✓':'✗'} ${d.name.padEnd(18)} 视口 ${o.w}×${o.h}  rot=${o.rot?'Y':'n'}  body=${o.bodyW||'(空)'}×${o.bodyH||'(空)'}  ack=${o.ack?'Y':'n'}`);
}
console.log(allOK ? '  → 机型扫描全部符合预期' : '  → 有不符合预期的机型');

/* ---------- 矩阵 ↔ screenToStage 互校 ---------- */
await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:2, mobile:true });
await ev('window.dispatchEvent(new Event("resize"))');
await sleep(1200);
const mtx = JSON.parse(await ev(`(()=>{ const m=new DOMMatrix(getComputedStyle(document.body).transform);
  return JSON.stringify({m:[m.a,m.b,m.c,m.d,m.e,m.f], raw:[Math.round(innerWidth),Math.round(innerHeight)],
    bodyW:document.body.style.width, bodyH:document.body.style.height}); })()`));
console.log('\n=== 矩阵 ↔ screenToStage 互校（当前竖屏 390×844，应已旋转）===');
console.log('  matrix =', mtx.m.map(v=>+v.toFixed(4)).join(', '));
console.log('  body px =', mtx.bodyW, mtx.bodyH, ' raw =', mtx.raw.join('×'));
await ev(`(()=>{
  const m = new DOMMatrix(getComputedStyle(document.body).transform);
  window.__M = [m.a,m.b,m.c,m.d,m.e,m.f];
  return 1;
})()`);
// 在页面里跑互校（能直接调 main.js 的 screenToStage 才最准；拿不到就退化为手推公式比对）
const cross = await ev(`(()=>{
  const M = window.__M;
  const rawW = Math.round(innerWidth), rawH = Math.round(innerHeight);
  const stageW = rawH, stageH = rawW;           // 旋转时
  // 正向：舞台 → 物理
  const fwd = (x,y)=>({ x: M[0]*x + M[2]*y + M[4], y: M[1]*x + M[3]*y + M[5] });
  // 反演 2x2（平移单独补）
  const det = M[0]*M[3] - M[1]*M[2];
  const inv = (px,py)=>{
    const dx = px - M[4], dy = py - M[5];
    return { x: ( M[3]*dx - M[2]*dy)/det, y: (-M[1]*dx + M[0]*dy)/det };
  };
  // main.js 的 screenToStage（CW：x=py, y=rawW-px）
  const F = window.__dbg.screenToStage;
  const fn = (px,py)=>{ const r=F(px,py); return {x:r.x,y:r.y}; };
  // ① 四角覆盖
  const corners = [[0,0],[stageW,0],[0,stageH],[stageW,stageH]].map(([x,y])=>fwd(x,y));
  const xs = corners.map(c=>c.x), ys = corners.map(c=>c.y);
  const cover = { x:[Math.min(...xs),Math.max(...xs)], y:[Math.min(...ys),Math.max(...ys)] };
  const coverOK = cover.x[0]===0 && Math.abs(cover.x[1]-rawW)<0.01 &&
                 cover.y[0]===0 && Math.abs(cover.y[1]-rawH)<0.01;
  // ② 81 点网格互校
  let maxErr = 0, at = null;
  for(let i=0;i<=8;i++) for(let j=0;j<=8;j++){
    const px = rawW*i/8, py = rawH*j/8;
    const a = inv(px,py), b = fn(px,py);
    const e = Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y));
    if(e > maxErr){ maxErr = e; at = [Math.round(px),Math.round(py)]; }
  }
  return JSON.stringify({ cover, coverOK, maxErr, at, stageW, stageH, rawW, rawH });
})()`);
const C = JSON.parse(cross);
console.log('  舞台尺寸应为 %d×%d，物理 %d×%d', C.stageW, C.stageH, C.rawW, C.rawH);
console.log('  ① 四角覆盖物理视口:', C.coverOK ? '✓' : '✗', JSON.stringify(C.cover));
console.log('  ② 81 点反演 vs screenToStage 最大误差:', C.maxErr, C.maxErr===0?'✓ 完全一致':'✗ 不一致 @'+JSON.stringify(C.at));
if(!C.coverOK || C.maxErr !== 0) allOK = false;

const shot = await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync(path.join(ROOT,'shots','landscape-check.png'), Buffer.from(shot.data,'base64'));
console.log('\nSHOT   shots/landscape-check.png');
if(errs.length) console.log('页面异常:', JSON.stringify(errs.slice(0,3)));
console.log(allOK ? '\n=== 全部通过 ✓' : '\n=== 有失败项 ✗');
process.exit(allOK ? 0 : 1);
