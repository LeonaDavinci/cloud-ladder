/* 排查「截图检查，没有横屏」：直接访问**线上地址**，不��� ?mobile=1，
 * 看真实移动设备模拟下 IS_TOUCH / ls-rot / body 尺寸到底是什么。
 * 重点确认：navigator.maxTouchPoints 在无头里到底给不给值 ——
 * 如果给 0，那真机上大概率没问题（iOS Safari 是 5），但桌面浏览器永远是 0，
 * 桌面窗口按设计就不旋转。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8235, CDB = 9419;
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
let id=0; const pend=new Map();
WS.addEventListener('message', e=>{ const m=JSON.parse(e.data);
  if(m.id && pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.reject(new Error(m.error.message)):p.resolve(m.result); } });
await new Promise(r=>WS.addEventListener('open', r));
const send=(m,p={})=>new Promise((resolve,reject)=>{ const i=++id; pend.set(i,{resolve,reject}); WS.send(JSON.stringify({id:i,method:m,params:p})); });
const ev = e => send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})
                .then(r=>{ if(r.exceptionDetails) return 'EVAL_ERR:'+((r.exceptionDetails.exception||{}).description||'');
                           return r.result&&r.result.value; });
const shot = async f => { const s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(ROOT,'shots',f), Buffer.from(s.data,'base64')); };

await send('Page.enable'); await send('Runtime.enable');

async function probe(label, { mobile, touch, w, h, url, file }){
  if (touch !== undefined)
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await send('Emulation.setDeviceMetricsOverride',
             { width:w, height:h, deviceScaleFactor:2, mobile: !!mobile });
  await send('Page.navigate',{ url });
  for(let i=0;i<100;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(500); }
  await sleep(3500);
  const r = JSON.parse(await ev(`JSON.stringify({
    mtp: navigator.maxTouchPoints,
    pointerCoarse: matchMedia('(pointer:coarse)').matches,
    IS_TOUCH: (navigator.maxTouchPoints>1),
    rot: document.documentElement.classList.contains('ls-rot'),
    bodyW: document.body.style.width, bodyH: document.body.style.height,
    vw: innerWidth, vh: innerHeight,
    metaLandscape: !!document.querySelector('meta[name=screen-orientation]'),
    gateDisplay: (document.getElementById('rotateGate')||{ }).style ? getComputedStyle(document.getElementById('rotateGate')).display : 'n/a'
  })`));
  const rotExpect = r.mtp > 1 ? (r.vh > r.vw) : false;
  console.log(`  ${r.rot===rotExpect?'✓':'✗'} ${label.padEnd(26)} mtp=${r.mtp} coarse=${r.pointerCoarse?'Y':'n'} 视口=${r.vw}×${r.vh} rot=${r.rot?'Y':'n'} body=${r.bodyW||'(空)'}×${r.bodyH||'(空)'} gate=${r.gateDisplay}`);
  if (file) await shot(file);
  return r;
}

const LOCAL = `http://127.0.0.1:${PORT}/index.html`;
const ONLINE = 'https://cloud-ladder-dream.app.workbuddy.host/index.html';

console.log('=== 本地源码：不带任何参数（= 用户正常访问的样子）===');
await probe('手机竖屏 390×844', { mobile:true, touch:true,  w:390, h:844, url:LOCAL, file:'rot-mobile-390.png' });
await probe('手机横屏 844×390', { mobile:true, touch:true,  w:844, h:390, url:LOCAL });
console.log('\n=== 桌面浏览器（无触摸）===');
await probe('桌面 1280×720', { mobile:false, touch:false, w:1280, h:720, url:LOCAL, file:'rot-desktop-1280.png' });
await probe('桌面窄窗 800×1000', { mobile:false, touch:false, w:800, h:1000, url:LOCAL });

console.log('\n=== 线上（真实地址）===');
await probe('线上 手机竖屏', { mobile:true, touch:true, w:390, h:844, url:ONLINE, file:'rot-online-mobile.png' });
await probe('线上 桌面', { mobile:false, touch:false, w:1280, h:720, url:ONLINE });
process.exit(0);
