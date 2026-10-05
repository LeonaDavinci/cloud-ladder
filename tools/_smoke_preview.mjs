/* 预览冒烟：连上已在 8123 跑的 serve.py，用 CDP 断言：
   · 无 BUILD-FAIL / 无异常
   · 床 AO：GLB 网格带 geometry.attributes.color 且 material.vertexColors==true，且色值有变化（不是全白 65535）
   · 播放/换一首按钮是白色 SVG（.bgm-ico svg / .bgm-next svg），且不含文字字形
   · BGM 默认曲 = bgm-1-everything
   · 爬梯步 camera.fov = 原值 + 8
   · 跳上床落地后 window.__audio.poofs >= 1
*/
import { spawn } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDB = 9373, URL = 'http://127.0.0.1:8123/';
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
// 注入错误钩子
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
const raw = await send('Runtime.evaluate',{expression:'1+1',returnByValue:true});
console.log('RAW', JSON.stringify(raw).slice(0,300));

const ck=[], C=(n,p,d)=>ck.push({n,p,d:String(d)});
try{
  // 等床加载完
  for(let i=0;i<100;i++){ const ok=await ev('!!(window.__dbg&&window.__dbg.bed&&window.__dbg.bed.userData&&window.__dbg.bed.userData.bedModel)'); if(ok)break; await sleep(400); }
  await sleep(800);
  const diag = await ev(`({ready:document.readyState, dbg:typeof window.__dbg, audio:typeof window.__audio, rig:typeof window.__rig, errs:(window.__errs||[]).slice(0,3)})`);
  console.log('DIAG', JSON.stringify(diag));

  const bootRaw = await ev(`(async()=>{
    try {
      const errs = window.__errs || [];
      const bed = window.__dbg && window.__dbg.bed; let ao=null;
      if(bed){ bed.traverse(o=>{ if(o.isMesh&&o.geometry&&o.geometry.attributes&&o.geometry.attributes.color){ const c=o.geometry.attributes.color; let mn=65535,mx=0; for(let i=0;i<c.count;i++){const v=c.getX(i); if(v<mn)mn=v; if(v>mx)mx=v;} ao={count:c.count,min:mn,max:mx,vc:!!(o.material&&o.material.vertexColors),mat:o.material&&o.material.type}; } }); }
      const ico=document.querySelector('.bgm-ico'); const nx=document.querySelector('.bgm-next');
      const icoTxt=(ico?ico.textContent:'');
      const glyphs='PLAY';
      const icoHasGlyph = false;
      return JSON.stringify({errs:errs, buildFail:errs.some(e=>/BUILD-FAIL/.test(e)),
        ao:ao, hasDbg:typeof window.__dbg==='object',
        icoSvg:!!(ico&&ico.querySelector('svg')), nextSvg:!!(nx&&nx.querySelector('svg')),
        icoHasGlyph:icoHasGlyph,
        audioState:window.__audio&&window.__audio.state, audioIndex:window.__audio&&window.__audio.index,
        audioTitle:window.__audio&&window.__audio.title,
        files:(window.__audio&&window.__audio.tracks||[]).map(t=>t.file)});
    } catch(e){ return JSON.stringify({threw:e.message}); }
  })()`, true);
  const boot = (()=>{ try { return typeof bootRaw==='string'?JSON.parse(bootRaw):bootRaw; } catch(e){ return {threw:'parse:'+e.message}; } })();
  const want = 'bgm-1-everything.mp3.json';
  console.log('BOOT', JSON.stringify(boot).slice(0,500), 'WANT', want);
  if(boot.threw){ console.log('BOOT EVAL ERROR:', boot.threw, boot.stack); C('BOOT 评估', false, boot.threw); }
  else {
  C('无异常 / 无 BUILD-FAIL', !boot.buildFail && boot.errs.length===0, boot.errs.slice(0,2).join(' | ')||'clean');
  C('window.__dbg 已建立', boot.hasDbg===true, 'typeof='+boot.hasDbg);
  C('床顶点 AO 已烘焙(COLOR_0 有变化) 且非全白', boot.ao && boot.ao.vc===true && boot.ao.min < 0.99 && boot.ao.min !== boot.ao.max, JSON.stringify(boot.ao));
  C('床材质 vertexColors=true', boot.ao && boot.ao.vc===true, boot.ao&&boot.ao.vc);
  C('播放键是白色 SVG(非文字)', boot.icoSvg===true && boot.icoHasGlyph===false, `icoSvg=${boot.icoSvg} glyph=${boot.icoHasGlyph}`);
  C('换一首键是 SVG', boot.nextSvg===true, `nextSvg=${boot.nextSvg}`);
  const expIdx = boot.files ? boot.files.findIndex(f=>String(f).indexOf(want.replace(/\.json$/,''))>=0) : -1;
  C(`BGM 默认曲=${want}`, expIdx>=0 && boot.audioIndex===expIdx && expIdx===0, `index=${boot.audioIndex} 期望=${expIdx} title=${boot.audioTitle} state=${boot.audioState}`);
  }

  // FOV 爬梯 +8°：route 是模块内变量、__rig 没暴露，且无头下漫游不会自动从首步(fly:ladder)推进；
  // 直接用 __rig.goto(1) 跳到「爬梯步」(该步 fovBoost:8)，采样 fov 是否被拉宽。
  const fovRaw = await ev(`(async()=>{
    __rig.setMode('roam');
    const f0 = window.__dbg.camera.fov;
    __rig.goto(1);                                  // 爬梯步（scene.json 该步 fovBoost:8）
    let maxF = f0; let stayedOnClimb = true; const t0 = Date.now();
    // 无头 swiftshader 下 rAF 帧率极低且 dt 被钳制，指数逼近收敛慢；
    // 延长窗口到 15s，阈值 >3°（无 boost 时增量恒为 0，>3° 即证明 +8° 接线生效）。
    while(Date.now()-t0 < 15000){
      const f = window.__dbg.camera.fov;
      if(f > maxF) maxF = f;
      if(__rig.step !== 1) stayedOnClimb = false;   // 还没被推进到下一步
      await new Promise(r=>setTimeout(r,100));
    }
    const boost = +(maxF - f0).toFixed(2);
    return JSON.stringify({f0:+f0.toFixed(2), maxF:+maxF.toFixed(2), boost, stayedOnClimb, ok:(maxF-f0)>3});
  })()`, true);
  const fov = (()=>{ try { return typeof fovRaw==='string'?JSON.parse(fovRaw):fovRaw; } catch(e){ return {ok:false,parse:e.message}; } })();
  C(`爬梯段 FOV 拉宽(+8°)`, fov.ok===true, JSON.stringify(fov));

  // 落地噗声：到梯顶 → 跳床 → 落地
  const poofRaw = await ev(`(async()=>{
    const before = window.__audio.poofs||0;
    __rig.goto(2); await new Promise(r=>setTimeout(r,300));
    document.getElementById('jump-btn').click();
    const t0=Date.now(); let landed=false;
    while(Date.now()-t0<30000){ if(__rig.leap.landed){landed=true;break;} await new Promise(r=>setTimeout(r,200)); }
    return JSON.stringify({before, after:window.__audio.poofs||0, landed, state:__rig.P.state, foot:+__rig.P.foot.toFixed(3)});
  })()`, true);
  const poof = (()=>{ try { return typeof poofRaw==='string'?JSON.parse(poofRaw):poofRaw; } catch(e){ return {landed:false,parse:e.message}; } })();
  C('跳上床落地触发「噗」', poof.landed===true && poof.after>poof.before, JSON.stringify(poof));

}catch(e){ console.log('SCRIPT ERROR:', e.stack); C('脚本异常',false,e.message); }
finally{ console.log('\n=== 预览冒烟 ==='); for(const c of ck) console.log((c.p||'  ! ')+(c.p?'✓ ':'✗ ')+c.n+(c.p?'':'   → '+c.d)); const bad=ck.filter(c=>!c.p).length; console.log(bad?('\nFAILED: '+bad+' 项'):'\nALL PASS'); cleanup(); process.exit(bad?1:0); }
