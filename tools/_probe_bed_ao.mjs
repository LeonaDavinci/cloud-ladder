// 床顶点 AO 多方案对比探针
//   node tools/_probe_bed_ao.mjs <variants.json> [tagPrefix]
//
// 目标：一次浏览器会话里把多组 AO 顶点色横向比完。
//   · 只服务 ROOT 源码，床走 models/ 文件
//   · 把场景里除「床那条顶层分支 + 灯光」以外的顶层子节点全藏掉，内部不属于 bed 的
//     网格也藏掉，清雾、scene.background=null、clearColor 纯黑 → 画面只剩床
//   · 按相机 FOV 反推距离把床框满
//   · 对每组变体：把 COLOR_0 换成该组的 u16 值，分别渲「原材质」与「顶点色无光照」
//     两张，readPixels（绕过后处理 composer，组间内部一致）→ 2D canvas 编 PNG
//   · 背景纯黑 ⇒ 亮度统计里的 litPixels 就是床本身，数字可直接横向比
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VAR_FILE = process.argv[2] || 'E:/workbuddy/cloud-ladder/tools/_ao-variants.json';
const PREFIX = process.argv[3] || 'ao';
const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8247, CDB_PORT = 9357;

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
let ready = null;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const r = await send('Runtime.evaluate', { expression: `(${waitSrc})()`, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.value && r.result.value.ok) { ready = r.result.value; break; }
}
console.log('ready  :', JSON.stringify(ready));
if (!ready) { WS.close(); chrome.kill(); server.close(); process.exit(1); }

/* 隔离 + 取景 + 装好抓帧/换色的辅助函数 */
const setup = `(()=>{
  const d=window.__dbg, T=d.THREE;
  const under=(o,root)=>{ let p=o; while(p){ if(p===root) return true; p=p.parent; } return false; };
  let top=d.bed; while(top.parent && top.parent!==d.scene) top=top.parent;
  window.__others=[];
  d.scene.children.forEach(c=>{ if(c===top) return; if(c.isLight) return;
    window.__others.push([c,c.visible]); c.visible=false; });
  let inner=0;
  top.traverse(o=>{ if(o.isMesh && !under(o,d.bed)){ window.__others.push([o,o.visible]); o.visible=false; inner++; } });
  d.scene.fog=null; d.scene.background=null;
  if(d.sky) d.sky.visible=false;
  d.renderer.setClearColor(0x000000,1);
  const vis=[]; d.bed.traverse(o=>{ if(o.isMesh && o.visible) vis.push(o); });
  const box=new T.Box3(); vis.forEach(o=>box.expandByObject(o));
  const c=box.getCenter(new T.Vector3()), s=box.getSize(new T.Vector3());
  /* 取景要用「水平 + 垂直」两个 FOV 里需要退得更远的那个。
     只按垂直 FOV 算会让宽画幅下相机退远 ~aspect 倍（踩过：床只占画面 18%）。 */
  const vFov=d.camera.fov*Math.PI/180;
  const aspect=d.camera.aspect || (window.innerWidth/window.innerHeight) || 1.777;
  const hFov=2*Math.atan(Math.tan(vFov/2)*aspect);
  const dist=1.12*Math.max((s.y/2)/Math.tan(vFov/2), (s.x/2)/Math.tan(hFov/2));
  const dir=new T.Vector3(0.72,0.40,1.0).normalize();
  d.camera.position.copy(c).addScaledVector(dir,dist); d.camera.lookAt(c);
  if(d.controls && d.controls.target){ d.controls.target.copy(c); d.controls.update(); }
  window.__vis=vis; window.__savedMat=[];
  vis.forEach(o=>{ window.__savedMat.push([o,o.material]); });
  window.__basic=new T.MeshBasicMaterial({ vertexColors:true, color:0xffffff, toneMapped:false, side:T.DoubleSide });
  window.__setBasic=(on)=>{ vis.forEach((o,i)=>{ o.material = on ? window.__basic : window.__savedMat[i][1]; }); };
  // 换 COLOR_0：整份替换 attribute（u16 归一化，与 GLTFLoader 读出来的一致）
  window.__setAO=function(b64){
    const bin=atob(b64); const u8=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
    const u16=new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength/2);
    const attr=new T.BufferAttribute(u16,4,true);
    let n=0; vis.forEach(o=>{ o.geometry.setAttribute('color', attr); n++; });
    return { appliedTo:n, count:u16.length/4 };
  };
  // 合成条带：多组结果叠成一张图，便于横向判读
  window.__compInit=function(rows,W,H){
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H*rows;
    const ctx=cv.getContext('2d'); ctx.fillStyle='#101010'; ctx.fillRect(0,0,cv.width,cv.height);
    window.__compCv=cv; window.__compCtx=ctx; window.__compRow=0; window.__compRows=rows;
    window.__compW=W; window.__compH=H; window.__useComp=true;
  };
  window.__grab=function(label){
    const R=d.renderer, gl=R.getContext();
    R.render(d.scene, d.camera);
    const W=gl.drawingBufferWidth, H=gl.drawingBufferHeight;
    const px=new Uint8Array(W*H*4);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    const ctx=cv.getContext('2d'); const img=ctx.createImageData(W,H);
    for(let y=0;y<H;y++){ const s=(H-1-y)*W*4; img.data.set(px.subarray(s,s+W*4), y*W*4); }
    ctx.putImageData(img,0,0);
    const vals=[]; let rs=0,gs=0,bs=0;
    for(let i=0;i<W*H;i++){ const r=img.data[i*4],g=img.data[i*4+1],b=img.data[i*4+2];
      const v=0.2126*r+0.7152*g+0.0722*b; if(v>2){ vals.push(v); rs+=r; gs+=g; bs+=b; } }
    vals.sort((a,b)=>a-b);
    const q=p=>vals.length?+vals[Math.min(vals.length-1,Math.max(0,Math.round(p*(vals.length-1))))].toFixed(1):0;
    let sum=0; for(const v of vals) sum+=v; const mean=vals.length?sum/vals.length:0;
    let s2=0; for(const v of vals) s2+=(v-mean)*(v-mean);
    let url=cv.toDataURL('image/png');        // 单图始终返回（合成模式下也要落盘）
    if(window.__useComp){
      window.__compCtx.putImageData(img, 0, window.__compRow*window.__compH);
      window.__compCtx.fillStyle='#ffe600'; window.__compCtx.font='bold 15px Consolas, monospace';
      window.__compCtx.fillText(label||'', 8, window.__compRow*window.__compH+19);
      window.__compRow++;
    }
    return { W,H, lit:vals.length, mean:+mean.toFixed(2), sd:+((vals.length?Math.sqrt(s2/vals.length):0)).toFixed(2),
             p1:q(0.01),p5:q(0.05),p25:q(0.25),p50:q(0.5),p75:q(0.75),p95:q(0.95),
             meanRGB:[vals.length?((rs/vals.length)|0):0, vals.length?((gs/vals.length)|0):0, vals.length?((bs/vals.length)|0):0],
             url };
  };
  window.__compExport=function(){ return window.__compCv.toDataURL('image/png'); };
  return { visMeshes:vis.length, hidden:window.__others.length, inner, size:[+s.x.toFixed(2),+s.y.toFixed(2),+s.z.toFixed(2)], dist:+dist.toFixed(2) };
})`;
const sr = await send('Runtime.evaluate', { expression: `(${setup})()`, returnByValue: true });
console.log('isolate:', JSON.stringify(sr.result && sr.result.value));
await new Promise(r => setTimeout(r, 600));

const savePng = (name, url) => {
  if (!url) return null;                        // 合成模式下中途的帧没有 url，只进条带
  const p = `E:/workbuddy/cloud-ladder/shots/${name}.png`;
  fs.writeFileSync(p, Buffer.from(url.split(',')[1], 'base64'));
  return p;
};
const grab = async (label) => {
  const r = await send('Runtime.evaluate', { expression: `window.__grab()`, returnByValue: true, timeout: 120000 });
  const v = r.result.value;
  const { url, ...stats } = v;
  console.log('  ' + label.padEnd(8), JSON.stringify(stats));
  return { url, stats };
};

const doc = JSON.parse(fs.readFileSync(VAR_FILE, 'utf8'));
const nv = doc.nv;
const names = Object.keys(doc.variants);
console.log('variants:', names.join(', '), ' nv:', nv);

const NOAO = Buffer.from(new Uint16Array(nv * 4).fill(65535).buffer).toString('base64');
const rows = [];
const list = [['noao', null], ...names.map(k => [k, doc.variants[k]])];

// 先跑一遍拿到画面尺寸，再开合成条带
const probe0 = await send('Runtime.evaluate', { expression: `window.__grab('probe')`, returnByValue: true });
const W = probe0.result.value.W, H = probe0.result.value.H;
await send('Runtime.evaluate', { expression: `window.__compInit(${list.length * 2},${W},${H})`, returnByValue: true });
console.log(`合成条带 ${W}x${H} x ${list.length * 2} 行（每组两行：AO 图 / 原材质）`);

for (const [name, meta] of list) {
  const b64 = name === 'noao' ? NOAO : meta.values[0].values;
  await send('Runtime.evaluate', { expression: `window.__setAO(${JSON.stringify(b64)})`, returnByValue: true });
  const desc = meta ? `dist=${meta.dist} g=${meta.rawGamma} floor=${meta.floor} str=${meta.strength}` : '全白(无AO)';
  console.log(`\n[${name}] ${desc}`);

  await send('Runtime.evaluate', { expression: `window.__setBasic(true)`, returnByValue: true });
  const m = await send('Runtime.evaluate', { expression: `window.__grab(${JSON.stringify(name + '  AO-map   ' + desc)})`, returnByValue: true });
  const mv = m.result.value;
  console.log('  aomap   ' + JSON.stringify({ mean: mv.mean, sd: mv.sd, p5: mv.p5, p50: mv.p50 }));
  savePng(`${PREFIX}-${name}-aomap`, mv.url);

  await send('Runtime.evaluate', { expression: `window.__setBasic(false)`, returnByValue: true });
  const b = await send('Runtime.evaluate', { expression: `window.__grab(${JSON.stringify(name + '  beauty   ' + desc)})`, returnByValue: true });
  const bv = b.result.value;
  console.log('  beauty  ' + JSON.stringify({ mean: bv.mean, sd: bv.sd, p5: bv.p5, p50: bv.p50 }));
  savePng(`${PREFIX}-${name}`, bv.url);

  rows.push({ name, desc, aomap: { mean: mv.mean, sd: mv.sd, p5: mv.p5, p50: mv.p50 },
              beauty: { mean: bv.mean, sd: bv.sd, p5: bv.p5, p50: bv.p50 } });
}

const comp = await send('Runtime.evaluate', { expression: `window.__compExport()`, returnByValue: true });
savePng(`${PREFIX}-strip`, comp.result.value);

fs.writeFileSync(`E:/workbuddy/cloud-ladder/shots/${PREFIX}-report.json`, JSON.stringify(rows, null, 1));
console.log(`\n报告 -> shots/${PREFIX}-report.json   对照条带 -> shots/${PREFIX}-strip.png`);
console.log('\n=== 横向对比 ===');
for (const r of rows) {
  console.log(`${r.name.padEnd(8)} aomap mean ${String(r.aomap.mean).padStart(6)} sd ${String(r.aomap.sd).padStart(5)} p5 ${String(r.aomap.p5).padStart(5)} | beauty mean ${String(r.beauty.mean).padStart(6)} sd ${String(r.beauty.sd).padStart(5)} p5 ${String(r.beauty.p5).padStart(5)}  ${r.desc}`);
}

WS.close(); chrome.kill(); server.close();
process.exit(0);
