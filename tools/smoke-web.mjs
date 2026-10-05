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
        homePos: dbg.camera.position.clone()
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
            controlsEnabled: dbg.controls ? !!dbg.controls.enabled : 'n/a',
            rigMode: window.__rig ? window.__rig.mode : 'n/a',
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

// 点击「复位」，轮询直到镜头飞回（tvActive 为 false）
const r3 = await send('Runtime.evaluate', { expression:`(()=>{
  const dbg = window.__dbg;
  const row = document.getElementById('ui-projector');
  const btn = row && row.querySelector('button');
  if(btn) btn.click();
  return new Promise(res=>{
    const start = performance.now();
    function poll(){
      if((!(window.__rig && window.__rig.tvActive)) || performance.now() - start > 100000){
        requestAnimationFrame(()=>{
          const ladder = dbg.ladder;
          const cam = dbg.camera;
        res({
          btnTextFinal: btn ? btn.textContent : '',
          ladderVisible: ladder ? ladder.visible : 'n/a',
          finalPos: { x: +cam.position.x.toFixed(3), y: +cam.position.y.toFixed(3), z: +cam.position.z.toFixed(3) },
          cloudPos: (function(){ const c = dbg.cloud; return c ? { x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2) } : null; })()
        });
        });
      } else { setTimeout(poll, 200); }
    }
    poll();
  });
})()`, returnByValue:true, awaitPromise:true });
const C = r3.result.value;

const checks = [];
const ck = (name, pass, detail) => checks.push({ name, pass, detail });
ck('页面无异常 / 无 BUILD-FAIL', errors.length === 0 && !consoles.some(c => /BUILD-FAIL/.test(c)), errors.slice(0,3).join(' | ') || 'clean');
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
ck('看电视后可继续调整视角（controls 交还用户）', B && B.controlsEnabled === true, 'controlsEnabled=' + (B && B.controlsEnabled) + ' mode=' + (B && B.rigMode));
ck('看电视时机位飞到床上（床尾侧、eye 抬高）', B && B.watchPos && Math.abs(B.watchPos.x + 3.2) < 0.8 && Math.abs(B.watchPos.z - 1.9) < 0.6 && B.watchPos.y > 2.2, 'pos=' + JSON.stringify(B && B.watchPos) + ' 期望=(-3.2, 床顶+0.68, 1.9)');
ck('幕布只保留三条框（去掉底架）', B && B.frameCount === 3, 'frameChildren=' + (B && B.frameCount));
ck('看电视时云移到电视上方', B && B.cloudPos && B.cloudPos.x < 2.6 && B.cloudPos.z < 1.6, 'cloud=' + JSON.stringify(B && B.cloudPos));
ck('复位后梯子显示', C && C.ladderVisible === true, 'ladderVisible=' + (C && C.ladderVisible));
ck('复位后云沿原路挪回（往床心方向）', C && B && C.cloudPos && C.cloudPos.x >= B.cloudPos.x && C.cloudPos.z >= B.cloudPos.z, 'cloudReset=' + JSON.stringify(C && C.cloudPos) + ' cloudWatch=' + JSON.stringify(B && B.cloudPos) + ' home=(2.6,1.6)');
ck('复位后按钮恢复看电视', C && C.btnTextFinal === '看电视', 'btnText=' + (C && C.btnTextFinal));

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
