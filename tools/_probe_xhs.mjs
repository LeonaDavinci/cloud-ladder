// 决定论诊断：复现「打包产物在小红书」的两种加载路径
//   node _probe_xhs.mjs normal   -> 不拦截，走 loader.load(包内文件)（同本地预览的 fetch 路径）
//   node _probe_xhs.mjs block     -> 拦截 bed2.glb.json 请求失败，强制走内联 base64 兜底（同小红书 fetch 被禁）
// 输出床可见材质的 hasMap / map.image 尺寸 / __bedSrc.via，以及画布采样像素。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DIST = 'E:/workbuddy/cloud-ladder/dist-minitool';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCENARIO = process.argv[2] || 'normal';
const PORT = 8231;
const CDB_PORT = 9341;

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp3':'audio/mpeg','.ico':'image/x-icon',
  '.glb':'model/gltf-binary','.gltf':'model/gltf+json',
};

const server = http.createServer((req,res)=>{
  let u = req.url.split('?')[0];
  if (u === '/') u = '/index.html';
  const fp = path.join(DIST, u);
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
let msgId = 0; const pending = new Map(); const events = [];
function send(method, params={}){
  return new Promise((resolve,reject)=>{
    const id = ++msgId; pending.set(id,{resolve,reject});
    WS.send(JSON.stringify({id, method, params}));
  });
}
WS.addEventListener('message', (e)=>{
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)){ const p=pending.get(msg.id); pending.delete(msg.id); msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result); }
  else if (msg.method){ events.push(msg); }
});
await new Promise(r=>WS.addEventListener('open', r));

await send('Page.enable');
await send('Runtime.enable');
await send('Fetch.enable', { patterns:[{urlPattern:'*', requestStage:'Request'}] });

// 请求拦截：block 场景让 GLB 文件请求失败 -> 触发内联 base64 兜底
WS.addEventListener('message', (e)=>{
  const msg = JSON.parse(e.data);
  if (msg.method === 'Fetch.requestPaused'){
    const { requestId, request } = msg.params;
    const isGlb = request.url.includes('bed2.glb.json');
    if (SCENARIO==='block' && isGlb){
      send('Fetch.failRequest', { requestId, errorReason:'Failed' }).catch(()=>{});
    } else {
      send('Fetch.continueRequest', { requestId }).catch(()=>{});
    }
  }
});

await send('Page.navigate', { url:`http://127.0.0.1:${PORT}/` });

// 等床 GLB 加载完成
const waitSrc = `(()=>{
  return new Promise((resolve)=>{
    const d=()=>{ try{
      if (window.__dbg && window.__dbg.bed && window.__dbg.bed.userData && window.__dbg.bed.userData.bedModel){
        resolve({ ok:true, via: (window.__bedSrc&&window.__bedSrc.via)||'?', note:(window.__bedSrc&&window.__bedSrc.note)||'' });
      } else { setTimeout(d,300); }
    }catch(e){ setTimeout(d,300); } };
    d();
    setTimeout(()=>resolve({ ok:false, via:'(timeout)', note:'' }), 40000);
  });
})`;
let src;
for (let i=0;i<40;i++){
  await new Promise(r=>setTimeout(r,1000));
  const r = await send('Runtime.evaluate', { expression: `(${waitSrc})()`, awaitPromise:true, returnByValue:true });
  if (r.result && r.result.value && r.result.value.ok){ src = r.result.value; break; }
  if (r.result && r.result.value && !r.result.value.ok){ src = r.result.value; break; }
}

const probe = `(()=>{
  const out = { via:(window.__bedSrc&&window.__bedSrc.via)||'?', note:(window.__bedSrc&&window.__bedSrc.note)||'' };
  const bed = window.__dbg && window.__dbg.bed;
  const mats = [];
  function meanRGB(data){ let r=0,g=0,b=0,n=data.length/4; for(let i=0;i<data.length;i+=4){r+=data[i];g+=data[i+1];b+=data[i+2];} return [r/n|0,g/n|0,b/n|0]; }
  if (bed) bed.traverse(o=>{ if(!o.isMesh||!o.visible) return; const m=Array.isArray(o.material)?o.material[0]:o.material;
    const isDT = !!(m&&m.map&&m.map.isDataTexture);
    const ca = (o.geometry&&o.geometry.attributes)?o.geometry.attributes.color:null;
    let aoStat=null;
    if(ca){ const arr=ca.array, is=ca.itemSize, sc=ca.normalized?(arr.BYTES_PER_ELEMENT===2?65535:255):1;
      let mn=2,mx=-1,s=0,n=0; for(let i=0;i<arr.length;i+=is){ const v=arr[i]/sc; if(v<mn)mn=v; if(v>mx)mx=v; s+=v; n++; }
      aoStat={ type:arr.constructor.name, itemSize:is, normalized:!!ca.normalized, count:ca.count,
               min:+mn.toFixed(4), max:+mx.toFixed(4), mean:+(s/n).toFixed(4) }; }
    mats.push({ name:o.name, hasMap:!!(m&&m.map), isDataTexture:isDT,
      mapW:(m&&m.map&&m.map.image&&m.map.image.width)||0, mapH:(m&&m.map&&m.map.image&&m.map.image.height)||0,
      bakedMean:(isDT&&m.map.image&&m.map.image.data)?meanRGB(m.map.image.data):null,
      vertexColors:!!(m&&m.vertexColors), ao:aoStat,
      color:(m&&m.color)?('#'+m.color.getHexString()):null, normal:(m&&m.normalMap)?true:false }); });
  out.materials = mats;
  out.bedTexPresent = !!window.BED_TEX;
  const A = window.__audio;
  out.audio = A ? { state:A.state, index:A.index, title:A.title,
                    files:(A.tracks||[]).map(t=>t.file),
                    bgm1Index:(A.tracks||[]).findIndex(t=>/^bgm-1-/.test(t.file||'')) } : null;
  try {
    const r = window.__dbg.renderer; const gl = r.getContext();
    const W=gl.drawingBufferWidth, H=gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    r.render(window.__dbg.scene, window.__dbg.camera);
    gl.readPixels((W/2)|0,(H/2)|0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);
    out.centerPixel = [px[0],px[1],px[2],px[3]];
  } catch(e){ out.sampleErr = String(e); }
  return out;
})`;
const pr = await send('Runtime.evaluate', { expression:`(${probe})()`, returnByValue:true });
const probeOut = pr.result && pr.result.value;

console.log('SCENARIO:', SCENARIO);
console.log('bedSrc  :', JSON.stringify(src));
console.log('probe   :', JSON.stringify(probeOut, null, 2));
try{
  const shot = await send('Page.captureScreenshot', { format:'png' });
  const p = `E:/workbuddy/cloud-ladder/shots/bed-ao-dist-${SCENARIO}.png`;
  fs.writeFileSync(p, Buffer.from(shot.data,'base64'));
  console.log('screenshot ->', p);
}catch(e){ console.log('screenshot skipped:', e.message); }

WS.close(); chrome.kill(); server.close();
process.exit(0);
