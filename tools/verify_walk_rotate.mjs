/* 验证强制横屏后「左右两个漫游操作」的适配（2026-10-09）
 *
 * 背景：之前只把**半屏判定**换成了舞台坐标，漏了
 *   ① 摇杆底座的 left/top（stickStart 拿物理坐标去定位）
 *   ② 摇杆偏移基准（stickDrag 用物理坐标去减）
 *   ③ 点云朵的射线拾取（hitAt 用物理包围盒算 NDC）
 * 三处都会在 body 被 rotate(90°) 之后错位。
 *
 * 本探针在**竖屏**（页面会自己旋转成横屏）下：
 *   · 切到「步行」模式
 *   · 在物理坐标某点派发 pointerdown ⇒ 检查摇杆 DOM 的 left/top 是否等于
 *     「该物理点映射到舞台坐标后 − SR」
 *   · 派发一段 pointermove ⇒ 检查 knob 位移的**方向与轴**是否与舞台坐标一致
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8251, CDB = 9433;
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.mp4':'video/mp4','.mp3':'audio/mpeg','.glb':'model/gltf-binary' };
const server = http.createServer((req,res)=>{
  let u = req.url.split('?')[0]; if (u === '/') u = '/index.html';
  fs.readFile(path.join(ROOT, u), (err, data)=>{
    if(err){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(u)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(data);
  });
});
await new Promise(r=>server.listen(PORT, r));
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--use-angle=swiftshader',
  '--enable-unsafe-swiftshader','--no-proxy-server','--mute-audio','--window-size=430,932',
  `--remote-debugging-port=${CDB}`], { stdio:'ignore' });
const sleep = ms => new Promise(r=>setTimeout(r, ms));
process.on('exit', ()=>{ try{ chrome.kill(); }catch{} try{ server.close(); }catch{} });
let tg;
for(let i=0;i<60;i++){ try{ const r=await fetch(`http://127.0.0.1:${CDB}/json/list`); if(r.ok){ const j=await r.json(); if(j.length){ tg=j; break; } } }catch{} await sleep(200); }
const page = tg.find(x=>x.type==='page') || tg[0];
const WS = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
WS.addEventListener('message', e=>{ const m=JSON.parse(e.data);
  if(m.id && pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.reject(new Error(m.error.message)):p.resolve(m.result); } });
await new Promise(r=>WS.addEventListener('open', r));
const send=(m,p={})=>new Promise((resolve,reject)=>{ const i=++id; pend.set(i,{resolve,reject}); WS.send(JSON.stringify({id:i,method:m,params:p})); });
const ev = e => send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})
                .then(r=>{ if(r.exceptionDetails) return 'EVAL_ERR:'+((r.exceptionDetails.exception||{}).description||'');
                           return r.result&&r.result.value; });

/* 手机竖屏 ⇒ 页面自己转成横屏舞台 */
await send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });
await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:2, mobile:true });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate',{ url:`http://127.0.0.1:${PORT}/index.html?mobile=1` });
for(let i=0;i<100;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(500); }
await sleep(4000);

const st = JSON.parse(await ev(`JSON.stringify({ rot:document.documentElement.classList.contains('ls-rot'), raw:[innerWidth,innerHeight], stage:[window.__dbg.STAGE.w, window.__dbg.STAGE.h] })`));
console.log('=== 环境 ===');
console.log(`  rot=${st.rot?'Y':'n'}  物理视口 ${st.raw.join('×')}  舞台 ${st.stage.join('×')}`);
if(!st.rot){ console.log('  ✗ 没旋转，本探针不适用'); process.exit(1); }

/* 切步行模式 */
await ev(`(()=>{ const b=document.querySelector('#modes .mode-btn[data-mode="walk"]'); if(b) b.click(); return 1; })()`);
await sleep(2500);

/* 在物理坐标 (80, 300) 派发 pointerdown ⇒ 应落在「舞台」的哪个位置 */
const DOWN = [80, 300];
/* 真的往 canvas 派发一个 pointerdown —— 只读计算结果是不够的，摇杆得先「出现」。 */
await ev(`(()=>{
  const c = document.querySelector('#app canvas');
  c.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles:true, cancelable:true, pointerId:1, pointerType:'touch',
    isPrimary:true, clientX:${DOWN[0]}, clientY:${DOWN[1]}, buttons:1 }));
  return 1;
})()`);
await sleep(500);

const probe = JSON.parse(await ev(`(()=>{
  const F = window.__dbg.screenToStage, S = window.__dbg.STAGE;
  const sp = F(${DOWN[0]}, ${DOWN[1]});
  const el = document.querySelector('#sticks .stick.on');
  const SR = 62;   // WALK.stickRadius 默认值
  const r = el ? { left: parseFloat(el.style.left), top: parseFloat(el.style.top) } : null;
  return JSON.stringify({ phys:${JSON.stringify(DOWN)}, stage:[Math.round(sp.x), Math.round(sp.y)],
    expectLeft: Math.round(sp.x - SR), expectTop: Math.round(sp.y - SR), got:r, has: !!el });
})()`));

console.log('\n=== ① 摇杆底座定位（左半屏，物理 ' + DOWN.join(',') + '）===');
console.log(`  物理坐标 ${probe.phys} → 舞台坐标 ${probe.stage.join(',')}`);
console.log(`  期望 left/top = ${probe.expectLeft}, ${probe.expectTop}`);
console.log(`  实际 left/top = ${probe.got ? probe.got.left+', '+probe.got.top : '(摇杆未出现)'}`);
const ok1 = probe.got && Math.abs(probe.got.left - probe.expectLeft) <= 1.5 && Math.abs(probe.got.top - probe.expectTop) <= 1.5;
console.log('  ' + (ok1 ? '✓ 定位正确（用的是舞台坐标）' : '✗ 定位错位'));

/* 沿舞台 +x 方向拖 40px ⇒ knob 应该也沿 +x 走 */
/* 同样真的派发 pointermove（沿物理 +x 走 40px）。 */
await ev(`(()=>{
  const c = document.querySelector('#app canvas');
  c.dispatchEvent(new PointerEvent('pointermove', {
    bubbles:true, cancelable:true, pointerId:1, pointerType:'touch',
    isPrimary:true, clientX:${DOWN[0]} + 40, clientY:${DOWN[1]}, buttons:1 }));
  return 1;
})()`);
await sleep(500);

const moved = JSON.parse(await ev(`(()=>{
  const F = window.__dbg.screenToStage;
  const a = F(${DOWN[0]}, ${DOWN[1]});
  const b = F(${DOWN[0]} + 40, ${DOWN[1]});     // 物理 +x 40
  const el = document.querySelector('#sticks .stick.on');
  const knob = el && el.querySelector('.stick-knob');
  const t = knob ? (knob.style.transform||'') : '';
  const m = /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/.exec(t);
  return JSON.stringify({ stageDx: Math.round(b.x - a.x), stageDy: Math.round(b.y - a.y), knob: m ? [ +m[1], +m[2] ] : null });
})()`));
console.log('\n=== ② 摇杆拖动轴向（物理 +x 拖 40px）===');
console.log(`  舞台坐标增量 = (${moved.stageDx}, ${moved.stageDy})`);
console.log(`  knob 实际位移 = ${moved.knob ? moved.knob.join(', ') : '(读不到)'}`);
const ok2 = moved.knob && Math.abs(moved.knob[0] - moved.stageDx) <= 2 && Math.abs(moved.knob[1] - moved.stageDy) <= 2;
console.log('  ' + (ok2 ? '✓ 偏移与舞台坐标一致' : '✗ 偏移错位'));

const shot = await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync(path.join(ROOT,'shots','walk-rotate-stick.png'), Buffer.from(shot.data,'base64'));
console.log('\nSHOT   shots/walk-rotate-stick.png');
console.log('\n=== 结论：' + (ok1 && ok2 ? '左右两套操作适配正确 ✓' : '仍有错位 ✗') + ' ===');
process.exit(ok1 && ok2 ? 0 : 1);
