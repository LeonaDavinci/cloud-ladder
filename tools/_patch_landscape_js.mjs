/* 2026-10-08 用户「画面要设置为横版」
 *
 * 三层一起上，因为**没有任何一层单独可靠**：
 *   ① 真锁：用户手势里 fullscreen + screen.orientation.lock('landscape')。
 *      Android X5 / UC / QQ 认；**iOS Safari 与 WebView 完全不认**。
 *   ② 舞台旋转：把 body 自己 rotate(90deg)，逻辑舞台就永远是宽的 —— iOS 唯一可行的路。
 *   ③ 竖屏门：旋转后仍要用户确认（设备锁了方向时门会变死路，且页面自己的 90° 旋转
 *      会抵消用户的物理旋转 —— 侧着拿手机恰好是画面看起来是正的姿势，
 *      但 innerWidth/innerHeight 与 screen.orientation 都不会变，**任何 orientation
 *      事件都测不出来**，只能让用户自己确认）。
 *
 * ⭐ 本项目只有 measureStage() 这一个函数读 innerWidth/innerHeight，全项目尺寸都走 STAGE。
 *   漏一处的后果（全都真实发生过，不是理论风险）：
 *     · renderer.setSize      → canvas 竖着 letterbox
 *     · camera.aspect         → 3D 画面被压扁
 *     · 半屏测试              → 摇杆左右分工对调
 *     · 摇杆基准坐标          → 摇杆落在屏幕外
 *     · 转头位移 (clientX/Y)  → **拖动轴向整个错掉**（旋转 90° 后物理 x 轴 = 舞台 y 轴）
 *
 * ⚠ EOL：main.js 是 LF，脚本按 LF 写回。
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const f = 'main.js';
let src = readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const subs = [
/* ---------- 1. 横屏模块：插在 IS_TOUCH 之后、IS_SMALL 之前 ---------- */
{ name: 'STAGE 模块', n:1,
  from:`const IS_TOUCH = ((navigator.maxTouchPoints || 0) > 1) || _FORCE_MOBILE;

const IS_SMALL = Math.min(innerWidth, innerHeight) <= 900;`,
  to:`const IS_TOUCH = ((navigator.maxTouchPoints || 0) > 1) || _FORCE_MOBILE;

/* ============================================================
   0b. 强制横屏（2026-10-08）
   ------------------------------------------------------------
   三层一起上，因为没有任何一层单独可靠：真锁（Android X5/UC 认，iOS 完全不认）、
   舞台旋转（iOS 唯一可行的路）、竖屏门（旋转后要用户确认，见下）。
   ⭐ 只有 measureStage() 读 innerWidth/innerHeight，其余全走 STAGE —— 漏一处就有一处
     永远是竖屏尺寸。详见本段末尾「漏了会坏」的清单。
   ============================================================ */
const ORIENT = { locked:false, ack:false, force:false, tries:0 };
/* 逻辑舞台：rot 时 w/h 是**旋转之后**的宽高（w > h 恒成立）；rawW/rawH 是物理视口。 */
const STAGE  = { w:0, h:0, rawW:0, rawH:0, rot:0, flip:false, onChange:null };

/* 桌面预览窗不该被掀 sideways —— 只有触摸设备才旋转。
   ⚠ 窄的桌面窗口 / 预览面板也会触发「竖着」，不加这个门它会被转 90° 看起来像坏了。 */
function shouldRotate(){
  if(ORIENT.force) return false;
  if(!IS_TOUCH) return false;
  return STAGE.rawH > STAGE.rawW;
}
/* 旋转方向：默认顺时针；?flip=1 强制逆时针（个别用户习惯反着拿）。 */
function wantFlip(){
  return ORIENT.forceFlip || _QS.get('flip') === '1';
}

/* ★ 全项目**唯一**读 innerWidth/innerHeight 的地方。
   优先 visualViewport —— 它给的是真实可见区域，不含地址栏 / home 指示条 / 安全区。 */
function measureStage(){
  const vv = window.visualViewport;
  STAGE.rawW = Math.max(1, Math.round(vv ? vv.width  : innerWidth));
  STAGE.rawH = Math.max(1, Math.round(vv ? vv.height : innerHeight));
  const rot = shouldRotate() ? (wantFlip() ? -1 : 1) : 0;
  const before = STAGE.w + 'x' + STAGE.h + '/' + STAGE.rot;
  STAGE.rot = rot;
  STAGE.flip = rot < 0;
  /* 旋转后：舞台宽 = 物理高、舞台高 = 物理宽 ⇒ 逻辑舞台永远宽 > 高。 */
  STAGE.w = rot ? STAGE.rawH : STAGE.rawW;
  STAGE.h = rot ? STAGE.rawW : STAGE.rawH;
  return before !== (STAGE.w + 'x' + STAGE.h + '/' + STAGE.rot);
}

/* 把舞台状态落到 DOM：切 html 类 + 用 px 写死 body 尺寸。
   ⚠ body 尺寸必须写 px（绝不能 100vh/100vw）：移动端 100vh 含地址栏，
     旋转后的舞台上会因此留一条缝。px 顺带让 % / vw 的行为都可预期。 */
function applyStage(){
  const html = document.documentElement;
  html.classList.toggle('ls-rot',  STAGE.rot !== 0);
  html.classList.toggle('ls-flip', STAGE.flip);
  html.classList.toggle('ls-ack',  ORIENT.ack);
  const b = document.body;
  if(STAGE.rot){
    b.style.width  = STAGE.w + 'px';   /* body 的宽 = 舞台的宽 */
    b.style.height = STAGE.h + 'px';
  }else{
    b.style.width = ''; b.style.height = '';   /* 清掉内联尺寸（清空是 '' 不是 false） */
  }
}

/* 物理视口坐标 → 舞台坐标。旋转 90° 之后「屏幕的左边」不再是「舞台的左边」，
   摇杆的左右分工与转头位移的轴向都会错，所以每个 pointer 事件入口都要先过这里。
   推导对着 style.css 的 transform（transform-origin:0 0）：
     CW  rotate(90deg) translateY(-100%):(x,y) → 物理 (rawW − y, x)
        ⇒ 逆：x = py,          y = rawW − px
     CCW rotate(-90deg) translateX(-100%):(x,y) → 物理 (y, STAGE.w − x)
        ⇒ 逆：x = STAGE.w − py, y = px
   ⚠ 这两条**必须对着真实 CSS 矩阵校准过**（tools/verify_landscape.mjs），
     手推不作数 —— 见该脚本里「解析 CSS transform → 反演 → 与本函数逐点比对」。 */
function screenToStage(px, py){
  if(STAGE.rot === 0) return { x:px, y:py };
  return STAGE.flip
    ? { x: STAGE.w - py, y: px }
    : { x: py,          y: STAGE.rawW - px };
}

/* 真锁：必须在用户手势里，且每一步都 try/catch —— 锁不上就降级，不能抛。 */
function lockLandscape(){
  if(ORIENT.locked) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  const so  = screen.orientation || screen.mozOrientation || screen.msOrientation;
  const after = ()=>{
    try{
      if(so && typeof so.lock === 'function'){
        const p = so.lock('landscape');
        if(p && p.then) p.then(()=>{ ORIENT.locked = true; measureStage(); applyStage(); }, ()=>{});
        else ORIENT.locked = true;
      }else if(typeof screen.lockOrientation === 'function'){
        screen.lockOrientation('landscape');
        ORIENT.locked = true;
      }
    }catch(_){}
  };
  try{
    if(req){
      const p = req.call(el);
      if(p && p.then) p.then(after, after); else after();
    }else after();
  }catch(_){}
}

/* 门的两个出口。主按钮**必须保留旋转** —— 见 ORIENT.ack 处的说明。 */
function bindRotateGate(){
  const okBtn = document.getElementById('rotateOk');
  const skBtn = document.getElementById('rotateSkip');
  if(okBtn) okBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    ORIENT.ack = true;
    applyStage();          /* ⚠⚠ 绝不在这里调「反向旋转」：用户正侧着拿手机，
                              取消旋转会让他看到 sideways 的竖屏 —— 恰恰是
                              「按钮没反应」这类 bug 的由来。 */
    lockLandscape();       /* 这个 tap 也是重试真锁的最佳时机 */
  });
  if(skBtn) skBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    ORIENT.force = true;   /* 真的没法横过来时的最后退路 */
    refreshStage();
  });
}

/* 尺寸变化 → 重测 → 落 DOM → 通知 renderer/camera。
   ⚠ 顺序有讲究：先改标志再调它，否则「只在变化时广播」的包装会因
     前后键值相同而什么都不派发，renderer 停在旧尺寸上。 */
function refreshStage(){
  const changed = measureStage();
  applyStage();
  if(changed && STAGE.onChange){ try{ STAGE.onChange(); }catch(_){} }
}

/* 手势里试真锁：不同内核授予「瞬时激活」的事件类型不一样（pointerdown /
   touchend / click 各有支持），所以前几次手势都试；锁定成功后解绑。
   ⚠ 门本身的点击不能忽略 —— 门盖住整个屏幕，忽略它就永远收不到那次能触发锁定的 tap。 */
function bindLandscapeGesture(){
  const tryLock = ()=>{
    if(ORIENT.locked){ unbump(); return; }
    if(!IS_TOUCH || !shouldRotate()) return;     /* 已经横着了 / 桌面：不用锁 */
    ORIENT.tries++;
    lockLandscape();
    if(ORIENT.tries >= 4) unbump();               /* 前 3~4 次手势都留着机会 */
  };
  const on = ()=>{ tryLock(); };
  function unbump(){
    removeEventListener('pointerdown', on, true);
    removeEventListener('touchend',   on, true);
    removeEventListener('click',      on, true);
  }
  addEventListener('pointerdown', on, true);
  addEventListener('touchend',   on, true);
  addEventListener('click',      on, true);
}

/* 启动时量一次（IS_SMALL 等要在建渲染器之前就有数） */
measureStage();

const IS_SMALL = Math.min(STAGE.rawW, STAGE.rawH) <= 900;` },

/* ---------- 2. 半屏测试：走舞台坐标 ---------- */
{ name: '半屏测试用舞台坐标', n:1,
  from:`    if(fp.on && e.clientX >= innerWidth*0.5) return;
    const s = (e.clientX < innerWidth*0.5) ? sMove : sLook;`,
  to:`    /* ⚠ 必须用**舞台**坐标判左右半屏：舞台被旋转 90° 之后，物理视口的左边
       对应的是舞台的上边 —— 直接用 clientX 会让左右两个摇杆对调。 */
    const sp = screenToStage(e.clientX, e.clientY);
    if(fp.on && sp.x >= STAGE.w*0.5) return;
    const s = (sp.x < STAGE.w*0.5) ? sMove : sLook;` },

/* ---------- 3. 漫游转头：位移也要转坐标 ---------- */
{ name: '漫游转头位移用舞台坐标', n:1,
  from:`    fp.dragId = e.pointerId; fp.lx = e.clientX; fp.ly = e.clientY;`,
  to:`    /* 位移同样要走舞台坐标：旋转 90° 后物理 x 轴就是舞台 y 轴，
       直接用 clientX/clientY 算增量会让拖动轴向整个错掉（横拖变竖摇）。 */
    const sp0 = screenToStage(e.clientX, e.clientY);
    fp.dragId = e.pointerId; fp.lx = sp0.x; fp.ly = sp0.y;` },
{ name: '漫游 pointermove 增量用舞台坐标', n:1,
  from:`    fp.mdx += (e.clientX - fp.lx); fp.mdy += (e.clientY - fp.ly);
    fp.lx = e.clientX; fp.ly = e.clientY;`,
  to:`    const sp1 = screenToStage(e.clientX, e.clientY);
    fp.mdx += (sp1.x - fp.lx); fp.mdy += (sp1.y - fp.ly);
    fp.lx = sp1.x; fp.ly = sp1.y;` },

/* ---------- 4. viewportSize() 改走 STAGE ---------- */
{ name: 'viewportSize 改走 STAGE', n:1,
  from:`  const viewportSize = ()=>{
    const vv = window.visualViewport;
    const w = Math.max(1, Math.round(vv ? vv.width  : innerWidth));
    const h = Math.max(1, Math.round(vv ? vv.height : innerHeight));
    return { w, h };
  };
  const _vp0 = viewportSize();`,
  to:`  /* ⚠ 这里**不再读 innerWidth/innerHeight**，改用 STAGE（0b 节的唯一测量点）。
     旋转时 STAGE.w/h 已经是旋转后的逻辑尺寸 —— 相机 aspect 与 drawing buffer
     要的是「舞台」尺寸，不是物理视口尺寸。 */
  const _vp0 = { w: STAGE.w, h: STAGE.h };` },
{ name: 'applyViewport 走 STAGE', n:1,
  from:`  const applyViewport = ()=>{
    const { w, h } = viewportSize();
    camera.aspect = w/h;`,
  to:`  const applyViewport = ()=>{
    const w = STAGE.w, h = STAGE.h;
    camera.aspect = w/h;` },

/* ---------- 5. resize 链路接上 STAGE，并启动门与手势锁 ---------- */
{ name: 'resize 链路接 STAGE + 启动横屏', n:1,
  from:`  addEventListener('resize', applyViewport);
  addEventListener('orientationchange', ()=>{ setTimeout(applyViewport, 120); setTimeout(applyViewport, 400); });
  if(window.visualViewport) window.visualViewport.addEventListener('resize', applyViewport);
  /* 屏幕常亮工具条/旋转时页面可能短暂失焦，回来补一次 */
  addEventListener('pageshow', applyViewport);`,
  to:`  /* 屏幕尺寸变化统一走 refreshStage()：它会重测 STAGE、落 DOM、切 .ls-rot，
     再回调 applyViewport 重建 drawing buffer 与 camera.aspect。 */
  STAGE.onChange = applyViewport;
  addEventListener('resize', refreshStage);
  addEventListener('orientationchange', ()=>{ setTimeout(refreshStage, 120); setTimeout(refreshStage, 400); });
  if(window.visualViewport) window.visualViewport.addEventListener('resize', refreshStage);
  /* 屏幕常亮工具条/旋转时页面可能短暂失焦，回来补一次 */
  addEventListener('pageshow', refreshStage);

  /* 横屏三件套：门 + 手势锁 + 落一次 DOM 状态。
     顺序上 applyStage 要在首次渲染前跑完，否则第一帧是竖的再转，会闪一下。 */
  bindRotateGate();
  bindLandscapeGesture();
  applyStage();` },
];

let ok = true;
for (const s of subs){ const c = src.split(s.from).length - 1;
  if (c !== s.n){ ok = false; console.error(`[FAIL] ${s.name} 命中 ${c}（期望 ${s.n}）`); } else console.log(`[ok]   ${s.name}`); }
if (!ok){ console.error('锚点没全中，一个字都没写'); process.exit(1); }
for (const s of subs) src = src.replace(s.from, s.to);
writeFileSync(join(ROOT, f), src, 'utf8');
console.log('[DONE] main.js (LF preserved)');
