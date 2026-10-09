/* 验证强制横屏「自由模式」(OrbitControls) 的拖拽轴向（2026-10-10）
 *
 * 修复：自由模式下跳过 fixEventCoords，OrbitControls 直接读原始物理坐标。
 * 断言：
 *   · 物理「横拖」→ 水平环绕（yaw 变、pitch≈0；固定世界锚点 NDC 以水平位移为主）
 *   · 物理「竖拖」→ 俯仰（pitch 变、yaw≈0；锚点 NDC 以垂直位移为主）
 * 每次拖拽都重新加载页面，避免 OrbitControls 手势态串扰。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8252, CDB = 9434;
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
const sleepCDP = ms => new Promise(r=>setTimeout(r, ms));

async function loadFresh(){
  await send('Page.navigate',{ url:`http://127.0.0.1:${PORT}/index.html?mobile=1` });
  for(let i=0;i<100;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(400); }
  await sleep(3500);
  await ev('Element.prototype.setPointerCapture=function(){};Element.prototype.releasePointerCapture=function(){};1');
  return JSON.parse(await ev(`JSON.stringify({
    rot: document.documentElement.classList.contains('ls-rot'),
    free: window.__dbg.controls.enabled })`));
}

const readView = async () => JSON.parse(await ev(`(()=>{
  const c=window.__dbg.camera, t=window.__dbg.controls.target;
  const f={x:t.x-c.position.x, y:t.y-c.position.y, z:t.z-c.position.z};
  const fl=Math.hypot(f.x,f.y,f.z); f.x/=fl; f.y/=fl; f.z/=fl;
  const yaw=Math.atan2(f.x, f.z), pitch=Math.asin(Math.max(-1,Math.min(1,f.y)));
  const v=new window.__dbg.THREE.Vector3(0,2,0).project(c);   // 固定世界点
  return JSON.stringify({ yaw, pitch, ndc:[+v.x.toFixed(4), +v.y.toFixed(4)] });
})()`));

async function drag(dx, dy){
  const cx=195, cy=422;
  await ev(`(()=>{ const c=document.querySelector('#app canvas');
    c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',button:0,buttons:1,clientX:${cx},clientY:${cy}})); return 1; })()`);
  await sleep(120);
  for(let i=1;i<=6;i++){
    await ev(`(()=>{ const c=document.querySelector('#app canvas');
      c.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',buttons:1,clientX:${cx+dx*i/6},clientY:${cy+dy*i/6}})); return 1; })()`);
    await sleep(40);
  }
  await sleep(300);
  await ev(`(()=>{ const c=document.querySelector('#app canvas');
    c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',button:0,buttons:0,clientX:${cx+dx},clientY:${cy+dy}})); return 1; })()`);
  await sleep(200);
}

const norm = a => { while(a> Math.PI) a-=2*Math.PI; while(a< -Math.PI) a+=2*Math.PI; return a; };

let pass = true;

// ---- 横拖 ----
let env = await loadFresh();
console.log('=== 环境 ===  rot='+(env.rot?'Y':'n')+'  controls.enabled='+env.free);
if(!env.rot || env.free!==true){ console.log('  ✗ 环境不满足'); process.exit(1); }
console.log('\n--- 横拖（物理 +x 60）---');
const bH = await readView(); await drag(60,0); const aH = await readView();
const yH=norm(aH.yaw-bH.yaw), pH=aH.pitch-bH.pitch, dHx=aH.ndc[0]-bH.ndc[0], dHy=aH.ndc[1]-bH.ndc[1];
console.log(`  yaw Δ=${yH.toFixed(4)}  pitch Δ=${pH.toFixed(4)}  锚点NDC Δ=(${dHx.toFixed(4)}, ${dHy.toFixed(4)})`);
const okH = Math.abs(yH)>0.05 && Math.abs(pH)<0.02 && Math.abs(dHx)>Math.abs(dHy)*2.5;
console.log('  '+(okH?'✓ 横拖=水平环绕':'✗ 横拖轴向异常')); pass = pass && okH;

// ---- 竖拖（重新加载隔离）----
env = await loadFresh();
console.log('\n--- 竖拖（物理 +y 60）---');
const bV = await readView(); await drag(0,60); const aV = await readView();
const yV=norm(aV.yaw-bV.yaw), pV=aV.pitch-bV.pitch, dVx=aV.ndc[0]-bV.ndc[0], dVy=aV.ndc[1]-bV.ndc[1];
console.log(`  yaw Δ=${yV.toFixed(4)}  pitch Δ=${pV.toFixed(4)}  锚点NDC Δ=(${dVx.toFixed(4)}, ${dVy.toFixed(4)})`);
const okV = Math.abs(pV)>0.05 && Math.abs(yV)<0.02 && Math.abs(dVy)>Math.abs(dVx)*2.5;
console.log('  '+(okV?'✓ 竖拖=俯仰':'✗ 竖拖轴向异常')); pass = pass && okV;

console.log('\n=== 结论：' + (pass ? '自由模式拖拽轴向正确（横=水平环绕 / 竖=俯仰）✓' : '仍有轴向错乱 ✗') + ' ===');
process.exit(pass ? 0 : 1);
