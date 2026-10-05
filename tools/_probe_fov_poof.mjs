/* 无头验证两件事（服务 ROOT 源码，不是 dist）：
     A. 视场角：漫游的「爬梯」那一步 fov 拉到 56+8=64；其余步骤 / 步行 / 自由 一律 56。
     B. 落地「噗」：leap（梯顶翻下床）**落地那一帧**调用一次 AUD.poof；
        爬梯途中、飞行途中、别的模式都不该调。
   还跑一遍**完整演出**（从飞向梯子一路到自动切步行）当端到端证据。
   产出：tools/fov-poof-verify.json + shots/fov-climb.png / fov-normal.png / fov-poof-landing.png
   运行：node tools/_probe_fov_poof.mjs

   两个无头环境的坑（这次都踩了）：
     · `setMode('roam')` 在已经是 roam 时是**切换**（切回 free），不是幂等设置 ——
       探针里必须判 mode 再设，否则整段测试其实跑在自由模式下（fov 永远是 56）。
     · 无头 + swiftshader 只有个位数 fps，而 animate 里 `dt = min(getDelta(), 0.1)` ——
       仿真时间推进 ≈ 0.1 × fps 秒/秒，比真实时间慢一个数量级。所以窗口要开小
       （--window-size）拉高 fps，并且所有等待都要按**谓词**等，不能按固定 sleep。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8241, CDB_PORT = 9351;
const URL = `http://127.0.0.1:${PORT}/?mode=roam&v=74`;

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp3':'audio/mpeg','.ico':'image/x-icon',
  '.glb':'model/gltf-binary','.gltf':'model/gltf+json','.woff2':'font/woff2',
};

const server = http.createServer((req,res)=>{
  let u = decodeURIComponent(req.url.split('?')[0]);
  if(u === '/') u = '/index.html';
  const fp = path.join(ROOT, u);
  fs.readFile(fp, (err, data)=>{
    if(err){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control':'no-store'});
    res.end(data);
  });
});
await new Promise(r=>server.listen(PORT, r));

const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required',   // 让 AudioContext 直接可用（否则永远 suspended）
  '--window-size=420,300',                        // 小窗口 = 高 fps = 仿真时间跑得动（见文件头注释）
  `--remote-debugging-port=${CDB_PORT}`,
], { stdio:'ignore' });
process.on('exit', ()=>{ try{ chrome.kill(); }catch{} });

async function cdbGet(){
  for(let i=0;i<60;i++){
    try{ const r = await fetch(`http://127.0.0.1:${CDB_PORT}/json/list`); if(r.ok){ const j = await r.json(); if(j.length) return j; } }catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('chrome devtools not up');
}
const targets = await cdbGet();
const page = targets.find(t=>t.type==='page') || targets[0];
const WS = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
function send(method, params={}){
  return new Promise((resolve,reject)=>{
    const id = ++msgId; pending.set(id,{resolve,reject});
    WS.send(JSON.stringify({id, method, params}));
  });
}
WS.addEventListener('message', (e)=>{
  const msg = JSON.parse(e.data);
  if(msg.id && pending.has(msg.id)){ const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
});
await new Promise(r=>WS.addEventListener('open', r));
await send('Page.enable');
await send('Runtime.enable');

async function ev(expr, awaitPromise=false){
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue:true, awaitPromise });
  if(r.exceptionDetails) throw new Error('page threw: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result && r.result.value;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
/* 按**谓词**等（无头里仿真时间不可预测，固定 sleep 一定误判） */
async function waitUntil(pred, ms, poll=100){
  const t0 = Date.now(); let last = null, n = 0;
  while(Date.now() - t0 < ms){ last = await ev(pred); n++; if(last) return { ok:true, tookMs:Date.now()-t0, polls:n }; await sleep(poll); }
  return { ok:false, tookMs:Date.now()-t0, polls:n, last };
}
const shot = async (name)=>{
  const s = await send('Page.captureScreenshot', { format:'png' });
  fs.writeFileSync(`${ROOT}/shots/${name}.png`, Buffer.from(s.data,'base64'));
  return `shots/${name}.png`;
};
const camState = ()=> ev(`(()=>{ const c=window.__dbg.camera;
  return { fov:+c.fov.toFixed(3), pos:[+c.position.x.toFixed(3),+c.position.y.toFixed(3),+c.position.z.toFixed(3)],
           rot:[+c.rotation.x.toFixed(4),+c.rotation.y.toFixed(4),+c.rotation.z.toFixed(4)],
           step:window.__rig.step, mode:window.__rig.mode }; })()`);
const ensureRoam = ()=> ev(`(()=>{ if(window.__rig.mode !== 'roam') window.__rig.setMode('roam'); return window.__rig.mode; })()`);

await send('Page.navigate', { url: URL });
if(!(await waitUntil('!!(window.__rig && window.__dbg && window.__dbg.audio && window.__rig.leap)', 20000)).ok)
  throw new Error('页面没起来（__rig / __dbg 缺失）');

/* 埋点：把 poof 换成记录器。main.js 里 SFX === AUD（同一对象、每次调用现取属性），
   所以替换这个属性就能抓到全部调用 —— 一行产品代码都不用改。 */
await ev(`
  window.__poofCalls = [];
  window.__poofOrig = window.__dbg.audio.poof;
  window.__dbg.audio.poof = function(o){
    window.__poofCalls.push({ t:+performance.now().toFixed(1), o:o||null,
      step:window.__rig.step, mode:window.__rig.mode,
      leapOn:!!window.__rig.leap.on, landed:!!window.__rig.leap.landed,
      fov:+window.__dbg.camera.fov.toFixed(3) });
  };
  'patched'
`);

/* fps + 环境读数 */
const fps = await ev(`new Promise(res=>{ let n=0; const t0=performance.now(); const f=()=>{ n++;
  if(performance.now()-t0 > 2000) res(+(n/((performance.now()-t0)/1000)).toFixed(2)); else requestAnimationFrame(f); };
  requestAnimationFrame(f); })`, true);
const routeBoost = await ev(`(async ()=>{ const j = await (await fetch('./scene.json')).json();
  return { climbStepFovBoost:j.roam.route[1].fovBoost, baseFov:j.camera.fov,
           stepsWithBoost:j.roam.route.map((s,i)=>s.fovBoost?s.fovBoost:null).filter(v=>v!=null).length,
           climbStepIndex:j.roam.route.findIndex(s=>s.climbLadder!==undefined) }; })()`, true);
const env = await ev(`(()=>({
  webAudio: !!(window.AudioContext||window.webkitAudioContext),
  audioOk: window.__dbg.audio.ok, audioState: window.__dbg.audio.state,
  ladderLen: +window.__rig.rig.ladder.length.toFixed(2),
  bedTop: +window.__rig.rig.bed.top.toFixed(3),
  steps: window.__rig.steps, fps: ${fps}
}))()`);
env.routeBoost = routeBoost;

const R = { url: URL, env, cases: {}, poofCalls: null };

/* ============ A1：爬梯那一步 ⇒ fov 应到 64 ============ */
await ensureRoam();
await ev(`window.__rig.goto(1)`);
const climbWait = await waitUntil(`Math.abs(window.__dbg.camera.fov - 64) < 0.05 && window.__rig.step === 1`, 60000);
const climbState = await camState();
R.cases.climb = { expect: 64, waitedMs: climbWait.tookMs, ok: climbWait.ok, state: climbState,
                  trace: await ev(`window.__fovTrace || null`) };
R.cases.climb.shotFov64 = await shot('fov-climb');

/* ============ A2：同一机位切自由模式 ⇒ fov 回 56（把位置/朝向写回去，保证两张图可比） ============ */
await ev(`(()=>{ const c=window.__dbg.camera, p=window.__rig;
  p.setMode('free');
  c.position.set(${climbState.pos[0]}, ${climbState.pos[1]}, ${climbState.pos[2]});
  c.rotation.set(${climbState.rot[0]}, ${climbState.rot[1]}, ${climbState.rot[2]});
  return 1; })()`);
const freeWait = await waitUntil(`Math.abs(window.__dbg.camera.fov - 56) < 0.05`, 30000);
const freeState = await camState();
R.cases.free = { expect: 56, waitedMs: freeWait.tookMs, ok: freeWait.ok, state: freeState,
                 shotFov56: await shot('fov-normal') };

/* ============ A3：飞行那一步（无 fovBoost）⇒ 保持 56 ============ */
await ensureRoam();
await ev(`window.__rig.goto(0)`);
await sleep(2500);
R.cases.fly = { expect: 56, state: await camState() };

/* ============ A4：爬梯中途「复位」⇒ 瞬时回 56 ============ */
await ev(`window.__rig.goto(1)`);
await waitUntil(`Math.abs(window.__dbg.camera.fov - 64) < 0.05`, 60000);
const beforeReset = await camState();
await ev(`window.__rig.reset()`);
const afterReset = await camState();                 // 同一 tick 读 ⇒ 考的是「瞬时」
R.cases.reset = { expect: 56, before: beforeReset, after: afterReset };

/* ============ A5：爬梯 → 下一站（hold，无 boost）⇒ 自己收回来 ============ */
await ensureRoam();
await ev(`window.__rig.goto(1)`);
await waitUntil(`Math.abs(window.__dbg.camera.fov - 64) < 0.05`, 60000);
await ev(`window.__rig.goto(2)`);                    // hold：原地不动，只考 fov 回落
const backWait = await waitUntil(`Math.abs(window.__dbg.camera.fov - 56) < 0.05`, 30000);
R.cases.stepExit = { expect: 56, waitedMs: backWait.tookMs, ok: backWait.ok, state: await camState(),
                     boostOfStep2: await ev(`(async ()=>(await (await fetch('./scene.json')).json()).roam.route[2].fovBoost)()`, true) };

/* ============ B1：爬梯 / 飞行途中不该有「噗」 ============ */
R.cases.noSpurious = { poofsBeforeE2E: await ev('window.__poofCalls.length') };

/* ============ E2E：完整演出一遍（含真爬梯 + 到顶按跳 + 翻下身 + 自动切步行） ============ */
await ev(`(()=>{ window.__rig.reset(); if(window.__rig.mode!=='roam') window.__rig.setMode('roam');
  window.__rig.goto(0);
  window.__e2e = []; window.__e2eStop = false;
  const tick = ()=>{ if(window.__e2eStop) return;
    const g = window.__rig, c = window.__dbg.camera;
    window.__e2e.push({ t:+performance.now().toFixed(0), step:g.step, mode:g.mode,
      fov:+c.fov.toFixed(3), foot:+g.P.foot.toFixed(2), state:g.P.state,
      leapOn:!!g.leap.on, landed:!!g.leap.landed, poofs:window.__poofCalls.length,
      hint:(document.getElementById('mode-hint')||{}).textContent||'' });
    setTimeout(tick, 120); };
  tick(); return 1; })()`);

let jumped = false, landingShot = null, sawClimbHigh = false;
const t0 = Date.now();
while(Date.now() - t0 < 180000){
  await sleep(300);
  const s = await ev(`(()=>{ const g=window.__rig,c=window.__dbg.camera;
    return { step:g.step, mode:g.mode, fov:+c.fov.toFixed(2), poofs:window.__poofCalls.length,
             state:g.P.state, foot:+g.P.foot.toFixed(2) }; })()`);
  if(s.fov > 63.5) sawClimbHigh = true;
  if(s.poofs > 0 && !landingShot) landingShot = await shot('fov-poof-landing');
  if(s.step === 2 && s.state === 'ladder' && !jumped){      // 停在梯顶等人按跳
    jumped = true;
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code:'Space', bubbles:true })); 1`);
  }
  if(s.mode === 'walk') break;                              // 演完自动交还步行
}
await ev(`window.__e2eStop = true`);
const e2e = await ev('window.__e2e');
const poofCalls = await ev('window.__poofCalls');
R.cases.e2e = {
  frames: e2e ? e2e.length : 0, jumped, sawFov64DuringClimb: sawClimbHigh,
  maxFov: e2e ? Math.max(...e2e.map(s=>s.fov)) : null,
  minFov: e2e ? Math.min(...e2e.map(s=>s.fov)) : null,
  stepsSeen: e2e ? [...new Set(e2e.map(s=>s.step))] : [],
  fovByStep: e2e ? e2e.reduce((m,s)=>{ m[s.step] = Math.max(m[s.step]||0, s.fov); return m; }, {}) : null,
  finalState: e2e ? e2e[e2e.length-1] : null,
  poofs: poofCalls.length, landingShot,
};
R.poofCalls = poofCalls;

/* ============ B3：合成器本身在无头里也不该抛错 ============ */
R.cases.synth = await ev(`(()=>{
  const before = window.__audio.poofs; let err = null;
  try{ window.__poofOrig({ strength: 0.85, pan: 0.25 }); }catch(e){ err = String((e&&e.message)||e); }
  return { err, before, after: window.__audio.poofs };
})()`);

fs.writeFileSync(`${ROOT}/tools/fov-poof-verify.json`, JSON.stringify(R, null, 1));

/* ============ 结论 ============ */
const near = (a,b,tol=0.06)=> a != null && b != null && Math.abs(a-b) <= tol;
const c = R.cases;
const poofAtLanding = poofCalls.length ? poofCalls[0] : null;
const checks = [
  ['A1 爬梯步骤 fov→64',              c.climb.ok && near(c.climb.state.fov, 64)],
  ['A2 自由模式 fov→56',              c.free.ok && near(c.free.state.fov, 56)],
  ['A2 两张截图同一机位',              JSON.stringify(c.climb.state.pos) === JSON.stringify(c.free.state.pos) &&
                                       JSON.stringify(c.climb.state.rot) === JSON.stringify(c.free.state.rot)],
  ['A3 飞行步骤 fov=56',              near(c.fly.state.fov, 56)],
  ['A4 复位瞬时回 56',                near(c.reset.after.fov, 56)],
  ['A4 复位前确实在 64',              near(c.reset.before.fov, 64)],
  ['A5 离开爬梯站后自己收回 56',       c.stepExit.ok && near(c.stepExit.state.fov, 56)],
  ['B1 爬梯/飞行途中无「噗」',         c.noSpurious.poofsBeforeE2E === 0],
  ['E2E 全片跑通（自动切步行）',        c.e2e.finalState && c.e2e.finalState.mode === 'walk'],
  ['E2E 爬梯段确实到过 64',            c.e2e.sawFov64DuringClimb],
  ['E2E 只有爬梯站被拉宽',             c.e2e.fovByStep && Object.entries(c.e2e.fovByStep)
                                        .filter(([s,v])=>v>56.2).map(([s])=>+s).join(',') === '1'],
  ['E2E 结尾 fov 回 56',              near(c.e2e.finalState && c.e2e.finalState.fov, 56, 0.2)],
  ['B2 落地恰好一声「噗」',            poofCalls.length === 1],
  ['B2 「噗」发生在落地帧',            !!(poofAtLanding && poofAtLanding.landed && !poofAtLanding.leapOn)],
  ['B2 「噗」在 roam/leap 站且 fov=56', !!(poofAtLanding && poofAtLanding.step === 3 && near(poofAtLanding.fov, 56, 0.2))],
  ['B3 合成器无异常',                 c.synth.err === null],
];
console.log('\n=== 结论 ===');
for(const [k,ok] of checks) console.log((ok ? 'PASS  ' : 'FAIL  ') + k);
console.log('\n--- 关键读数 ---');
console.log('fps(无头)      :', fps, ' routeBoost:', JSON.stringify(routeBoost));
console.log('A1 爬梯 fov    :', c.climb.state.fov, '(等', c.climb.waitedMs + 'ms)  step', c.climb.state.step);
console.log('A2 自由 fov    :', c.free.state.fov, ' 机位相同?',
  JSON.stringify(c.climb.state.pos) === JSON.stringify(c.free.state.pos),
  JSON.stringify(c.free.state.pos));
console.log('A3 飞行 fov    :', c.fly.state.fov, ' step', c.fly.state.step);
console.log('A4 复位 前/后  :', c.reset.before.fov, '->', c.reset.after.fov, ' mode', c.reset.after.mode);
console.log('A5 离开爬梯站   :', c.stepExit.state.fov, '(等', c.stepExit.waitedMs + 'ms)');
console.log('B1 演出前 poof :', c.noSpurious.poofsBeforeE2E);
console.log('E2E            :', '帧数', c.e2e.frames, '| 见到步骤', JSON.stringify(c.e2e.stepsSeen),
  '| 各站最高 fov', JSON.stringify(c.e2e.fovByStep), '| 收尾', JSON.stringify(c.e2e.finalState));
console.log('poof 调用      :', JSON.stringify(poofCalls));
console.log('合成器         :', JSON.stringify(c.synth));
console.log('截图           :', c.climb.shotFov64, '|', c.free.shotFov56, '|', c.e2e.landingShot);
console.log('报告           : tools/fov-poof-verify.json');

WS.close(); chrome.kill(); server.close();
process.exit(checks.every(([,ok])=>ok) ? 0 : 1);
