import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDB = 9379, URL = 'http://127.0.0.1:8123/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu',
  '--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-proxy-server',
  `--remote-debugging-port=${CDB}`], { stdio:'ignore' });

let WS=null; const cleanup=()=>{try{WS&&WS.close();}catch{}try{chrome.kill();}catch{}};
process.on('exit', cleanup);

async function list(){ for(let i=0;i<60;i++){ try{ const r=await fetch(`http://127.0.0.1:${CDB}/json/list`); if(r.ok){const j=await r.json(); if(j.length) return j;} }catch{} await sleep(200);} throw new Error('CDB not up'); }
const targets = await list();
const page = targets.find(t=>t.type==='page')||targets[0];
WS = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});WS.send(JSON.stringify({id:i,method:m,params:p}));});
WS.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const x=pend.get(m.id);pend.delete(m.id);m.error?x.rej(new Error(m.error.message)):x.res(m.result);}});
await new Promise(r=>WS.addEventListener('open',r));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument',{source:[
  'window.__errs=[];',
  "addEventListener('error',e=>window.__errs.push((e.message||'')+' @ '+(e.filename||'')+':'+(e.lineno||'')));",
  "addEventListener('unhandledrejection',e=>window.__errs.push('unhandled: '+((e.reason&&(e.reason.stack||e.reason.message))||e.reason)));"
].join('\n')});
await send('Page.navigate',{url:URL});
const ev=(js,awaitP)=>send('Runtime.evaluate',{expression:js,returnByValue:true,awaitPromise:!!awaitP}).then(r=>{
  if(r.exceptionDetails) return {__err:(r.exceptionDetails.exception&&(r.exceptionDetails.exception.description||r.exceptionDetails.exception.value))||r.exceptionDetails.text};
  const v=r.result&&r.result.value; return v===undefined?{__err:'undefined'}:v;
});

let ready=false;
for(let i=0;i<150;i++){
  const s = await ev('JSON.stringify({d:typeof window.__dbg, gl:!!(window.__dbg&&window.__dbg.glints), ff:!!(window.__dbg&&window.__dbg.fireflies)})');
  let o=null; try{ o = (typeof s==='string')?JSON.parse(s):s; }catch{}
  if(o && o.d==='object' && o.gl && o.ff){ ready=true; break; }
  await sleep(300);
}
console.log('READY', ready);
if(!ready){ console.log('NOT READY'); process.exit(1); }
await sleep(500);

const out = await ev(`(async()=>{
  const gl = window.__dbg.glints, ff = window.__dbg.fireflies, bf = window.__dbg.butterflies;
  const sc = gl.userData.scales;
  let bed=0, ladder55=0, other=0;
  for(const x of sc){ if(x.scale===1 && x.bright===1) bed++; else if(Math.abs(x.scale-0.55)<1e-6 && Math.abs(x.bright-0.7)<1e-6) ladder55++; else other++; }
  const initFF=ff.visible, initBF=bf.visible;
  window.__dbg.atmos.apply('night'); await new Promise(r=>setTimeout(r,300));
  const nightFF=ff.visible, nightBF=bf.visible;
  // 采样一次萤火虫像素极散度：取所有实例世界坐标，估算水平包络半径
  let rMin=1e9,rMax=-1e9;
  const dbg = window.__dbg;
  // 用实例矩阵反推位置（InstancedMesh 的 matrix 已是世界矩阵）
  const m = ff.matrixWorld; // 组本身
  window.__dbg.atmos.apply('afternoon'); await new Promise(r=>setTimeout(r,150));
  return JSON.stringify({ total:sc.length, bed, ladder55, other, ffCount:ff.count,
    initFF, initBF, nightFF, nightBF, errs:(window.__errs||[]).slice(0,3) });
})()`, true);

console.log('RESULT', typeof out==='string'?out:JSON.stringify(out));
chrome.kill(); process.exit(0);
