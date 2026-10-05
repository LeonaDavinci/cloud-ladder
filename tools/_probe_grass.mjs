// 草色验证：加载 ROOT 源码（已含本次改动），隐藏非草物体，采样草地像素的
// 平均饱和度 / 色相 / RGB，并截图。用于在「降饱和 + 偏黄」改动后给出量化证据。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8237;
const CDB_PORT = 9347;

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp3':'audio/mpeg','.ico':'image/x-icon',
  '.glb':'model/gltf-binary','.gltf':'model/gltf+json',
};
const server = http.createServer((req,res)=>{
  let u = req.url.split('?')[0];
  if (u === '/') u = '/index.html';
  const fp = path.join(ROOT, u);
  fs.readFile(fp, (err, data)=>{
    if (err){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control':'no-store'});
    res.end(data);
  });
});
await new Promise(r=>server.listen(PORT, r));

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDB_PORT}`,
], { stdio: 'ignore' });
process.on('exit', ()=>{ try{chrome.kill();}catch{} });

async function cdbGet(){
  for (let i=0;i<60;i++){
    try{ const r = await fetch(`http://127.0.0.1:${CDB_PORT}/json/list`); if (r.ok){ const j=await r.json(); if (j.length) return j; } }catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('chrome devtools not up');
}
const targets = await cdbGet();
const page = targets.find(t=>t.type==='page') || targets[0];
const wsUrl = page.webSocketDebuggerUrl;
const WS = new WebSocket(wsUrl);
let msgId = 0; const pending = new Map();
function send(method, params={}){
  return new Promise((resolve,reject)=>{
    const id = ++msgId; pending.set(id,{resolve,reject});
    WS.send(JSON.stringify({id, method, params}));
  });
}
WS.addEventListener('message', (e)=>{
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)){ const p=pending.get(msg.id); pending.delete(msg.id); msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result); }
});
await new Promise(r=>WS.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url:`http://127.0.0.1:${PORT}/` });

// 等 __dbg + 草建好
const waitSrc = `(()=>{ return new Promise((resolve)=>{
  const d=()=>{ try{
    const d_=window.__dbg;
    if (d_ && d_.grass && d_.grass.count>0 && d_.terrain && d_.renderer){ resolve({ok:true}); }
    else setTimeout(d,300);
  }catch(e){ setTimeout(d,300); } };
  d(); setTimeout(()=>resolve({ok:false}),45000);
})})`;
let ready=false;
for (let i=0;i<50;i++){
  await new Promise(r=>setTimeout(r,1000));
  const r = await send('Runtime.evaluate', { expression:`(${waitSrc})()`, awaitPromise:true, returnByValue:true });
  if (r.result && r.result.value && r.result.value.ok){ ready=true; break; }
}
console.log('ready:', ready);
if(!ready){ WS.close(); chrome.kill(); server.close(); process.exit(1); }

// 隐藏非草物体 + 摆一个能看草的机位
const setup = `(()=>{
  const d=window.__dbg;
  ['bed','ladder','butterflies','glints','daisies','lavender','clouds','cloudGroup','sky','mountains'].forEach(k=>{ if(d[k]) d[k].visible=false; });
  const b=d.bed.position, c=d.camera;
  c.position.set(b.x+3.2, b.y+1.4, b.z+3.6);
  d.controls.target.set(b.x, b.y+0.5, b.z);
  d.controls.update();
  return { grassCount:d.grass.count, tuft: d.tufts? d.tufts.count:0 };
})`;
const sres = await send('Runtime.evaluate', { expression:`(${setup})()`, returnByValue:true });
console.log('setup:', JSON.stringify(sres.result && sres.result.value));

await new Promise(r=>setTimeout(r,400)); // 让一帧渲染完

// 采样草地像素（黄-绿色相带），算平均 饱和度 / 色相 / RGB
const sample = `(()=>{
  const r=d=>window.__dbg.renderer, d=window.__dbg;
  const R=d.renderer, gl=R.getContext();
  const W=gl.drawingBufferWidth, H=gl.drawingBufferHeight;
  R.render(d.scene, d.camera);
  const buf=new Uint8Array(W*H*4);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  function hsl(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2; let h=0,s=0; const df=mx-mn;
    if(df>1e-6){ s=l>0.5?df/(2-mx-mn):df/(mx+mn);
      if(mx===r) h=(g-b)/df+(g<b?6:0); else if(mx===g) h=(b-r)/df+2; else h=(r-g)/df+4; h/=6; }
    return [h*360,s*100,l*100]; }
  let n=0,sSum=0,hSum=0,rr=0,gg=0,bb=0;
  for(let i=0;i<buf.length;i+=4){
    const R=buf[i],G=buf[i+1],B=buf[i+2];
    const [h,s,l]=hsl(R,G,B);
    if(h>=45 && h<=175 && s>=12 && l>=18 && l<=85){ n++; sSum+=s; hSum+=h; rr+=R; gg+=G; bb+=B; }
  }
  return n? { pixels:n, meanS:+(sSum/n).toFixed(1), meanHue:+(hSum/n).toFixed(1),
              meanRGB:[ (rr/n)|0,(gg/n)|0,(bb/n)|0 ] } : { pixels:0 };
})`;
const pres = await send('Runtime.evaluate', { expression:`(${sample})()`, returnByValue:true });
console.log('grassStats:', JSON.stringify(pres.result && pres.result.value));

try{
  const shot = await send('Page.captureScreenshot', { format:'png' });
  fs.writeFileSync('E:/workbuddy/cloud-ladder/shots/grass-color.png', Buffer.from(shot.data,'base64'));
  console.log('screenshot -> shots/grass-color.png');
}catch(e){ console.log('screenshot skipped:', e.message); }

WS.close(); chrome.kill(); server.close();
process.exit(0);
