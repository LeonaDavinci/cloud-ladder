/* 2026-10-08 用户反馈「截图检查，没有横屏」—— 修三处根因 + UI 布局调整
 *
 * 【根因 1】IS_TOUCH 判定太硬
 *   `navigator.maxTouchPoints > 1` 在真实环境里并不可靠：无头 Chrome 实测竖屏下能读到
 *   **0**，而微信 / 小红书 WebView 也常见 0 或 1 ⇒ 手机上根本没进「触摸」分支，
 *   于是 shouldRotate() 直接返回 false，**一层都不转**。
 *   放宽成三路或：maxTouchPoints > 0 / pointer:coarse / ontouchstart in window。
 *
 * 【根因 2】桌面竖窗完全不转
 *   原来 `!IS_TOUCH → 不转`（为了不掀翻窄桌面预览窗）。但用户要的是「画面横版」，
 *   桌面竖着的窗口同样该转。⇒ 去掉 IS_TOUCH 门控，改为「视口竖着就转」，
 *   并留 `?norot=1` 逃生口。
 *
 * 【根因 3】OrbitControls 在旋转舞台下轴向会错（旋转 90° 后物理 x 轴 = 舞台 y 轴）
 *   桌面鼠标拖拽走的是 three 的 OrbitControls，它直接读 e.clientX/clientY。
 *   修法：在**捕获阶段**把事件对象的 clientX/clientY 覆写成舞台坐标，
 *   OrbitControls 后到的监听器读到的就是对的。桌面才能正常拖动转视角。
 *
 * 【UI 调整】用户要求：雾效放在时相上面、隐藏 UI 挪到右下角、看电视放底部中间
 *   ① #ui-fog 用 flex `order` 提到 #ui-time 上方（**不改 HTML**，顺序即 DOM 序）
 *   ② #ui-toggle → 右下角（原来在左下，还要让位给 scene-ui）
 *   ③ #ui-projector → position:fixed 拿出去，底部居中（原来挤在左列面板里）
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = 0;
function apply(file, subs){
  let src = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n'); const bad = [];
  for (const s of subs){ const c = src.split(s.from).length - 1;
    if (c !== s.n) bad.push(`${s.name} 命中 ${c}（期望 ${s.n}）`); }
  if (bad.length){ console.error(`[FAIL] ${file}`); bad.forEach(b=>console.error('       '+b)); failed++; return; }
  for (const s of subs) src = src.replace(s.from, s.to);
  writeFileSync(join(ROOT, file), src, 'utf8');
  console.log(`[ok]   ${file}  (${subs.length} 处)`);
}

/* ================= main.js ================= */
apply('main.js', [
{ name: 'IS_TOUCH 三路或', n:1,
  from:`const IS_TOUCH = ((navigator.maxTouchPoints || 0) > 1) || _FORCE_MOBILE;`,
  to:`/* ⚠ 2026-10-08：原来只有 \`maxTouchPoints > 1\` 一路，实测在**无头 Chrome 的手机
     竖屏下读到 0**，微信 / 小红书 WebView 也常见 0 或 1 ⇒ 手机上直接没进「触摸」分支，
     于是横屏一层都没转（用户反馈「没有横屏」）。改成三路或，任一命中即算触摸设备。 */
const IS_TOUCH = ((navigator.maxTouchPoints || 0) > 0)
              || (window.matchMedia && matchMedia('(pointer:coarse)').matches)
              || ('ontouchstart' in window)
              || _FORCE_MOBILE;` },

{ name: 'shouldRotate 去掉 IS_TOUCH 门控、加 norot 逃生口', n:1,
  from:`/* 桌面预览窗不该被掀 sideways —— 只有触摸设备才旋转。
   ⚠ 窄的桌面窗口 / 预览面板也会触发「竖着」，不加这个门它会被转 90° 看起来像坏了。 */
function shouldRotate(){
  if(ORIENT.force) return false;
  if(!IS_TOUCH) return false;
  return STAGE.rawH > STAGE.rawW;
}`,
  to:`/* 「视口是竖着的就转」—— 不再按设备类型分叉。
   ⚠ 原来这里有 \`if(!IS_TOUCH) return false\`，意思是**桌面竖窗一律不转**；
     用户要的是「画面横版」，桌面竖着的窗口同样该转，于是去掉这道门。
     逃生口：URL 加 ?norot=1（不动旋转，按原样竖着显示）。 */
function shouldRotate(){
  if(ORIENT.force) return false;
  if(_QS.get('norot') === '1') return false;
  return STAGE.rawH > STAGE.rawW;
}` },

{ name: '手势锁不再按 IS_TOUCH 跳（桌面全屏旋转也无害）', n:1,
  from:`    if(!IS_TOUCH || !shouldRotate()) return;     /* 已经横着了 / 桌面：不用锁 */`,
  to:`    if(!shouldRotate()) return;                  /* 已经横着了 / 显式关掉：不用锁 */` },

{ name: 'OrbitControls 坐标逆变换（捕获阶段）', n:1,
  from:`  /* 屏幕尺寸变化统一走 refreshStage()：它会重测 STAGE、落 DOM、切 .ls-rot，`,
  to:`  /* ⚠ OrbitControls 的轴向修正（2026-10-08）：舞台被旋转 90° 之后，物理视口的
     x 轴就是舞台的 y 轴，而 OrbitControls 直接读 e.clientX/clientY ⇒ 桌面鼠标
     「横拖」会变成「竖转」。
     修法：在**捕获阶段**（:true）把事件对象上的 clientX/clientY 覆写成舞台坐标，
     OrbitControls 自己的监听器在冒泡阶段才跑，读到的就已经是舞台坐标了。
     事件属性本来只读，用 defineProperty 在这个事件对象上盖一层是可以的
     （只影响这一个事件，不会污染全局原型）。 */
  if(window.innerWidth || true){
    const fixEventCoords = (e)=>{
      if(STAGE.rot === 0 || e.__stageFixed) return;
      const p = screenToStage(e.clientX, e.clientY);
      try{
        Object.defineProperty(e, 'clientX', { value:p.x, configurable:true });
        Object.defineProperty(e, 'clientY', { value:p.y, configurable:true });
        e.__stageFixed = true;
      }catch(_){}
    };
    const stageEl = renderer.domElement;
    stageEl.addEventListener('pointerdown', fixEventCoords, true);
    stageEl.addEventListener('pointermove', fixEventCoords, true);
    stageEl.addEventListener('pointerup',   fixEventCoords, true);
    stageEl.addEventListener('wheel',       fixEventCoords, true);
  }

  /* 屏幕尺寸变化统一走 refreshStage()：它会重测 STAGE、落 DOM、切 .ls-rot，` },
]);

/* ================= style.css ================= */
apply('style.css', [
{ name: 'UI 三项调整（雾在时相上 / toggle 右下 / 看电视底部居中）', n:1,
  from:`/* 路径 A：舞台被旋转过（逻辑舞台必是横的） */`,
  to:`/* ================================================================
   UI 微调（2026-10-08 用户指定）
   ------------------------------------------------------------
   ① 雾档提到时相**上面** —— 用 flex 的 order，不动 HTML。
      DOM 顺序仍按「快捷键提示 → 时相 → 滤镜 → 雾 → 看电视」写着（可读性），
      视觉顺序由 order 重排，以后再插一行也不会打乱这三条相对位置。
   ② 「隐藏 UI」挪到右下角：原来在左下，和时相/滤镜面板挤在同一列。
   ③ 「看电视」从面板里拿出来，用 position:fixed 放到**底部正中** ——
      它是模式之外的一个大动作，压在画面中轴上更好按，也不占侧栏的竖向空间。
   ================================================================ */

/* ① 视觉顺序：雾 → 时相 → 滤镜（DOM 顺序不变） */
#scene-ui #ui-time  { order:2; }
#scene-ui #ui-fog   { order:1; }
#scene-ui #ui-filter{ order:3; }

/* ③ 看电视：脱离面板的竖向流，钉在底部正中。
   注意要在场景里排到时相/滤镜之后，否则 flex 会把它放最上面。 */
#scene-ui #ui-projector{
  position:fixed;left:50%;bottom:10px;
  transform:translateX(-50%);
  order:9;
}
html.ls-rot #scene-ui #ui-projector{
  bottom:calc(10px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
}

/* ② 隐藏 UI：右下角（原来左下）。左下让位给时相/滤镜面板。 */
html.ls-rot #ui-toggle,
html:not(.ls-rot) #ui-toggle{
  left:auto;right:calc(16px + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)));
  bottom:10px;transform:none;
}
@media (min-aspect-ratio: 1/1){
  html:not(.ls-rot) #ui-toggle{
    left:auto;right:16px;bottom:10px;transform:none;
  }
}

/* 路径 A：舞台被旋转过（逻辑舞台必是横的） */` },
]);

console.log(failed ? `\n${failed} 个文件未改动` : '\n全部文件已更新');
process.exit(failed ? 1 : 0);
