/* ============================================================
   无头浏览器「带交互」截图工具
   ------------------------------------------------------------
   为什么需要它：--screenshot 只能拍静态首屏，无法验证
   pointerdown / 拖动 / 悬停 这类交互（虚拟摇杆、按钮）。
   本脚本用 CDP 派发真实鼠标事件，因此 canvas 上的
   PointerEvent、setPointerCapture 等都会正常触发。

   用法：
     node tools/headless-interact.mjs <url> <out.png> [steps.json]

   steps.json 是一个数组，按顺序执行：
     {"op":"wait","ms":800}
     {"op":"move","x":320,"y":430}          // 移动鼠标
     {"op":"down","x":320,"y":430}          // 左键按下
     {"op":"drag","x":320,"y":330,"ms":1200}// 按下并分步拖到目标点
     {"op":"up","x":320,"y":330}
     {"op":"shot","file":"step1.png"}       // 中途截图（相对 out 所在目录）
     {"op":"click","x":1130,"y":36}         // 点击（按下+抬起）

   退出前会自动落一张 <out.png>。
   ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT   = Number(process.env.CDP_PORT || 9333);

/* 画幅控制（都是环境变量，不改默认行为）：
     WIN_W / WIN_H   浏览器窗口尺寸，默认 1280×720
     VP_W  / VP_H    精确视口尺寸（Emulation.setDeviceMetricsOverride）。
                     截图尺寸 = 视口尺寸，所以竖版封面用 VP_W=1080 VP_H=1440 最省事：
                     chrome 的 --window-size 在 headless 下不等于视口，直接设视口才准。
     VP_DPR          设备像素比，默认 1（设 2 就出 2160×2880 的高清图）
     CLIP            "x,y,w,h[,scale]" —— 只截视口里的一块 */
const WIN_W = Number(process.env.WIN_W || 1280);
const WIN_H = Number(process.env.WIN_H || 720);
const VP_W  = Number(process.env.VP_W || 0);
const VP_H  = Number(process.env.VP_H || 0);
const CLIP  = (process.env.CLIP || '').split(',').filter(Boolean).map(Number);

const [url, out, stepsFile] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node headless-interact.mjs <url> <out.png> [steps.json]');
  process.exit(1);
}
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [];
const outDir = path.dirname(path.resolve(out));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const prof = path.join(process.env.TEMP || '/tmp', '_cdp_prof_' + Date.now());
/* CHROME_ARGS_EXTRA：额外塞给 Chrome 的参数（空格分隔）。
   典型用途：验证音频时加 --autoplay-policy=no-user-gesture-required，
   否则无头浏览器一律拒绝自动播放，永远量不到「启动就在播」。 */
const extraArgs = (process.env.CHROME_ARGS_EXTRA || '').split(' ').filter(Boolean);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--window-size=' + WIN_W + ',' + WIN_H, '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + prof, ...extraArgs, 'about:blank'
], { stdio: 'ignore', detached: false });

let ws;
try {
  /* 1. 等 DevTools 端口就绪 */
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  if (!ver) throw new Error('Chrome DevTools 端口未就绪');

  /* 2. 连上浏览器级 websocket，新建一个标签页并 attach */
  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const tgt = await send('Target.createTarget', { url: 'about:blank' });
  const att = await send('Target.attachToTarget', { targetId: tgt.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);

  /* 2.2 视口（可选）：headless 下 --window-size 含窗口装饰，实际视口会小一截，
         要「截出来就是 1080×1440」必须显式设视口。 */
  if (VP_W && VP_H) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: VP_W, height: VP_H,
      deviceScaleFactor: Number(process.env.VP_DPR || 1), mobile: false
    }, sid);
  }

  /* 2.5 错误采集钩子：必须在 navigate 之前注入，否则模块级异常先于脚本执行。
         （收尾时会打印 window.__errs —— 没有这个钩子就永远读不到页面报错） */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: [
      'window.__errs = [];',
      "addEventListener('error', e => { window.__errs.push((e.message||'') + ' @ ' + (e.filename||'') + ':' + (e.lineno||'')); });",
      "addEventListener('unhandledrejection', e => { window.__errs.push('unhandled: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)); });",
      "const _ce = console.error; console.error = (...a) => { window.__errs.push('console.error: ' + a.map(x => (x && x.message) || String(x)).join(' ')); _ce(...a); };"
    ].join('\n')
  }, sid);

  /* 3. 打开页面（three.js 走网络 CDN，给足时间） */
  /* 加载前注入（可选）：PRE_SCRIPT 里的代码会在页面任何脚本之前执行。
     用途是**确定性化** —— 场景构建里到处是 Math.random（草/云/蝴蝶的位置与
     颜色），不固定种子的话两次刷新就是两套布局，逐像素对照根本不成立。 */
  if (process.env.PRE_SCRIPT) {
    await send('Page.addScriptToEvaluateOnNewDocument',
      { source: process.env.PRE_SCRIPT }, sid);
  }

  await send('Page.navigate', { url }, sid);
  await sleep(Number(process.env.BOOT_MS || 7000));

  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', clickCount: 1, ...extra }, sid);

  const shot = async (file) => {
    const params = { format: 'png' };
    if (CLIP.length === 4 || CLIP.length === 5) {
      params.clip = { x: CLIP[0], y: CLIP[1], width: CLIP[2], height: CLIP[3], scale: CLIP[4] || 1 };
    }
    const r = await send('Page.captureScreenshot', params, sid);
    const p = path.resolve(outDir, file);
    fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    console.log('shot ->', p);
  };

  /* 4. 按脚本执行动作 */
  let btn = false;                       // 当前是否按下
  for (const s of steps) {
    switch (s.op) {
      case 'wait': await sleep(s.ms || 500); break;
      case 'move': await mouse('mouseMoved', s.x, s.y, { buttons: btn ? 1 : 0 }); break;
      case 'down': await mouse('mousePressed', s.x, s.y, { buttons: 1 }); btn = true; break;
      case 'up':   await mouse('mouseReleased', s.x, s.y, { buttons: 0 }); btn = false; break;
      case 'click': {
        await mouse('mousePressed', s.x, s.y, { buttons: 1 });
        await sleep(60);
        await mouse('mouseReleased', s.x, s.y, { buttons: 0 });
        break;
      }
      case 'drag': {
        const from = s.from || [s.x, s.y - 60];
        await mouse('mousePressed', from[0], from[1], { buttons: 1 });
        const n = s.steps || 12, ms = s.ms || 900;
        for (let i = 1; i <= n; i++) {
          const k = i / n;
          await mouse('mouseMoved',
            from[0] + (s.x - from[0]) * k, from[1] + (s.y - from[1]) * k, { buttons: 1 });
          await sleep(ms / n);
        }
        if (s.hold !== false) { await mouse('mouseReleased', s.x, s.y, { buttons: 0 }); btn = false; }
        break;
      }
      case 'clickSel': {
        /* 用选择器定位元素中心，再派发真实鼠标事件（验证命中区域，而非只调 click()） */
        const r = await send('Runtime.evaluate', {
          expression: `(()=>{const e=document.querySelector(${JSON.stringify(s.sel)});
            if(!e) return null; const b=e.getBoundingClientRect();
            return JSON.stringify([b.x+b.width/2, b.y+b.height/2]);})()`,
          returnByValue: true
        }, sid);
        const v = r.result && r.result.result && r.result.result.value;
        if (!v) { console.warn('未找到元素:', s.sel); break; }
        const [x, y] = JSON.parse(v);
        await mouse('mousePressed', x, y, { buttons: 1 });
        await sleep(70);
        await mouse('mouseReleased', x, y, { buttons: 0 });
        break;
      }
      case 'clickAt': {
        /* 先求坐标再真点：s.js 返回 [x, y]（或 JSON 数组），
           用来点「画面上某个三维物体投影到的位置」——没有 CSS 选择器可选，
           但必须走真实鼠标事件，才能验证 canvas 上的 pointerdown/up 逻辑。 */
        const r = await send('Runtime.evaluate',
          { expression: s.js, returnByValue: true }, sid);
        const v = r.result && r.result.result && r.result.result.value;
        if (!v) { console.warn('clickAt 没取到坐标:', s.js); break; }
        const [x, y] = Array.isArray(v) ? v : JSON.parse(v);
        await mouse('mouseMoved', x, y, { buttons: 0 });
        await sleep(40);
        await mouse('mousePressed', x, y, { buttons: 1 });
        await sleep(70);
        await mouse('mouseReleased', x, y, { buttons: 0 });
        console.log('clickAt', x.toFixed(0), y.toFixed(0));
        break;
      }
      case 'eval': {
        const r = await send('Runtime.evaluate',
          { expression: s.js, returnByValue: true, awaitPromise: !!s.await }, sid);
        console.log('eval:', JSON.stringify(r.result && r.result.result && r.result.result.value));
        break;
      }
      case 'waitFor': {
        /* 轮询直到表达式为真 —— 让脚本与帧率无关（无头软件渲染可能只有 2fps，
           按秒等待会让动画远远没走到目标状态） */
        const t0 = Date.now(), to = s.timeout || 90000;
        let ok = false, last;
        while (Date.now() - t0 < to) {
          const r = await send('Runtime.evaluate',
            { expression: s.js, returnByValue: true }, sid);
          last = r.result && r.result.result && r.result.result.value;
          if (last) { ok = true; break; }
          await sleep(s.poll || 350);
        }
        console.log((ok ? 'waitFor ✔ ' : 'waitFor ✖ 超时 ') + s.js +
                    '  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's, 末值=' + JSON.stringify(last) + ')');
        if (!ok && s.required !== false) console.warn('    条件未满足，继续执行');
        break;
      }
      case 'fps': {
        /* 无头软件渲染帧率很低，会直接影响「按秒推进」的动画进度，先量一下 */
        const r = await send('Runtime.evaluate', {
          expression: `new Promise(res=>{let n=0;const t0=performance.now();
            (function f(){ n++; const d=performance.now()-t0;
              if(d>1500) res(Math.round(n/(d/1000))); else requestAnimationFrame(f); })();})`,
          awaitPromise: true, returnByValue: true
        }, sid);
        console.log('fps ≈', r.result && r.result.result && r.result.result.value);
        break;
      }
      case 'shot': await shot(s.file); break;
      default: console.warn('未知动作:', JSON.stringify(s));
    }
  }

  /* 5. 收尾截图（顺带把控制台里的报错带出来） */
  await sleep(300);
  await shot(path.basename(out));

  const logs = await send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__errs || [])', returnByValue: true
  }, sid);
  if (logs.result && logs.result.result && logs.result.result.value) {
    const errs = JSON.parse(logs.result.result.value);
    if (errs.length) console.log('页面报错:', errs.join('\n'));
  }
} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(400);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
}
