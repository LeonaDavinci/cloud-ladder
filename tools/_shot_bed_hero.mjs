// 床近景 A/B 出图（真实场景 + 后处理，所见即所得）
//   node tools/_shot_bed_hero.mjs <tag>
// 服务 ROOT 源码，等床加载完，把相机摆到床的 3/4 近景（保留草地/天空/后期），
// 用 CDP 截屏（经 postfx）存 shots/bed-ao-hero-<tag>.png。
// 配合「换 models/bed2.glb.json → 再跑一次」做前后对比。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TAG = process.argv[2] || 'x';
const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8249, CDB_PORT = 9359;

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.mp3':'audio/mpeg','.ico':'image/x-icon' };
const server = http.createServer((req, res) => {
  let u = req.url.split('?')[0]; if (u === '/') u = '/index.html';
  fs.readFile(path.join(ROOT, u), (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(u)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(data);
  });
});
await new Promise(r => server.listen(PORT, r));

const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDB_PORT}`], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

async function cdbGet() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDB_PORT}/json/list`); if (r.ok) { const j = await r.json(); if (j.length) return j; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('chrome devtools not up');
}
const targets = await cdbGet();
const page = targets.find(t => t.type === 'page') || targets[0];   // 必须连 page target
const WS = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  WS.send(JSON.stringify({ id, method, params }));
});
WS.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
await new Promise(r => WS.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });

const waitSrc = `(()=>{ return new Promise((resolve)=>{
  const d=()=>{ try{
    const b=window.__dbg && window.__dbg.bed;
    if (b && b.userData && b.userData.bedModel && window.__dbg.renderer) resolve({ok:true});
    else setTimeout(d,300);
  }catch(e){ setTimeout(d,300); } };
  d(); setTimeout(()=>resolve({ok:false}),60000);
})})`;
let ok = false;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const r = await send('Runtime.evaluate', { expression: `(${waitSrc})()`, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.value && r.result.value.ok) { ok = true; break; }
}
if (!ok) { console.log('bed not ready'); WS.close(); chrome.kill(); server.close(); process.exit(1); }

const setup = `(()=>{
  const d=window.__dbg, T=d.THREE;
  const vis=[]; d.bed.traverse(o=>{ if(o.isMesh && o.visible) vis.push(o); });
  const box=new T.Box3(); vis.forEach(o=>box.expandByObject(o));
  const c=box.getCenter(new T.Vector3()), s=box.getSize(new T.Vector3());
  const vFov=d.camera.fov*Math.PI/180;
  const aspect=d.camera.aspect || 1.777;
  const hFov=2*Math.atan(Math.tan(vFov/2)*aspect);
  const fill=1.12*Math.max((s.y/2)/Math.tan(vFov/2), (s.x/2)/Math.tan(hFov/2));
  const dist=fill*1.55;                       // 退一点，让草地/天空入画
  const c2=c.clone(); c2.y += s.y*0.12;
  const dir=new T.Vector3(0.72,0.34,1.0).normalize();
  d.camera.position.copy(c2).addScaledVector(dir,dist); d.camera.lookAt(c2);
  if(d.controls && d.controls.target){ d.controls.target.copy(c2); d.controls.update(); }
  return { size:[+s.x.toFixed(2),+s.y.toFixed(2),+s.z.toFixed(2)], dist:+dist.toFixed(2) };
})`;
const sr = await send('Runtime.evaluate', { expression: `(${setup})()`, returnByValue: true });
console.log('cam:', JSON.stringify(sr.result.value));
await new Promise(r => setTimeout(r, 1200));

const shot = await send('Page.captureScreenshot', { format: 'png' });
const p = `E:/workbuddy/cloud-ladder/shots/bed-ao-hero-${TAG}.png`;
fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
console.log('->', p);
WS.close(); chrome.kill(); server.close();
process.exit(0);
