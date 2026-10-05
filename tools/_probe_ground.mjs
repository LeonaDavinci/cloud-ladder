/* 探针：连已在 8123 的 serve.py，确认下午档半球光 ground 颜色不再是绿。*/
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDB = 9375, URL = 'http://127.0.0.1:8123/?nocache=' + Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

import { spawn } from 'node:child_process';
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
await send('Page.navigate',{url:URL});
const ev=(js)=>send('Runtime.evaluate',{expression:js,returnByValue:true}).then(r=>{
  if(r.exceptionDetails) return {__err:(r.exceptionDetails.exception&&(r.exceptionDetails.exception.description||r.exceptionDetails.exception.value))||r.exceptionDetails.text};
  const v=r.result&&r.result.value; return v===undefined?{__err:'undefined'}:v;
});

// 就绪门禁
for(let i=0;i<150;i++){ const ok=await ev('!!(window.__dbg&&window.__dbg.hemi)'); if(ok===true) break; await sleep(400); }
const groundHex = await ev('window.__dbg.hemi.groundColor.getHexString()');
const cfgGround = await ev('(()=>{try{return window.__dbg.config.hemisphere.ground}catch(e){return null}})()');
const phase = await ev('(()=>{try{return (window.__dbg.atmos&&(window.__dbg.atmos.phase||window.__dbg.atmos.current))||"afternoon(default)"}catch(e){return "afternoon(default)"}})()');
const n = (groundHex||'000000').replace(/[^0-9a-f]/gi,'');
const R=parseInt(n.slice(0,2),16),G=parseInt(n.slice(2,4),16),B=parseInt(n.slice(4,6),16);
console.log('GROUND_HEX=' + groundHex + '  RGB=' + R+','+G+','+B + '  GREEN_DOMINANT=' + (G>R&&G>B) + '  CFG=' + cfgGround + '  PHASE=' + phase);
const ok = (G <= R+5) && (G <= B) && groundHex !== '44dd44';
console.log(ok ? 'PASS: 下午地面光不再偏绿' : 'CHECK: 仍偏绿或值异常');
process.exit(0);
