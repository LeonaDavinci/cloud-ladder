/* 2026-10-05 云快速飞到幕布并降 2m + 播视频即停 BGM + 复位淡出关视频。
   main.js / atmosphere.js 是 LF（model.js 是 CRLF，另一个脚本处理）。 */
import fs from 'fs';
const OLD = [], NEW = [];
function X(o, n){ OLD.push(o); NEW.push(n); }

/* ---------- main.js ---------- */
X(`  function tvAudio(on){                          // 视频声音跟着幕布一起开合
    if(projector && projector.userData.tvAudio) projector.userData.tvAudio(on);
  }`,
`  function tvAudio(on){                          // 视频声音跟着幕布一起开合
    if(projector && projector.userData.tvAudio) projector.userData.tvAudio(on);
  }
  /* 统一的「关幕布」：淡出 + 停视频 + 收声音。
     专门抽出来是因为「看电视」有三条退路 —— 点复位按钮、按 R 复位、切到非夜间时相，
     后两条根本不经过 projBtn，不抽出来就会留下「幕布亮着、视频还在放」的场。
     函数声明会被提升到作用域顶部，所以 resetView（更早的位置）也能调它。 */
  function closeProjector(){
    if(!projectorOn) return;
    projectorOn = false;
    if(projector && projector.userData.setOn) projector.userData.setOn(false);
    tvAudio(false);
  }`);

/* 复位按钮分支：改成走 closeProjector */
X(`    if(isWatching){
      tvAudio(false);
      step.tvEnter(false, ()=>{ isWatching = false; syncProj(); });
      hint('已复位', 900);
    } else {`,
`    if(isWatching){
      closeProjector();                          // 幕布淡出 + 停视频 + 收声音
      step.tvEnter(false, ()=>{ isWatching = false; syncProj(); });
      hint('已复位', 900);
    } else {`);

/* 开：BGM 让位改到这里（点击那一刻，不等飞行动画落地） */
X(`      if(!projectorOn){
        projectorOn = true;
        if(projector && projector.userData.setOn) projector.userData.setOn(true);
      }
      tvAudio(true);`,
`      if(!projectorOn){
        /* 幕布一亮就把 BGM 让给视频声（2026-10-05「播视频时就要关掉正在播的音乐」）：
           放在**这次点击**里做，而不是 4.7s 飞行动画落地后 —— 用户说的是「播视频时」，
           幕布出现就该静下来。bgmBefore 也在这里记，复位靠它决定要不要接回来。 */
        try{ if(AUD){ bgmBefore = (AUD.state === 'playing');
                      if(bgmBefore && AUD.pause) AUD.pause(); } }catch(_){}
        projectorOn = true;
        if(projector && projector.userData.setOn) projector.userData.setOn(true);
      }
      tvAudio(true);`);

/* 落地回调里那份 BGM 处理删掉（已挪到点击处），只留状态机 */
X(`        /* 看电影时 BGM 让位给视频声音（2026-10-05）：淡出暂停，复位再接回来。
           AUD 是空壳 / 老版本没 pause() 时整段空转，无头脚本照样跑得通。 */
        try{
          if(AUD){ bgmBefore = (AUD.state === 'playing');
                   if(bgmBefore && AUD.pause) AUD.pause(); }
        }catch(_){}
        if(done) done();`,
`        /* BGM 的暂停挪到点击那一刻（见上方 projBtn 分支），这里只管状态机；
           复位那条路会原样把 BGM 接回来。AUD 是空壳 / 老版本没 pause() 时空转不报错。 */
        if(done) done();`);

/* 按 R 复位 / 复位视图：也把幕布关掉 */
X(`    if(tvState || fly){
      tvState = false; fly = null;`,
`    if(tvState || fly){
      tvState = false; fly = null;
      closeProjector();            // 幕布淡出 + 停视频（这条退路不经过 projBtn）`);

/* 切非夜间时相：一并关掉 */
X(`    /* 离开夜间时，如果正在「看电视」，自动复位并显示梯子 */
    if(!night && window.__rig && window.__rig.tvEnter) window.__rig.tvEnter(false);`,
`    /* 离开夜间时，如果正在「看电视」，自动复位并显示梯子（幕布一并淡出关掉） */
    if(!night){
      closeProjector();
      if(window.__rig && window.__rig.tvEnter) window.__rig.tvEnter(false);
    }`);

/* 云：记录原始 y + 降高量 */
X(`  const cloudHome = { x: cfg.cloud.center[0], z: cfg.cloud.center[2] };
  const cloudGoal = { x: (cfg.projector && cfg.projector.screen ? cfg.projector.screen.position[0] : cloudHome.x),
                      z: (cfg.projector && cfg.projector.screen ? cfg.projector.screen.position[2] : cloudHome.z) };
  let cloudShift = 0;`,
`  const cloudHome = { x: cfg.cloud.center[0], z: cfg.cloud.center[2] };
  const cloudHomeY = cloudGrp.position.y;      // 云整组原始高度（降 2m 的基准）
  /* 云飞到幕布上方时要**往下压 2 米**（用户 2026-10-05）：原来只是平着挪到幕布正上方，
     云离布太远，夜里看着像「天上一片白」而不是「飘到幕布跟前」。压下来才有贴上去的近感。
     想改幅度：scene.json / config.json 写 projector.cloudDrop。 */
  const CLOUD_DROP = +(cfg.projector && cfg.projector.cloudDrop !== undefined
                       ? cfg.projector.cloudDrop : 2);
  const cloudGoal = { x: (cfg.projector && cfg.projector.screen ? cfg.projector.screen.position[0] : cloudHome.x),
                      z: (cfg.projector && cfg.projector.screen ? cfg.projector.screen.position[2] : cloudHome.z) };
  let cloudShift = 0;`);

/* 动画循环：提速 + 降高 + 代理跟随 */
X(`    if(cloudGrp){
      /* 云随「看电视」缓慢移到幕布正上方，直到点复位才挪回去 */
      const want = (step.tvState ? step.tvState() : false) || (window.__rig && window.__rig.tvState);
      cloudShift += ((want ? 1 : 0) - cloudShift) * Math.min(1, dt*0.22);
      const cx = cloudHome.x + (cloudGoal.x - cloudHome.x)*cloudShift;
      const cz = cloudHome.z + (cloudGoal.z - cloudHome.z)*cloudShift;
      cloudGrp.position.x = cx - cloudHome.x;
      cloudGrp.position.z = cz - cloudHome.z;`,
`    if(cloudGrp){
      /* 云随「看电视」**快速**沉到幕布上方（原来 dt*0.22 ⇒ 时间常数 4.5s，慢得像在漂；
         现在 dt*1.5 ⇒ 约 0.66s 到位），点复位就按同一条曲线飘回原位。 */
      const want = (step.tvState ? step.tvState() : false) || (window.__rig && window.__rig.tvState);
      cloudShift += ((want ? 1 : 0) - cloudShift) * Math.min(1, dt*1.5);
      const cx = cloudHome.x + (cloudGoal.x - cloudHome.x)*cloudShift;
      const cz = cloudHome.z + (cloudGoal.z - cloudHome.z)*cloudShift;
      cloudGrp.position.x = cx - cloudHome.x;
      cloudGrp.position.z = cz - cloudHome.z;
      cloudGrp.position.y = cloudHomeY - CLOUD_DROP*cloudShift;   // 边飞边压 2m`);

X(`      if(pokeStep && pokeStep.pick){
        const pk = pokeStep.pick;
        pk.position.x = cx; pk.position.z = cz;
        pk.updateMatrix(); pk.updateMatrixWorld(true);
      }`,
`      if(pokeStep && pokeStep.pick){
        const pk = pokeStep.pick;
        pk.position.x = cx; pk.position.z = cz;
        pk.position.y = -CLOUD_DROP*cloudShift;  // pick 挂在 scene 上（绝对坐标），跟着一起沉
        pk.updateMatrix(); pk.updateMatrixWorld(true);
      }`);

/* ---------- atmosphere.js：夜间雾色压暗 ---------- */
X(`    fog:      { color: '#1e2a4c', near: 18, far: 4200 },
    fogDense: { color: '#242f52', near: 2.5, far: 58 },`,
`    /* 夜间雾色压暗（2026-10-05「晚上雾的颜色压暗一些」）：
       #1e2a4c → #131b34，#242f52 → #161e3c。雾色就是 scene.fog 的颜色、**不吃灯**，
       夜里远景的整块基调由它决定 —— 不压就永远是那层发灰的蓝雾，把月色糊掉、
       远山也泛白。压暗之后月亮和云才有对比，夜里才像夜。（near/far 不动，只改色。） */
    fog:      { color: '#131b34', near: 18, far: 4200 },
    fogDense: { color: '#161e3c', near: 2.5, far: 58 },`);

const MAIN_N = 9;                                   // main.js 占前 9 个片段，第 10 个给 atmosphere.js
const jobs = [['main.js', 0], ['atmosphere.js', MAIN_N]];
let bad = false;
for(const [F, base] of jobs){
  let s = fs.readFileSync(F, 'utf8');
  const off = base === 0 ? 0 : MAIN_N;
  OLD.slice(off, off + (base === 0 ? MAIN_N : OLD.length - MAIN_N))
  ;
}
for(const [F, off, cnt] of [['main.js', 0, MAIN_N], ['atmosphere.js', MAIN_N, 1]]){
  let s = fs.readFileSync(F, 'utf8');
  for(let i = 0; i < cnt; i++){
    const o = OLD[off + i], n = NEW[off + i];
    const hits = s.split(o).length - 1;
    if(hits !== 1){ console.error(`MISS(${hits}) ${F} 片段#${i + 1}`); bad = true; }
  }
}
if(bad) process.exit(1);
for(const [F, off, cnt] of [['main.js', 0, MAIN_N], ['atmosphere.js', MAIN_N, 1]]){
  let s = fs.readFileSync(F, 'utf8');
  for(let i = cnt - 1; i >= 0; i--){                 // 倒序替换，避免后插的串把前面的锚点顶掉
    s = s.replace(OLD[off + i], NEW[off + i]);
  }
  fs.writeFileSync(F, s, 'utf8');
  console.log(F + ' patched');
}
