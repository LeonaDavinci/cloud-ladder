// 源码级 web 冒烟测试（服务项目根目录，走 ES module）
//   node tools/smoke-web.mjs
// 检查：
//   ① 页面无异常、无 BUILD-FAIL
//   ② window.__dbg 建立
//   ③ 切换夜间模式后投影按钮出现、点击可切换幕布 visible
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'E:/workbuddy/cloud-ladder';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8123, CDB_PORT = 9362;
const WAIT_MS = 25000;

const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.glb':'model/gltf-binary','.gltf':'model/gltf+json' };

const server = http.createServer((req,res)=>{
  let u = req.url.split('?')[0]; if (u === '/') u = '/index.html';
  const f = path.join(ROOT, u);
  fs.readFile(f, (err, data)=>{
    if (err){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(u)] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
});
await new Promise(r=>server.listen(PORT, r));

const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  `--remote-debugging-port=${CDB_PORT}`], { stdio:'ignore' });

const errors = [], consoles = [];
let WS = null;
const cleanup = () => { try{ if(WS) WS.close(); }catch{} try{ chrome.kill(); }catch{} try{ server.close(); }catch{} };
process.on('exit', cleanup);

async function cdbGet(){
  for (let i=0;i<60;i++){
    try{ const r = await fetch(`http://127.0.0.1:${CDB_PORT}/json/list`); if (r.ok){ const j = await r.json(); if (j.length) return j; } }catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('chrome devtools not up');
}
const targets = await cdbGet();
const page = targets.find(t=>t.type==='page') || targets[0];
WS = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
const send = (method, params={}) => new Promise((resolve,reject)=>{
  const id = ++msgId; pending.set(id,{resolve,reject});
  WS.send(JSON.stringify({id, method, params}));
});
WS.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)){ const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown'){
    const d = m.params.exceptionDetails || {};
    errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '?');
  } else if (m.method === 'Runtime.consoleAPICalled'){
    const txt = (m.params.args||[]).map(a => a.value !== undefined ? String(a.value) : (a.description||'')).join(' ');
    consoles.push(m.params.type + ': ' + txt.slice(0, 300));
    if (m.params.type === 'error') errors.push('[console.error] ' + txt.slice(0, 300));
  }
});
await new Promise(r=>WS.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Page.navigate', { url:`http://127.0.0.1:${PORT}/index.html` });
await new Promise(r=>setTimeout(r, WAIT_MS));

// 切夜间、检测按钮与 projector
const r = await send('Runtime.evaluate', { expression:`(()=>{
  const dbg = window.__dbg;
  if(!dbg) return {err:'no __dbg'};
  dbg.atmos.apply('night');
  // 等一帧让 onPhase 跑完
  return new Promise(res=>{
    requestAnimationFrame(()=>{
      const row = document.getElementById('ui-projector');
      const btn = row && row.querySelector('button');
      const proj = dbg.projector;
      res({
        hasProjector: !!proj,
        initiallyVisible: proj ? proj.visible : false,
        rowDisplay: row ? row.style.display : 'none',
        btnText: btn ? btn.textContent : '',
        hasSetOn: proj && typeof proj.userData.setOn === 'function',
        hasUpdate: proj && typeof proj.userData.update === 'function',
        sceneState: dbg.atmos.state,
        homePos: dbg.camera.position.clone(),
        /* 原视场角，用来核对看电视的 fov 增量（期望 = FOV0 + 22） */
        fov0: dbg.camera.fov
      });
    });
  });
})()`, returnByValue:true, awaitPromise:true });
const A = r.result.value;

// 点击「看电视」，轮询直到飞床动画完成（tvState 为 true）
const r2 = await send('Runtime.evaluate', { expression:`(()=>{
  const dbg = window.__dbg;
  const row = document.getElementById('ui-projector');
  const btn = row && row.querySelector('button');
  if(btn) btn.click();
  return new Promise(res=>{
    const start = performance.now();
    function poll(){
      if((window.__rig && window.__rig.tvState) || performance.now() - start > 100000){
        requestAnimationFrame(()=>{
          /* 落地后再等一小拍：飞行动画结束那一刻 controls 刚交还，
             OrbitControls 会把阻尼残余吐出来，立刻读位置会差个几十厘米。 */
          setTimeout(function(){
          requestAnimationFrame(function(){
          const proj = dbg.projector;
          const cam = dbg.camera;
          const ladder = dbg.ladder;
          res({
            afterClickVisible: proj ? proj.visible : false,
            btnTextAfter: btn ? btn.textContent : '',
            lightVisible: proj && proj.children.find ? !!proj.children.find(c=>c.isPointLight && c.visible) : 'n/a',
            hasVideoTexture: proj && proj.children[0] && proj.children[0].material && proj.children[0].material.map && proj.children[0].material.map.isVideoTexture,
            ladderVisible: ladder ? ladder.visible : 'n/a',
            tvState: !!(window.__rig && window.__rig.tvState),
            fpOn: !!(window.__rig && window.__rig.fpOn),
            controlsEnabled: dbg.controls ? !!dbg.controls.enabled : 'n/a',
            rigMode: window.__rig ? window.__rig.mode : 'n/a',
            fov: dbg.camera.fov,
            /* 幕布视频是否解除静音（用户要求看电视时直接放视频原声） */
            videoMuted: (function(){
              const m = proj && proj.children[0] && proj.children[0].material;
              const img = m && m.map && m.map.image;
              return (img && typeof img.muted === 'boolean') ? img.muted : null;
            })(),
            frameCount: proj && proj.children[0] && proj.children[0].children ? proj.children[0].children.length : -1,
            cloudPos: (function(){ const c = dbg.cloud; return c ? { x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2) } : null; })(),
            watchPos: { x: +cam.position.x.toFixed(3), y: +cam.position.y.toFixed(3), z: +cam.position.z.toFixed(3) }
          });
          });
          },400);
        });
      } else { setTimeout(poll, 200); }
    }
    poll();
  });
})()`, returnByValue:true, awaitPromise:true });
const B = r2.result.value;

/* ⚠ 「点击复位」必须排在下面这两个探针**之后**：
   一旦按下复位，tvState 立刻翻假、返程 fly 生效，而 step() 在 fly 期间是直接
   return 的 —— 第一人称根本没机会跑，探针只会量到「什么都没动」的假失败。 */
const RESET_EXPR = `(()=>{
  const dbg = window.__dbg;
  const row = document.getElementById('ui-projector');
  const btn = row && row.querySelector('button');
  if(btn) btn.click();
  return new Promise(res=>{
    const start = performance.now();
    const cl = ()=>{ const c = dbg.cloud; return c ? +c.position.x.toFixed(2) : null; };
    const cloudLog = [];
    function poll(){
      const t = Math.round(performance.now() - start);
      const cx = cl();
      const p = cloudLog[cloudLog.length - 1];
      if(!p || p.cx !== cx) cloudLog.push({ t, cx });
      /* 要求 !tvActive **并且** 云再自己缓动几秒：云的时间常数是 1/0.22 ≈ 4.5 秒，
         无头里每帧只推 2.2%，落地就量会量到「还没开始往回走」的位置。 */
      /* 9000ms：无头里帧率不足 1fps，太早量会一帧都没推出来（云的时间常数
         是 1/0.22 ≈ 4.5 秒，而每帧只推 2.2%，得给它几帧才量得出回程方向）。 */
      if(((!(window.__rig && window.__rig.tvActive)) && performance.now() - start > 9000)
         || performance.now() - start > 100000){
        requestAnimationFrame(()=>{
          const ladder = dbg.ladder;
          const cam = dbg.camera;
        res({
          btnTextFinal: btn ? btn.textContent : '',
          ladderVisible: ladder ? ladder.visible : 'n/a',
          finalPos: { x: +cam.position.x.toFixed(3), y: +cam.position.y.toFixed(3), z: +cam.position.z.toFixed(3) },
          cloudPos: (function(){ const c = dbg.cloud; return c ? { x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2) } : null; })(),
          cloudLog
        });
        });
      } else { setTimeout(poll, 200); }
    }
    poll();
  });
})()`;

/* fov 是指数缓动的（FOV_RATE 2.6），无头里 rAF 极慢、400ms 只走了两三帧，
   落地立刻读只能读到 halfway。单独等它收敛再断言「增量=+22」。 */
const r2b = await send('Runtime.evaluate', { expression:`(()=>{
  const dbg = window.__dbg;
  return new Promise(res=>{
    const t0 = performance.now();
    const log = [];
    (function w(){
      const s = {
        t: Math.round(performance.now() - t0),
        fov: +dbg.camera.fov.toFixed(2),
        fpOn: !!(window.__rig && window.__rig.fpOn),
        controls: dbg.controls ? !!dbg.controls.enabled : null,
        tv: !!(window.__rig && window.__rig.tvState),
        phase: dbg.atmos ? dbg.atmos.state : null
      };
      const prev = log[log.length - 1];
      /* 只记「变了」的采样点，省得 9 秒内几十条同一值 */
      if(!prev || prev.fpOn !== s.fpOn || prev.controls !== s.controls || prev.tv !== s.tv ||
         prev.phase !== s.phase || Math.abs(prev.fov - s.fov) > 1) log.push(s);
      if(performance.now() - t0 > 22000) return res({ fov: dbg.camera.fov, log });
      setTimeout(w, 200);
    })();
  });
})()`, returnByValue:true, awaitPromise:true });
const FOV_SETTLED = r2b.result.value;

/* 「看电视」期间的第一人称实测：拖屏转头 + W 走动，且 y 锁死不动。
   这一条必须**在点复位之前**跑 —— 复位会把相机飞回原位，测不出东西。
   ⚠ 合成 PointerEvent 的点 id 不是「真实指针」，setPointerCapture 必然抛
     NotFoundError（OrbitControls 与本项目自己的拖拽监听都包在 try 里除外，
     它没包）。这属于**测试脚手架噪声**，在下面的 errors 过滤里剔掉。 */
const r4 = await send('Runtime.evaluate', { expression:`(()=>{
  const dbg = window.__dbg, cam = dbg.camera;
  const dom = (dbg.renderer && dbg.renderer.domElement) || document.querySelector('canvas');
  if(!dom) return { skipped:true };
  const p0 = { x:+cam.position.x.toFixed(4), y:+cam.position.y.toFixed(4), z:+cam.position.z.toFixed(4) };
  const r0 = { x:+cam.rotation.x.toFixed(4), y:+cam.rotation.y.toFixed(4) };
  const snap = {
    rot0: r0, p0: p0,
    controlsEnabled: dbg.controls ? !!dbg.controls.enabled : 'n/a',
    fpOn: !!(window.__rig && window.__rig.fpOn),
    modeCountAt: document.querySelectorAll('.mode-btn[data-mode]').length
  };
  return new Promise(res=>{
    try{
      const opt = (x,y)=>({ pointerId:7, clientX:x, clientY:y, bubbles:true, pointerType:'mouse', isPrimary:true });
      dom.dispatchEvent(new PointerEvent('pointerdown', opt(700,300)));
      dom.dispatchEvent(new PointerEvent('pointermove', opt(900,300)));   // 右拖 200px = 右转
      dom.dispatchEvent(new PointerEvent('pointerup',   opt(900,300)));
      window.dispatchEvent(new KeyboardEvent('keydown', { code:'KeyW', bubbles:true }));
    }catch(e){ snap.err = String((e && e.message) || e); }
    setTimeout(function(){
      try{ window.dispatchEvent(new KeyboardEvent('keyup', { code:'KeyW', bubbles:true })); }catch(_){}
      snap.cloudPos = (function(){ const c = dbg.cloud; return c ? { x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2) } : null; })();
      snap.rot1 = { x:+cam.rotation.x.toFixed(4), y:+cam.rotation.y.toFixed(4) };
      snap.p1   = { x:+cam.position.x.toFixed(4), y:+cam.position.y.toFixed(4), z:+cam.position.z.toFixed(4) };
      res(snap);
    }, 500);
  });
})()`, returnByValue:true, awaitPromise:true });
const CV = r4.result.value;

/* 现在才点「复位」，轮询直到镜头飞回（tvActive 为 false） */
const r3 = await send('Runtime.evaluate', { expression:RESET_EXPR, returnByValue:true, awaitPromise:true });
const C0 = r3.result.value;
const C = r3.result.value;

const checks = [];
const ck = (name, pass, detail) => checks.push({ name, pass, detail });
/* 测试脚手架噪声：下面那条第一人称实测发的是**合成** PointerEvent（pointerId 不是
   真实指针）， Chrome 会让 setPointerCapture 抛 NotFoundError —— 节点自身没问题，
   真实指针不会这样。这条错误只在该探针跑过之后才有意义，这里直接剔掉。 */
const IGNORE_ERR = /setPointerCapture|No active pointer with the given id/;
const realErrors = errors.filter(e => !IGNORE_ERR.test(e));
ck('页面无异常 / 无 BUILD-FAIL', realErrors.length === 0 && !consoles.some(c => /BUILD-FAIL/.test(c)), realErrors.slice(0,3).join(' | ') || 'clean');
ck('window.__dbg 已建立', A && !A.err, 'typeof=' + (A && A.err ? A.err : 'object'));
ck('投影对象已创建', A && A.hasProjector, '');
ck('夜间按钮可见', A && A.rowDisplay !== 'none', 'rowDisplay=' + (A && A.rowDisplay));
ck('切到夜间后 projector 默认关闭', A && !A.initiallyVisible, 'visible=' + (A && A.initiallyVisible));
ck('点击按钮打开电视', B && B.afterClickVisible, 'visible=' + (B && B.afterClickVisible));
ck('点光源已点亮', B && B.lightVisible === true, 'lightVisible=' + (B && B.lightVisible));
ck('幕布使用 VideoTexture', B && B.hasVideoTexture, 'isVideoTexture=' + (B && B.hasVideoTexture));
ck('看电视时梯子隐藏', B && B.ladderVisible === false, 'ladderVisible=' + (B && B.ladderVisible));
ck('看电视时按钮变为复位', B && B.btnTextAfter === '复位', 'btnText=' + (B && B.btnTextAfter));
ck('看电视时进入 tvState', B && B.tvState === true, 'tvState=' + (B && B.tvState));
ck('看电视时切到第一人称（轨道交还用户）', B && B.fpOn === true && B.controlsEnabled === false, 'fpOn=' + (B && B.fpOn) + ' controlsEnabled=' + (B && B.controlsEnabled) + ' mode=' + (B && B.rigMode));
ck('看电视时播放视频原声（未静音）', B && B.videoMuted === false, 'videoMuted=' + (B && B.videoMuted));
ck('看电视时 fov 增量 = +22°', FOV_SETTLED && A && Math.abs((FOV_SETTLED.fov - A.fov0) - 22) < 1.5, 'fov0=' + (A && A.fov0) + ' fov（收敛后）=' + (FOV_SETTLED && FOV_SETTLED.fov ? FOV_SETTLED.fov.toFixed(2) : '?') + ' Δ=' + (FOV_SETTLED && A ? (FOV_SETTLED.fov - A.fov0).toFixed(2) : '?') + ' 采样=' + JSON.stringify(FOV_SETTLED && FOV_SETTLED.log));
ck('看电视时机位飞到床上（床尾侧、eye 抬高）', B && B.watchPos && Math.abs(B.watchPos.x + 3.2) < 0.8 && Math.abs(B.watchPos.z - 1.9) < 0.6 && B.watchPos.y > 2.2, 'pos=' + JSON.stringify(B && B.watchPos) + ' 期望=(-3.2, 床顶+0.68, 1.9)');
ck('幕布只保留三条框（去掉底架）', B && B.frameCount === 3, 'frameChildren=' + (B && B.frameCount));
ck('看电视时云移到电视上方', B && B.cloudPos && B.cloudPos.x < 2.6 && B.cloudPos.z < 1.6, 'cloud=' + JSON.stringify(B && B.cloudPos));
ck('复位后梯子显示', C && C.ladderVisible === true, 'ladderVisible=' + (C && C.ladderVisible));
/* 基线取**复位前那一帧**（CV），不是 20 秒前的 B：那段时间云本来还在往幕布飘，
   拿它当起点等于要求云先飘出去再飘回来，断言本身就不成立。 */
ck('复位后云沿原路挪回（往床心方向）', C && CV && C.cloudPos && CV.cloudPos && C.cloudPos.x >= CV.cloudPos.x + 0.02 && C.cloudPos.z >= CV.cloudPos.z - 0.02,
   'cloudBeforeReset=' + JSON.stringify(CV && CV.cloudPos) + ' cloudAfterReset=' + JSON.stringify(C && C.cloudPos) + ' home=(2.6,1.6) 幕布x=-8.23');
ck('复位后按钮恢复看电视', C && C.btnTextFinal === '看电视', 'btnText=' + (C && C.btnTextFinal));
/* 第一人称实测（拖拽转头 / W 走动 / y 锁死） */
const fpMove = (CV && CV.p1 && CV.p0) ? Math.hypot(CV.p1.x - CV.p0.x, CV.p1.z - CV.p0.z) : -1;
const fpTurn = (CV && CV.rot1 && CV.rot0) ? Math.abs(CV.rot1.y - CV.rot0.y) : -1;
ck('看电视时拖屏可原地转头', fpTurn > 0.5, 'Δyaw=' + (fpTurn < 0 ? 'n/a' : fpTurn.toFixed(3)) + ' rad（拖拽 200px）fpOn=' + (CV && CV.fpOn) + ' controlsEnabled=' + (CV && CV.controlsEnabled));
ck('看电视时 W 可走动', fpMove > 0.08, 'Δ水平=' + (fpMove < 0 ? 'n/a' : fpMove.toFixed(3)) + ' m（按住 W 约 0.5s）');
ck('第一人称 y 锁死（躺卧视点不下坠）', (CV && CV.p1 && CV.p0) && Math.abs(CV.p1.y - CV.p0.y) < 1e-6, 'Δy=' + ((CV && CV.p1 && CV.p0) ? (CV.p1.y - CV.p0.y).toFixed(6) : 'n/a'));

console.log('=== web 冒烟测试 ===');
for (const c of checks) console.log((c.pass ? '  ✓ ' : '  ✗ ') + c.name + (c.pass ? '' : '   → ' + c.detail));
if (consoles.length){
  console.log('\n--- console log ---');
  consoles.forEach(c => console.log('  ' + c.slice(0, 400)));
}
if (errors.length){
  console.log('\n--- 异常/console.error (' + errors.length + ') ---');
  errors.slice(0, 8).forEach(e => console.log('  ! ' + e.split('\n')[0].slice(0, 400)));
}
const bad = checks.filter(c => !c.pass).length;
console.log(bad ? `\nFAILED: ${bad} 项未通过` : '\nALL PASS');
cleanup();
process.exit(bad ? 1 : 0);
