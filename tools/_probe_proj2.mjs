import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8241, CDB = 9425;
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
  '--enable-unsafe-swiftshader','--no-proxy-server','--mute-audio',
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

/* 探针主体写成一段普通字符串，避免模板字符串与转义打架 */
const PROBE = [
  "var e = document.getElementById('ui-projector');",
  "var out = [];",
  "if(!e){ out.push('NO ELEMENT'); } else {",
  "  var cs = getComputedStyle(e);",
  "  out.push('position = ' + cs.position);",
  "  out.push('left = ' + cs.left + '  bottom = ' + cs.bottom);",
  "  out.push('transform = ' + cs.transform);",
  "  out.push('zIndex = ' + cs.zIndex);",
  "  out.push('display = ' + cs.display);",
  "  out.push('inline = ' + (e.getAttribute('style')||'(none)'));",
  "  out.push('parent = ' + (e.parentElement ? (e.parentElement.tagName + '#' + e.parentElement.id) : '-'));",
  "  out.push('rect = ' + JSON.stringify(e.getBoundingClientRect()));",
  "}",
  "var hits = [];",
  "var sh = document.styleSheets[0];",
  "try { for (var i=0;i<sh.cssRules.length;i++){ var r=sh.cssRules[i];",
  "  if(r.selectorText && r.selectorText.indexOf('ui-projector')>=0){ hits.push(r.cssText.slice(0,120)); } } } catch(err){ hits.push('ERR '+err); }",
  "out.push('CSSOM rules for ui-projector:');",
  "out.push(hits.length ? '  ' + hits.join('\\n  ') : '  (none)');",
  "out.push('total rules in sheet = ' + sh.cssRules.length);",
  "out.join('\\n')"
].join('\n');

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width:1280, height:800, deviceScaleFactor:1, mobile:false });
await send('Page.navigate',{ url:`http://127.0.0.1:${PORT}/index.html` });
for(let i=0;i<100;i++){ if(await ev('!!document.getElementById("ui-projector")')) break; await sleep(500); }
await sleep(3000);
await ev(`window.__dbg.atmos.apply('night')`);
await sleep(3000);
console.log(await ev(PROBE));
process.exit(0);
