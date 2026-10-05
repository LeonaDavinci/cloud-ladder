/* 一次性补丁：看电视 = FOV −8° + 第一人称操控 + BGM 让位给视频声音。
   每处 old 必须**恰好**命中一次，全中才写文件（防半改）。 */
import fs from 'node:fs';

const F = 'main.js';
let s = fs.readFileSync(F, 'utf8');
const OLD = [], NEW = [];
const rep = (old, nw) => { OLD.push(old); NEW.push(nw); };

/* ---- 1. FOV：+30 → +22（用户要求再减 8°） ---- */
rep(
`  /* 看电视时的「视角 +30°」（用户 2026-10-05 从 +15° 上调）：躺床上视野明显更开，
     像影院里广角盯住整块幕布。走 fovStep 的 boost 通道（下方自由/步行分支传
     tvState ? TV_FOV_BOOST : 0），自带 FOV_RATE 指数缓动，不是落地瞬间硬切。
     可在 scene.json / config.json 写 projector.tvFovBoost 改幅度（默认 30）。 */
  const TV_FOV_BOOST = +((cfg.projector && cfg.projector.tvFovBoost !== undefined)
                        ? cfg.projector.tvFovBoost : 30);`,
`  /* 看电视时的「视角增量」。走 fovStep 的 boost 通道（下方自由/步行分支传
     tvState ? TV_FOV_BOOST : 0），自带 FOV_RATE 指数缓动，不是落地瞬间硬切。
     轨迹：+15°（2026-10-05 用户上调）→ +30°（同日又嫌不够广）→ 又嫌太大，
     2026-10-05 晚再减 8° ⇒ 默认 +22°：广角感还在，但床沿和幕布框不会顶到画面边上。
     想改：scene.json / config.json 写 projector.tvFovBoost。 */
  const TV_FOV_BOOST = +((cfg.projector && cfg.projector.tvFovBoost !== undefined)
                        ? cfg.projector.tvFovBoost : 22);`);

/* ---- 2. 第一人称操控块（插在 setTVMode 之前） ---- */
rep(
`  function setTVMode(on, done){`,
`  /* ---------- 看电视：第一人称操控 ----------
     2026-10-05：看电视时不再是「绕焦点转的轨道相机」，而是站在床上的第一人称 ——
     拖拽原地转头、WASD / 方向键 / 双摇杆走动。
     ⚠ 这一路**完全不调 controls.update()**：OrbitControls 每帧都会按
     minDistance / maxPolarAngle 把相机拉回合法轨道（当年「落位被顶回去」那个 bug
     就是它干的），跟「人站定、头随便转」是死对头。于是看电视期间三件事同时成立：
       ① controls.enabled = false（不吃轨道输入）；
       ② step() 里直接 return，绕开 OrbitControls；
       ③ 相机由 fp 直接写 position / rotation。
     y 锁死在躺卧高度：这是「靠在床上看」的机位，不该再走一次地形跟随掉下床。 */
  const fp = { on:false, yaw:0, pitch:0, x:0, y:0, z:0,
               mdx:0, mdy:0, dragId:null, lx:0, ly:0 };
  function fpFromCamera(){
    fp.x = camera.position.x; fp.y = camera.position.y; fp.z = camera.position.z;
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    fp.yaw = e.y; fp.pitch = e.x;
    fp.mdx = 0; fp.mdy = 0; fp.dragId = null;
    hideSticks();
  }
  function fpToCamera(){
    camera.rotation.set(fp.pitch, fp.yaw, 0);
    camera.position.set(fp.x, fp.y, fp.z);
  }
  /* 转头：把指针位移攒成「本帧要转多少」的增量、在 fpStep 里统一消费
     （和 walk 一个路子 —— 事件里直接动相机，一帧多点 + 指针捕获乱序会明显抖）。 */
  dom.addEventListener('pointerdown', e=>{
    if(!fp.on || fp.dragId !== null) return;
    if(sMove.id !== null || sLook.id !== null) return;   // 摇杆已经占了这个手势
    fp.dragId = e.pointerId; fp.lx = e.clientX; fp.ly = e.clientY;
    try{ dom.setPointerCapture(e.pointerId); }catch(_){}
  });
  dom.addEventListener('pointermove', e=>{
    if(e.pointerId !== fp.dragId) return;
    fp.mdx += (e.clientX - fp.lx); fp.mdy += (e.clientY - fp.ly);
    fp.lx = e.clientX; fp.ly = e.clientY;
  });
  ['pointerup','pointercancel'].forEach(t => dom.addEventListener(t, e=>{
    if(e.pointerId === fp.dragId) fp.dragId = null;
  }));
  function fpStep(dt){
    const TVP = ((cfg.projector && cfg.projector.control) || {});
    const look = (TVP.lookSpeed || 2.2), spd = (TVP.moveSpeed || 1.8);
    fp.yaw   -= fp.mdx*0.0032*look;                 // 右拖 = 右转（与 walk 手感一致）
    fp.pitch -= fp.mdy*0.0032*look*0.7;
    fp.mdx = 0; fp.mdy = 0;
    if(keys.KeyQ || keys.ArrowLeft)  fp.yaw   += look*0.8*dt;
    if(keys.KeyE || keys.ArrowRight) fp.yaw   -= look*0.8*dt;
    if(keys.ArrowUp)   fp.pitch += look*0.5*dt;
    if(keys.ArrowDown) fp.pitch -= look*0.5*dt;
    fp.pitch = THREE.MathUtils.clamp(fp.pitch, -1.2, 1.2);   // 躺着抬头，别翻过去

    /* 移动沿用 walk 的约定：前 = (-sin yaw, -cos yaw)、右 = (cos yaw, -sin yaw)，
       摇杆 my<0 = 前 ⇒ wx = cy*mx + sy*my / wz = -sy*mx + cy*my */
    let mx = sMove.x, my = sMove.y;
    if(keys.KeyW) my -= 1;
    if(keys.KeyS) my += 1;
    if(keys.KeyA) mx -= 1;
    if(keys.KeyD) mx += 1;
    const sy = Math.sin(fp.yaw), cy = Math.cos(fp.yaw);
    let wx = cy*mx + sy*my, wz = -sy*mx + cy*my;
    const m = Math.hypot(wx, wz);
    if(m > 1){ wx /= m; wz /= m; }
    if(m > 1e-3){ fp.x += wx*spd*dt; fp.z += wz*spd*dt; }
    fpToCamera();
  }
  /* 进来看电视时 BGM 在不在放 —— 复位时照原样接回来，没在放就别自作主张起播。 */
  let bgmBefore = false;

  function setTVMode(on, done){`);

/* ---- 3. 落地回调：交出第一人称 + 暂停 BGM ---- */
rep(
`        tvState = true;
        controls.enabled = true;
        /* 看电影期间 BGM 不许被动停：被视频/自动播放那一套带停的话，
           这里补一次 start（AUD 为空壳时是空操作，无头脚本照样跑得通）。 */
        try{ if(AUD && AUD.state !== 'playing') AUD.start(); }catch(_){}
        if(done) done();
      });`,
`        tvState = true;
        /* 第一人称接管：轨道门先关掉（下面 fp.on 直接写相机），
           一帧 controls.update() 都不要 —— 它会按轨道约束把人从床上拽走。 */
        controls.enabled = false;
        fpFromCamera(); fp.on = true;
        /* 看电影时 BGM 让位给视频声音（2026-10-05）：淡出暂停，复位再接回来。
           AUD 是空壳 / 老版本没 pause() 时整段空转，无头脚本照样跑得通。 */
        try{
          if(AUD){ bgmBefore = (AUD.state === 'playing');
                   if(bgmBefore && AUD.pause) AUD.pause(); }
        }catch(_){}
        if(done) done();
      });`);

/* ---- 4. 复位分支：收掉第一人称 + 接回 BGM ---- */
rep(
`      startFly(tvHome.pos.clone(), tvHome.target.clone(), 4.0, false, ()=>{
        tvState = false;
        controls.enabled = true;`,
`      fp.on = false; fp.dragId = null;          // 交还给 OrbitControls 之前先收掉第一人称
      controls.enabled = true;
      try{ if(AUD && bgmBefore && AUD.state !== 'playing' && AUD.resume) AUD.resume(); }catch(_){}
      startFly(tvHome.pos.clone(), tvHome.target.clone(), 4.0, false, ()=>{
        tvState = false;
        controls.enabled = true;`);

/* ---- 5. step：看电视走第一人称，绕开 OrbitControls ---- */
rep(
`    fovStep(dt, tvState ? TV_FOV_BOOST : 0);   // 步行 / 自由：无看电视时回原值
    if(mode === 'walk'){`,
`    fovStep(dt, tvState ? TV_FOV_BOOST : 0);   // 步行 / 自由：无看电视时回原值
    if(tvState && fp.on){ fpStep(dt); return; }  // 看电视：第一人称，一帧都不碰 OrbitControls
    if(mode === 'walk'){`);

/* ---- 6. 摇杆在「看电视」时也要能用（手机端左半屏走、右半屏转头） ---- */
rep(
`  dom.addEventListener('pointerdown', e=>{
    if(mode !== 'walk') return;`,
`  dom.addEventListener('pointerdown', e=>{
    if(mode !== 'walk' && !(fp.on)) return;     // 看电视时同样挂双摇杆：左走 / 右转头`);

/* ---- 7. resetView 也要收掉第一人称 ---- */
rep(
`    if(tvState || fly){
      tvState = false; fly = null;
      if(ladder) ladder.visible = true;
      controls.enabled = true;
    }`,
`    if(tvState || fly){
      tvState = false; fly = null;
      fp.on = false; fp.dragId = null;          // 第一人称先收，否则复位后还攥着相机
      if(ladder) ladder.visible = true;
      controls.enabled = true;
    }`);

/* ---- 8. 调试出口 ---- */
rep(
`    get tvState(){ return tvState; },`,
`    get tvState(){ return tvState; },
    get fpOn(){ return fp.on; },   // 看电视期间是不是第一人称（无头断言用）`);

/* ---- 9. UI：看电视期间锁掉三种玩法模式；视频声音跟着开关 ---- */
rep(
`  const projBtn = mkBtn('看电视', () => {
    if(!projectorAvailable || !step) return;
    if(step.tvActive() && !isWatching) return;   // 飞行途中忽略点击
    if(isWatching){
      step.tvEnter(false, ()=>{ isWatching = false; syncProj(); });
      hint('已复位', 900);
    } else {
      if(!projectorOn){
        projectorOn = true;
        if(projector && projector.userData.setOn) projector.userData.setOn(true);
      }
      step.tvEnter(true, ()=>{ isWatching = true; syncProj(); });
      hint('靠在床上看电视', 1200);
    }
  });
  projBtn.title = '夜间专属：靠在床上看电视 / 复位（快捷键 P）';`,
`  /* 看电视期间把三种玩法模式锁掉：那一刻是第一人称（拖屏转头 / WASD 走动），
     和自由模式的轨道、步行模式的角色是两套输入，同时亮着只会被当成「按钮失灵」。 */
  function lockModes(on){
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), b=>{
      if(!b.dataset.mode) return;
      b.disabled = !!on;
    });
  }
  function tvAudio(on){                          // 视频声音跟着幕布一起开合
    if(projector && projector.userData.tvAudio) projector.userData.tvAudio(on);
  }
  const projBtn = mkBtn('看电视', () => {
    if(!projectorAvailable || !step) return;
    if(step.tvActive() && !isWatching) return;   // 飞行途中忽略点击
    if(isWatching){
      lockModes(false); tvAudio(false);
      step.tvEnter(false, ()=>{ isWatching = false; syncProj(); });
      hint('已复位', 900);
    } else {
      /* 声音必须在**这次点击**里开：WebAudio 增益链路要用户手势才起得来
         （createMediaElementSource 接上后音频只走这条图，上下文不上就是静音）。 */
      if(!projectorOn){
        projectorOn = true;
        if(projector && projector.userData.setOn) projector.userData.setOn(true);
      }
      tvAudio(true);
      lockModes(true);
      step.tvEnter(true, ()=>{ isWatching = true; syncProj(); });
      hint('靠在床上看电视 · 拖屏转头 / WASD 走动', 1600);
    }
  });
  projBtn.title = '夜间专属：靠在床上看电视（第一人称：拖屏转头 · WASD/方向键走动） / 复位（快捷键 P）';`);

/* ---- 10. 幕布不可用时也把声音关掉 ---- */
rep(
`    if(!projectorAvailable){
      isWatching = false;
      projectorOn = false;`,
`    if(!projectorAvailable){
      isWatching = false;
      projectorOn = false;
      lockModes(false); tvAudio(false);`);

/* ---- 逐个断言命中 ---- */
let ok = true;
OLD.forEach((o, i) => {
  const n = s.split(o).length - 1;
  if(n !== 1){ console.error(`✗ [${i}] 命中 ${n} 次（应为 1）：\n${o.slice(0, 90)}…`); ok = false; }
});
if(!ok){ console.error('ABORT：一处没精确命中，文件未改。'); process.exit(1); }
s = OLD.reduce((acc, o, i) => acc.replace(o, NEW[i]), s);
fs.writeFileSync(F, s, 'utf8');
console.log('✓ main.js 全部 10 处补丁写入成功');
