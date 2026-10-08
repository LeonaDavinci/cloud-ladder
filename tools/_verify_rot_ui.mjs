/* 复验「横屏真的生效」+ UI 三项调整
 *  ① 桌面竖窗（800×1000）现在也该转 —— 之前 IS_TOUCH 门控让它永不转
 *  ② 看电视按钮在**底部正中**
 *  ③ 雾档在时相**上面**
 *  ④ 隐藏 UI 在**右下角**
 * 期望值不再用 mtp>1 判断（IS_TOUCH 已改成三路或，mtp=0 但 pointer:coarse 也算触摸）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8237, CDB = 9421;
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

/* ---- ① 桌面竖窗：以前永不转，现在该转 ---- */
await send('Emulation.setTouchEmulationEnabled', { enabled:false, maxTouchPoints:1 });
await send('Emulation.setDeviceMetricsOverride', { width:800, height:1000, deviceScaleFactor:1, mobile:false });
await send('Page.navigate',{ url:`http://127.0.0.1:${PORT}/index.html` });
for(let i=0;i<100;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(500); }
await sleep(3500);
const d = JSON.parse(await ev(`JSON.stringify({
  vw:innerWidth, vh:innerHeight,
  rot: document.documentElement.classList.contains('ls-rot'),
  bodyW: document.body.style.width, bodyH: document.body.style.height,
  gate: (function(){ const g=document.getElementById('rotateGate'); return g?getComputedStyle(g).display:'n/a'; })()
})`));
console.log('=== ① 桌面竖窗 800×1000（无触摸）===');
console.log(`   rot=${d.rot?'Y':'n'}  body=${d.bodyW||'(空)'}×${d.bodyH||'(空)'}  gate=${d.gate}`);
console.log('  ', d.vh>d.vw ? (d.rot && d.bodyW==='1000px' ? '✓ 已按「画面横版」旋转' : '✗ 没转') : '视口本来就是横的，不该转');
await shot('rot-desktop-portrait.png');

/* ---- 点门进游戏，量 UI 三项 ---- */
await ev(`(()=>{ const b=document.getElementById('rotateOk'); if(b) b.click(); return 1; })()`);
await sleep(1500);
await ev(`window.__dbg.atmos.apply('night')`);
await sleep(2500);
await sleep(2500);
const ui = JSON.parse(await ev(`(()=>{
  // ⚠ 用 offset* 而不是 getBoundingClientRect：后者返回的是**物理**坐标，
  // 旋转 90° 后「上/下」变成了「右/左」，量出来的东西没有可比性。
  // offset* 是相对 offsetParent 的**布局**位置，不受 CSS transform 影响。
  const m = (id)=>{ const e=document.getElementById(id); if(!e) return null;
    return { top:e.offsetTop, left:e.offsetLeft, w:e.offsetWidth, h:e.offsetHeight,
             pos:getComputedStyle(e).position }; };
  return JSON.stringify({ stage:{w:window.__dbg.STAGE.w,h:window.__dbg.STAGE.h},
    time:m('ui-time'), fog:m('ui-fog'), filter:m('ui-filter'),
    proj:m('ui-projector'), toggle:m('ui-toggle'),
    projBtn:(document.querySelector('#ui-projector button')||{}).textContent }); })()`));
console.log('\n=== UI 三项调整（舞台 '+ui.stage.w+'×'+ui.stage.h+'，offset 坐标）===');
console.log('  ① 雾 top=%d / 时相 top=%d / 滤镜 top=%d  ⇒ %s', ui.fog.top, ui.time.top, ui.filter.top,
            (ui.fog.top < ui.time.top && ui.time.top < ui.filter.top) ? '✓ 雾在时相上、时相在滤镜上' : '✗ 顺序不对');
console.log('  ③ 看电视 position=%s left=%d w=%d（舞台宽 %d，居中应≈%d） %s',
            ui.proj.pos, ui.proj.left, ui.proj.w, ui.stage.w, (ui.stage.w-ui.proj.w)/2,
            (ui.proj.pos==='fixed' && Math.abs(ui.proj.left-(ui.stage.w-ui.proj.w)/2)<40) ? '✓ 底部居中(脱流)' : '✗');
console.log('     按钮文字 =', ui.projBtn);
console.log('  ④ 隐藏 UI left=%d w=%d（舞台宽 %d，靠右应 >%d） %s',
            ui.toggle.left, ui.toggle.w, ui.stage.w, ui.stage.w*0.6,
            ui.toggle.left > ui.stage.w*0.6 ? '✓ 在右下' : '✗ 还在左侧');
console.log('  ④ 隐藏 UI：left=%d（视口宽 800，右下应靠右） %s',
            ui.toggle.left, ui.toggle.left > 800*0.6 ? '✓ 在右侧' : '✗ 还在左侧');

await shot('rot-ui-adjusted.png');
console.log('\nSHOT   shots/rot-ui-adjusted.png');
process.exit(0);
