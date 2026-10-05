/* 萤火虫冒烟：连上已在 8123 跑的 serve.py，用 CDP 断言：
   · 无异常
   · 萤火虫 InstancedMesh 已构建（count ≈ 14）
   · 默认（下午）：蝴蝶可见、萤火虫隐藏
   · 切夜间：蝴蝶隐藏、萤火虫可见
   · 萤火虫 update 跑通、实例色有「亮着」的点（闪烁生效）
   · 切回下午：蝴蝶恢复可见、萤火虫隐藏
*/
import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDB = 9374, URL = 'http://127.0.0.1:8123/';
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

const ck=[], C=(n,p,d)=>ck.push({n,p,d:String(d)});
try{
  // 就绪门禁：严格等待 __dbg / atmos / fireflies 都就位
  let ready=false;
  for(let i=0;i<150;i++){
    const s = await ev('JSON.stringify({d:typeof window.__dbg, a:!!(window.__dbg&&window.__dbg.atmos), ff:!!(window.__dbg&&window.__dbg.fireflies), bf:!!(window.__dbg&&window.__dbg.butterflies)})');
    let o=null; try{ o = (typeof s==='string')?JSON.parse(s):s; }catch{}
    if(o && o.d==='object' && o.a && o.ff && o.bf){ ready=true; break; }
    await sleep(300);
  }
  console.log('READY', ready);
  if(!ready){ C('页面就绪(__dbg/atmos/fireflies)', false, 'timeout'); throw new Error('not ready'); }
  await sleep(500);

  const init = await ev(`JSON.stringify({
    ffCount: window.__dbg.fireflies.count,
    ffInstanced: window.__dbg.fireflies.isInstancedMesh === true,
    initButterflies: window.__dbg.butterflies.visible,
    initFireflies: window.__dbg.fireflies.visible,
    errs: (window.__errs||[]).slice(0,3)
  })`);
  const r = (()=>{ try { return JSON.parse(init); } catch(e){ return {threw:'parse:'+e.message}; } })();
  console.log('INIT', JSON.stringify(r));

  // 切夜间
  await ev('window.__dbg.atmos.apply("night")'); await sleep(300);
  const night = await ev(`JSON.stringify({
    nightButterflies: window.__dbg.butterflies.visible,
    nightFireflies: window.__dbg.fireflies.visible
  })`);
  const rn = (()=>{ try { return JSON.parse(night); } catch(e){ return {}; } })();
  console.log('NIGHT', JSON.stringify(rn));

  // 跑一帧 update，数亮点
  const lit = await ev(`(function(){
    window.__dbg.fireflies.userData.update(1.234);
    const c = window.__dbg.fireflies.instanceColor; if(!c) return JSON.stringify({hasColors:false});
    let n=0; for(let i=0;i<c.count;i++){ if(c.getX(i)+c.getY(i)+c.getZ(i) > 0.3) n++; }
    return JSON.stringify({hasColors:true, litCount:n, count:c.count});
  })()`);
  const rl = (()=>{ try { return JSON.parse(lit); } catch(e){ return {}; } })();
  console.log('LIT', JSON.stringify(rl));

  // 切回下午
  await ev('window.__dbg.atmos.apply("afternoon")'); await sleep(300);
  const back = await ev(`JSON.stringify({
    backButterflies: window.__dbg.butterflies.visible,
    backFireflies: window.__dbg.fireflies.visible,
    errsAfter: (window.__errs||[]).slice(0,3)
  })`);
  const rb = (()=>{ try { return JSON.parse(back); } catch(e){ return {}; } })();
  console.log('BACK', JSON.stringify(rb));

  C('无异常（加载+切时相）', (!r.errs || r.errs.length===0) && (!rb.errsAfter || rb.errsAfter.length===0), (r.errs||[]).concat(rb.errsAfter||[]).join(' | ')||'clean');
  C('萤火虫 InstancedMesh 已构建', r.ffInstanced===true, `count=${r.ffCount}`);
  C('萤火虫数量 = 14（十几个）', r.ffCount===14, `count=${r.ffCount}`);
  C('默认(下午)：蝴蝶可见', r.initButterflies===true, `bf=${r.initButterflies}`);
  C('默认(下午)：萤火虫隐藏', r.initFireflies===false, `ff=${r.initFireflies}`);
  C('切夜间：蝴蝶隐藏', rn.nightButterflies===false, `bf=${rn.nightButterflies}`);
  C('切夜间：萤火虫可见', rn.nightFireflies===true, `ff=${rn.nightFireflies}`);
  C('萤火虫 update 跑通 + 有亮点在闪', rl.hasColors===true && rl.litCount>0, `lit=${rl.litCount}`);
  C('切回下午：蝴蝶恢复', rb.backButterflies===true, `bf=${rb.backButterflies}`);
  C('切回下午：萤火虫隐藏', rb.backFireflies===false, `ff=${rb.backFireflies}`);
}catch(e){ console.log('SCRIPT ERROR:', e.stack); C('脚本异常',false,e.message); }
finally{ console.log('\n=== 萤火虫冒烟 ==='); for(const c of ck) console.log((c.p?'✓ ':'✗ ')+c.n+(c.p?'':'   → '+c.d)); const bad=ck.filter(c=>!c.p).length; console.log(bad?('\nFAILED: '+bad+' 项'):'\nALL PASS'); cleanup(); process.exit(bad?1:0); }
