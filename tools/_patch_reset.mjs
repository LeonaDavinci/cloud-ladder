/* 一次性补丁：让「复位」真正复位。
   1) resetView 里原来的 closeProjector() 在 createSceneUI 的作用域里根本不存在
      ⇒ ReferenceError，在相机归位之前就抛 ⇒ 复位看着像「点了没反应」（视角动不了、
      梯子不出来、时相留在夜间）。改成走 build 注入的 tvHooks。
   2) 复位时一并切回「下午」（首屏那一档），并把玩法按钮 / 轨道约束 / 第一人称全收干净。
   ⚠ main.js 是 CRLF，Node 读进来不翻译换行，所以先归一再替换、写完再还原。 */
import fs from 'fs';

const P = 'E:/workbuddy/cloud-ladder/main.js';
let s = fs.readFileSync(P, 'utf8').replace(/\r\n/g, '\n');

function sub(anchor, to, tag){
  const n = s.split(anchor).length - 1;
  if(n !== 1) throw new Error(`anchor miss(${n}) :: ${tag}`);
  s = s.replace(anchor, to);
  console.log('OK  ' + tag);
}

/* ---- 1. setupModes 收一个 tvHooks ---- */
sub(
  'function setupModes(cfg, camera, controls, renderer, rig, AUD, ladder){',
  'function setupModes(cfg, camera, controls, renderer, rig, AUD, ladder, tvHooks){',
  '1 setupModes(tvHooks)'
);

/* ---- 2. resetView：看电视退出块 ---- */
sub(
`    /* 若正处在「看电视」位姿，先清掉这个状态再复位 */
    if(tvState || fly){
      tvState = false; fly = null;
      closeProjector();            // 幕布淡出 + 停视频（这条退路不经过 projBtn）
      fp.on = false; fp.dragId = null;          // 第一人称先收，否则复位后还攥着相机
      if(ladder) ladder.visible = true;
      controls.enabled = true;
    }`,
`    /* 若正处在「看电视」位姿，先把这个状态连同它绑住的每一样东西一起清掉再复位。
       ⚠ 原来这里直接 write closeProjector() —— 它是 createSceneUI **内部**的函数，
         setupModes 这一层看不见 ⇒ 一调就是 ReferenceError，而且抛在下面相机归位之前：
         复位看着像「点了没反应」，人还留在床上（fp.on 为真、controls.enabled 为 false，
         于是摄像机完全动不了）、梯子也不出来、幕布和视频还开着。现在走 tvHooks，
         真身由 build 在 createSceneUI 之后接进来。 */
    if(tvState || fly || fp.on){
      tvState = false;
      if(fly){ fly = null; controls.enabled = true; }   // 丢掉正在跑的飞行动画
      fp.on = false; fp.dragId = null;          // 第一人称先收，否则复位后还攥着相机
      applyTVLimits(false);                     // 轨道约束收回（看电视时为落位临时放松过）
      btns.forEach(b => { b.disabled = false; });      // 三个玩法按钮跟着交还（落地时锁过）
      if(ladder) ladder.visible = true;         // 梯子回来（看电视时藏过）
      controls.enabled = true;
      if(tvHooks && tvHooks.closeProjector) tvHooks.closeProjector();   // 幕布淡出 + 停视频
    }`,
  '2 resetView tv-exit'
);

/* ---- 3. resetView 末尾：切回下午 + 同步按钮 ---- */
sub(
`    fovReset();                            // 视场角回原值（爬梯那一段可能正拉到 64°）
    refreshHint();`,
`    fovReset();                            // 视场角回原值（爬梯那一段可能正拉到 64°）
    /* 「复位 = 打开页面时的样子」也包含时相：回到「下午」这一档（首屏）。
       ⚠ 必须放在**最末**：atmos.apply → onPhase 会顺手再走一次 closeProjector /
       tvEnter(false)，那时 tvState 已是 false、幕布也早关了，两条都是空操作；
       要是放在最前，tvEnter(false) 会立刻起飞 4s 往回飞，跟下面的硬归位互相拉扯，
       相机就停在半路上了。 */
    try{ if(tvHooks && tvHooks.applyPhase) tvHooks.applyPhase(tvHooks.defaultPhase || 'afternoon'); }catch(_){}
    try{ if(tvHooks && tvHooks.syncUi) tvHooks.syncUi(); }catch(_){}
    refreshHint();`,
  '3 resetView phase'
);

/* ---- 4. build：tvHooks 空壳 + 注入 ---- */
sub(
`  const step = setupModes(cfg, camera, controls, renderer, rig, AUD, ladder);`,
`  /* 复位要从 setupModes 那头关幕布 / 切时相，可这两个出口一个藏在 createSceneUI 内部
     （closeProjector）、一个要到 build 后面才建出来（atmos）。先挂个空壳，
     等走到那两步再填真身（见下方 ATMOS-FAIL 与 window.__sceneUI 那两处）。 */
  const tvHooks = { applyPhase: null, closeProjector: null, syncUi: null, defaultPhase: 'afternoon' };
  const step = setupModes(cfg, camera, controls, renderer, rig, AUD, ladder, tvHooks);`,
  '4a tvHooks decl'
);

sub(
`  } catch(e){ console.error('ATMOS-FAIL ' + (e && e.stack ? e.stack : e)); throw e; }`,
`  } catch(e){ console.error('ATMOS-FAIL ' + (e && e.stack ? e.stack : e)); throw e; }

  /* 复位切「下午」的出口（tvHooks.applyPhase 见 resetView 末尾那几行） */
  tvHooks.applyPhase = (name) => { try{ if(atmos) atmos.apply(name); }catch(_){} };
  tvHooks.defaultPhase = ((atmos && atmos.names && atmos.names[0]) || 'afternoon');`,
  '4b applyPhase'
);

sub(
`  window.__sceneUI = sceneUI;`,
`  window.__sceneUI = sceneUI;
  /* resetView（在 setupModes 里）要从外面关幕布：closeProjector 是 createSceneUI 内部的函数，
     这里转发一份出去 —— 千万别在 setupModes 里按名字直接调它（会 ReferenceError）。
     同步时相/滤镜/雾档按钮的高亮也一并交给 UI 的 sync()。 */
  tvHooks.closeProjector = () => { try{ if(window.__sceneUI && window.__sceneUI.closeProjector) window.__sceneUI.closeProjector(); }catch(_){} };
  tvHooks.syncUi = () => { try{ if(window.__sceneUI && window.__sceneUI.sync) window.__sceneUI.sync(); }catch(_){} };`,
  '4c closeProjector hook'
);

/* ---- 5. createSceneUI 对外露出 closeProjector ---- */
sub(
`    setProjectorAvailable,
    dispose(){ removeEventListener('keydown', onKey); }`,
`    setProjectorAvailable,
    closeProjector(){ closeProjector(); },        // 复位用（tvHooks.closeProjector 转发进来）
    dispose(){ removeEventListener('keydown', onKey); }`,
  '5 api.closeProjector'
);

fs.writeFileSync(P, s.replace(/\n/g, '\r\n'), 'utf8');
console.log('written CRLF');
