/* 点「好·开始」之后的实拍：验证 ① 画面转正 ② UI 左一列/右一列 ③ 触摸映射。
 * 竖屏门盖住整个屏幕时截图只能看到门，必须先点掉门。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8233, CDB = 9417;
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
await send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:5 });
/** 用 iPhone 14 的物理尺寸竖屏 */
await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:2, mobile:true });
await send('Page.navigate',{ url:`http://127.0.0.1:${PORT}/index.html?mobile=1` });
for(let i=0;i<100;i++){ if(await ev('!!(window.__dbg && window.__dbg.scene)')) break; await sleep(500); }
await sleep(4000);

/* 门应当可见 */
console.log('GATE    ', await ev(`(()=>{ const g=document.getElementById('rotateGate');
  const cs=getComputedStyle(g); return JSON.stringify({ display:cs.display, ack:document.documentElement.classList.contains('ls-ack') }); })()`));

/* 点「好·开始」—— 必须保留旋转（不该调反向旋转） */
console.log('CLICK OK', await ev(`(()=>{ const b=document.getElementById('rotateOk'); if(!b) return 'no-btn'; b.click();
  const h=document.documentElement;
  return JSON.stringify({ rot:h.classList.contains('ls-rot'), ack:h.classList.contains('ls-ack'),
                          bodyW:document.body.style.width, bodyH:document.body.style.height }); })()`));
await sleep(2500);

/* UI 分栏断言：左右两列的元素各自的物理位置 */
const geo = JSON.parse(await ev(`(()=>{
  const pick=(id)=>{ const e=document.getElementById(id); if(!e) return null;
    const r=e.getBoundingClientRect();
    const F=window.__dbg.screenToStage, S=window.__dbg.STAGE;
    const c=F(r.x+r.width/2, r.y+r.height/2);        // 元素中心 → 舞台坐标
    return { id, sx:Math.round(c.x), sy:Math.round(c.y),
             x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height) }; };
  return JSON.stringify(['hud-tl','scene-ui','ui-toggle','modes','jump-btn'].map(pick)); })()`));

console.log('\n=== UI 位置（换算成**舞台**坐标，舞台 '+geo[0].sx+' 宽）===');
const mid = 844/2;
for (const g of geo){
  if(g.w===0){ console.log('  '+g.id.padEnd(10)+' (未显示)'); continue; }
  const side = g.sx < mid ? '左列' : '右列';
  console.log('  '+g.id.padEnd(10)+' 舞台 x='+String(g.sx).padStart(4)+' y='+String(g.sy).padStart(4)+
              '  '+side+'  '+(g.sy<60?'(顶)':g.sy>300?'(底)':'(中)'));
}

/* 触摸映射断言：物理左边缘 (10,400) 应映射到舞台 (400, rawW-10=380) —— 即舞台底部附近 */
const map = JSON.parse(await ev(`(()=>{ const S=window.__dbg.STAGE, F=window.__dbg.screenToStage;
  const pts=[[5,422],[390-5,422],[5,5],[390-5,844-5],[195,422]];
  return JSON.stringify({ STAGE:{w:S.w,h:S.h,rawW:S.rawW,rawH:S.rawH,rot:S.rot},
    mapped: pts.map(([x,y])=>{ const r=F(x,y); return [Math.round(r.x),Math.round(r.y)]; }) }); })()`));
console.log('\n=== 触摸映射（物理 → 舞台）===');
console.log('  STAGE =', JSON.stringify(map.STAGE));
console.log('  物理(5,422)→', map.mapped[0], ' 物理(385,422)→', map.mapped[1]);
console.log('  物理(5,5)→', map.mapped[2], ' 物理(385,839)→', map.mapped[3], ' 物理中点→', map.mapped[4]);
const okMap = map.mapped[0][0] === 422 && map.mapped[1][0] === 422;   // 物理中线两侧应落在舞台不同侧
console.log('  中线两侧映射到舞台不同侧:', okMap ? '✓' : '✗');

await shot('landscape-ui.png');
console.log('\nSHOT   shots/landscape-ui.png');
process.exit(0);
