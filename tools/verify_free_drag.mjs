/* 验证强制横屏「自由模式」(OrbitControls) 的拖拽轴向 —— 在【视觉帧】里测。
 *
 * 关键：CSS 把舞台旋转了 90°，world-up 在屏幕上看起来是水平的。所以 OrbitControls 的
 * azimuth（绕 world-up）在屏幕上表现为【水平】运动，polar（绕 world-X）表现为【垂直】运动。
 * 用户的「左右滑动」= 手指在设备屏幕上沿 clientX 方向滑动；要正确，必须让：
 *   左右滑动(clientX) → 屏幕上【水平】运动（锚点 NDC.x 变化占主导）= 左右旋转
 *   上下滑动(clientY) → 屏幕上【垂直】运动（锚点 NDC.y 变化占主导）= 上下旋转
 * 这里不靠手推，直接真派发拖拽 + 投影固定世界点，看 NDC 位移以哪个轴为主。
 *
 * 用竖屏窗口(430x932)强制 shouldRotate 触发（rawH>rawW）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8253, CDB = 9435;
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

async function loadFresh(){
  await send('Page.navigate',{ url:`http://127.0.0.1:${PORT}/index.html?mobile=1${process.env.FLIP?'&flip=1':''}` });
  for(let i=0;i<120;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(400); }
  await sleep(3500);
  await ev('Element.prototype.setPointerCapture=function(){};Element.prototype.releasePointerCapture=function(){};1');
  return JSON.parse(await ev(`JSON.stringify({
    rot: document.documentElement.classList.contains('ls-rot'),
    flip: document.documentElement.classList.contains('ls-flip'),
    free: window.__dbg.controls.enabled })`));
}

// 投影一个固定在世界里的点（look-at 点上方 2 单位），看它在屏幕(NDC)上往哪动
const readAnchor = async () => JSON.parse(await ev(`(()=>{
  const c=window.__dbg.camera, t=window.__dbg.controls.target;
  const p=new window.__dbg.THREE.Vector3(t.x, t.y+2, t.z);   // 世界固定点
  const v=p.clone().project(c);
  return JSON.stringify({ ndc:[+v.x.toFixed(4), +v.y.toFixed(4)] });
})()`));

async function drag(dx, dy){
  const cx=215, cy=466;   // 落在画布范围内（430x932 视口里旋转后的画布）
  await ev(`(()=>{ const c=document.querySelector('#app canvas');
    c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',button:0,buttons:1,clientX:${cx},clientY:${cy}})); return 1; })()`);
  await sleep(120);
  for(let i=1;i<=6;i++){
    await ev(`(()=>{ const c=document.querySelector('#app canvas');
      c.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',buttons:1,clientX:${cx+dx*i/6},clientY:${cy+dy*i/6}})); return 1; })()`);
    await sleep(40);
  }
  await sleep(350);
  await ev(`(()=>{ const c=document.querySelector('#app canvas');
    c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',button:0,buttons:0,clientX:${cx+dx},clientY:${cy+dy}})); return 1; })()`);
  await sleep(250);
}

let pass = true;
let env = await loadFresh();
console.log('=== 环境 ===  rot='+(env.rot?'Y':'n')+(env.flip?' (flip)':'')+'  controls.enabled='+env.free);
if(!env.rot || env.free!==true){ console.log('  ✗ 环境不满足'); process.exit(1); }

console.log('\n--- 左右滑动（clientX +60）---');
const bH = await readAnchor(); await drag(60,0); const aH = await readAnchor();
const dHx=aH.ndc[0]-bH.ndc[0], dHy=aH.ndc[1]-bH.ndc[1];
console.log(`  锚点 NDC Δ=(${dHx.toFixed(4)}, ${dHy.toFixed(4)})  |Δx|=${Math.abs(dHx).toFixed(4)}  |Δy|=${Math.abs(dHy).toFixed(4)}`);
const okH = Math.abs(dHx) > Math.abs(dHy)*2.5;   // 屏幕上【水平】运动 = 左右旋转
console.log('  '+(okH?'✓ 左右滑动→左右旋转(水平)':'✗ 左右滑动→上下旋转(垂直) [轴反了]')); pass = pass && okH;

env = await loadFresh();
console.log('\n--- 上下滑动（clientY +60）---');
const bV = await readAnchor(); await drag(0,60); const aV = await readAnchor();
const dVx=aV.ndc[0]-bV.ndc[0], dVy=aV.ndc[1]-bV.ndc[1];
console.log(`  锚点 NDC Δ=(${dVx.toFixed(4)}, ${dVy.toFixed(4)})  |Δx|=${Math.abs(dVx).toFixed(4)}  |Δy|=${Math.abs(dVy).toFixed(4)}`);
const okV = Math.abs(dVy) > Math.abs(dVx)*2.5;   // 屏幕上【垂直】运动 = 上下旋转
console.log('  '+(okV?'✓ 上下滑动→上下旋转(垂直)':'✗ 上下滑动→左右旋转(水平) [轴反了]')); pass = pass && okV;

console.log('\n=== 结论：' + (pass ? '自由模式拖拽轴向正确（左↔左右、上↔上下）✓' : '仍有轴向错乱 ✗') + ' ===');
process.exit(pass ? 0 : 1);
