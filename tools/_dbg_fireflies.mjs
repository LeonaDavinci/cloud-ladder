import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDB = 9375, URL = 'http://127.0.0.1:8123/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu',
  '--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-proxy-server',
  `--remote-debugging-port=${CDB}`], { stdio:'ignore' });
let WS=null; const cleanup=()=>{try{WS&&WS.close();}catch{}try{chrome.kill();}catch{}};
process.on('exit', cleanup);
async function list(){ for(let i=0;i<60;i++){ try{ const r=await fetch(`http://127.0.0.1:${CDB}/json/list`); if(r.ok){const j=await r.json(); if(j.length) return j;} }catch{} await sleep(200);} throw new Error('CDB not up'); }
const targets = await list(); const page = targets.find(t=>t.type==='page')||targets[0];
WS = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});WS.send(JSON.stringify({id:i,method:m,params:p}));});
WS.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const x=pend.get(m.id);pend.delete(m.id);m.error?x.rej(new Error(m.error.message)):x.res(m.result);}});
await new Promise(r=>WS.addEventListener('open',r));
await send('Runtime.enable'); await send('Page.enable');
WS.addEventListener('message',e=>{const m=JSON.parse(e.data);
  if(m.method==='Runtime.exceptionThrown'){ const d=m.params.exceptionDetails; console.log('EXC:', (d.exception&&(d.exception.description||d.exception.value))||d.text, '@', d.url||'', d.lineNumber); }
  if(m.method==='Runtime.consoleAPICalled'){ const a=(m.params.args||[]).map(x=>x.value!==undefined?x.value:(x.description||'')).join(' '); console.log('LOG['+m.params.type+']:', a); }
});
await send('Page.navigate',{url:URL});
await sleep(15000);
const ev=(js)=>send('Runtime.evaluate',{expression:js,returnByValue:true}).then(r=>r.result&&r.result.value);
const st = await ev('JSON.stringify({dbg:typeof window.__dbg, atmos:!!(window.__dbg&&window.__dbg.atmos), ff:!!(window.__dbg&&window.__dbg.fireflies), bf:!!(window.__dbg&&window.__dbg.butterflies), errs:(window.__errs||[]).slice(0,5)})');
console.log('STATE', st);
cleanup(); process.exit(0);
