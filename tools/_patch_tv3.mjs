/* 2026-10-05 幕布淡入淡出 + 云降 2m。model.js 是 CRLF，统一按 LF 匹配、回写时还原。 */
import fs from 'fs';
const F = 'model.js';
let s = fs.readFileSync(F, 'utf8');          // ⚠ Node 的 readFileSync 不做换行翻译，
s = s.replace(/\r\n/g, '\n');                //   model.js 是 CRLF，先折成 LF 再匹配
const OLD = [], NEW = [];
function X(o, n){ OLD.push(o); NEW.push(n); }

/* ① 幕布材质可透明（初始全透，由淡入曲线推上来） */
X(`    side: THREE.DoubleSide
  });`,
`    side: THREE.DoubleSide,
    /* 淡入淡出要用（用户 2026-10-05「电视的物体要慢慢淡入」）：
       初始 opacity 0，setOn(true) 之后由 applyFade 推上去；不设成 transparent
       的话 three 会走不透明分支，opacity 改了也不生效。 */
    transparent: true,
    opacity: 0
  });`);

/* ② frameMat 提到外层作用域（applyFade 要一起改它的 opacity） */
X(`  const thick = +(S.frameThickness !== undefined ? S.frameThickness : 0.06);
  if(thick > 0){
    const frameMat = new THREE.MeshStandardMaterial({ color: S.frameColor || '#2a2a40', roughness: 0.92 });`,
`  const thick = +(S.frameThickness !== undefined ? S.frameThickness : 0.06);
  let frameMat = null;                       // 提到外层，applyFade 也要动它
  if(thick > 0){
    frameMat = new THREE.MeshStandardMaterial({ color: S.frameColor || '#2a2a40', roughness: 0.92,
      transparent: true, opacity: 0 });      // 与幕布同步淡入淡出`);

/* ③ 淡入淡出状态机 */
X(`  group.userData.setOn = function(on){
    const v = !!on;
    if(group.visible === v) return;
    group.visible = v;
    screen.visible = v;
    light.visible = v;
    if(videoEl){
      if(v){ videoEl.currentTime = 0; videoEl.play().catch(()=>{}); }
      else { videoEl.pause(); }
    }
    tvAudioOn(v);
  };`,
`  /* ---- 淡入淡出（2026-10-05「电视的物体要慢慢淡入」）----
     幕布不再「啪」一下现形：开 = 1.4s 渐显、关 = 0.9s 渐隐。
     ⚠ opacity 和点光源强度**必须走同一条曲线** —— 只淡布不淡光会出现
     「布已经半透、光还把周围照得刺眼」的穿帮。
     淡到 0 之后才真正 visible=false；中途再点开时 setOn(true) 会重新推上来，
     不会有「卡在半透明」的残留。 */
  const FADE_IN  = +(S.fadeIn  !== undefined ? S.fadeIn  : 1.4);   // 秒（渐显）
  const FADE_OUT = +(S.fadeOut !== undefined ? S.fadeOut : 0.9);   // 秒（渐隐）
  const lightBase = +(L.intensity !== undefined ? L.intensity : 1.1);
  let fadeT = 0, fadeTo = 0;                 // 0 = 全透，1 = 全显
  function applyFade(){
    const o = fadeT < 0 ? 0 : (fadeT > 1 ? 1 : fadeT);
    mat.opacity = o;
    if(frameMat) frameMat.opacity = o;
    light.intensity = lightBase * o;
  }
  applyFade();                               // 初始：全透
  group.userData.setOn = function(on){
    const v = !!on;
    if(fadeTo === (v ? 1 : 0)) return;       // 已经在往这个方向走了，别重启
    fadeTo = v ? 1 : 0;
    if(v){
      group.visible = true; screen.visible = true; light.visible = true;
    }
    if(videoEl){
      /* 关：视频立刻停（用户 2026-10-05「关闭视频播放」），停住的那一帧陪着淡出，
         不必等 fade 跑完才停 —— 淡出总共才 0.9s。 */
      if(v){ videoEl.currentTime = 0; videoEl.play().catch(()=>{}); }
      else { videoEl.pause(); }
    }
    tvAudioOn(v);
  };`);

/* ④ 逐帧驱动淡入淡出（必须跑在 `if(!group.visible) return` 之前，
      否则关到 0 藏起来之后就再也淡不回来了） */
X(`  group.userData.update = function(dt, now){
    if(!group.visible) return;`,
`  group.userData.update = function(dt, now){
    if(fadeT !== fadeTo){                    // 淡入淡出驱动（Group 隐藏时也要跑）
      const fwd = fadeTo > fadeT;
      fadeT += (fwd ? 1 : -1) * (dt / (fwd ? FADE_IN : FADE_OUT));
      if((fwd && fadeT >= 1) || (!fwd && fadeT <= 0)) fadeT = fadeTo;
      applyFade();
      if(fadeT === 0){ group.visible = false; screen.visible = false; light.visible = false; }
    }
    if(!group.visible) return;`);

OLD.forEach((o, i) => {
  const n = s.split(o).length - 1;
  if(n !== 1){ console.error(`MISS(${n}) model.js 片段#${i + 1}`); process.exit(1); }
});
s = OLD.reduce((acc, o, i) => acc.replace(o, NEW[i]), s);
fs.writeFileSync(F, s.replace(/\n/g, '\r\n'), 'utf8');   // 还原 CRLF
console.log('model.js patched');
