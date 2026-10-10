/* 验证强制横屏「自由模式」(OrbitControls) 的拖拽轴向 —— 在【真实屏幕空间】里测。
 *
 * ⚠ 之前那版测的是 stage 空间 NDC，但用户看到的是 CSS 旋转 90° 之后的【屏幕空间】。
 *   stage-x 经 90° 旋转后变成屏幕-y（垂直），所以「stage 水平」≠「屏幕水平」，
 *   那版判据正好和用户的感知相反 → 假阳性。本版用临时 DOM 元素（body 是被旋转的元素），
 *   让浏览器把 stage 坐标点投影到【真实屏幕像素】，再比较拖拽前/后该点的屏幕位移主轴。
 *
 * 正确判据（用户视角）：
 *   左右滑动(clientX 变) → 屏幕上【水平】位移（Δsx 为主）= 左右旋转  ✓
 *   上下滑动(clientY 变) → 屏幕上【垂直】位移（Δsy 为主）= 上下旋转  ✓
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

// 投影一个固定在世界里的点（look-at 点上方 2 单位），用临时 DOM 元素得到它【真实屏幕像素】位置。
const readAnchorScreen = async () => JSON.parse(await ev(`(()=>{
  const c=window.__dbg.camera, t=window.__dbg.controls.target, T=window.__dbg.THREE;
  const p=new T.Vector3(t.x + 5, t.y + 1, t.z + 3);   // 偏离旋转轴，确保 azimuth/polar 都能让它明显移动
  const v=p.clone().project(c);                       // stage 空间 NDC
  const cv=document.querySelector('#app canvas');
  const cw=cv.clientWidth, ch=cv.clientHeight;         // 未旋转布局尺寸
  const lx=(v.x*0.5+0.5)*cw, ly=(-v.y*0.5+0.5)*ch;    // stage 局部像素
  const d=document.createElement('div');
  d.style.cssText='position:absolute;left:'+lx+'px;top:'+ly+'px;width:1px;height:1px;background:red;';
  document.body.appendChild(d);                        // body 是被 CSS 旋转的元素 → 浏览器给出真实屏幕位置
  const r=d.getBoundingClientRect(); const sx=r.left+r.width/2, sy=r.top+r.height/2;
  d.remove();
  return JSON.stringify({ sx:+sx.toFixed(1), sy:+sy.toFixed(1) });
})()`));

async function drag(dx, dy){
  const cx=215, cy=466;
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

console.log('\n--- 左右滑动（clientX +60，物理屏幕水平）---');
const bH = await readAnchorScreen(); await drag(60,0); const aH = await readAnchorScreen();
const dHx=aH.sx-bH.sx, dHy=aH.sy-bH.sy;
console.log(`  屏幕位移 Δ=(${dHx.toFixed(1)}, ${dHy.toFixed(1)})  |Δx|=${Math.abs(dHx).toFixed(1)}  |Δy|=${Math.abs(dHy).toFixed(1)}`);
const okH = Math.abs(dHx) > Math.abs(dHy)*2.5;   // 屏幕【水平】位移 = 左右旋转 ✓
console.log('  '+(okH?'✓ 左右滑动→屏幕水平(左右旋转)':'✗ 左右滑动→屏幕垂直(上下旋转) [轴反了]')); pass = pass && okH;

env = await loadFresh();
console.log('\n--- 上下滑动（clientY +60，物理屏幕垂直）---');
const bV = await readAnchorScreen(); await drag(0,60); const aV = await readAnchorScreen();
const dVx=aV.sx-bV.sx, dVy=aV.sy-bV.sy;
console.log(`  屏幕位移 Δ=(${dVx.toFixed(1)}, ${dVy.toFixed(1)})  |Δx|=${Math.abs(dVx).toFixed(1)}  |Δy|=${Math.abs(dVy).toFixed(1)}`);
const okV = Math.abs(dVy) > Math.abs(dVx)*2.5;   // 屏幕【垂直】位移 = 上下旋转 ✓
console.log('  '+(okV?'✓ 上下滑动→屏幕垂直(上下旋转)':'✗ 上下滑动→屏幕水平(左右旋转) [轴反了]')); pass = pass && okV;

console.log('\n=== 结论：' + (pass ? '自由模式拖拽轴向正确（左↔左右、上↔上下）✓' : '仍有轴向错乱 ✗') + ' ===');
process.exit(pass ? 0 : 1);
