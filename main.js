import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAudio } from './audio.js?v=62';
import { createPostFX } from './postfx.js';
import { createAtmosphere } from './atmosphere.js';
import {
  RT, terrainHeight, TINT_CLOUD, TINT_BG,
  buildSky, buildRidgeBand, buildTerrain, buildFarClouds
} from './scene.js';
import {
  resolveAvoid, bedHalfLocal, bedScaleTriple, bedSurfaceHeight,
  buildGrass, buildTufts, buildLavender, buildBed, loadBedModel,
  buildDaisies, buildBedShadow, buildLadder, buildButterflies, buildFireflies,
  buildGlints, snapGlintsToBed, buildCloud, buildProjectorScreen,
  shadeCloud, cloudShadeStats,
  setupCloudPoke, updateCloudFlow, updateCloudFade
} from './model.js';

/* ============================================================
   主入口：配置 → 组装 → 交互 → 渲染循环
   ------------------------------------------------------------
   scene.js 造世界，model.js 造物件，这里负责：
     · 读 scene.json / config.json 并合并覆盖（applyConfig）
     · 建渲染器、相机、控制器、音频、后处理、时相，并把所有物件摆好（build）
     · 三种相机模式的操控（setupModes）与屏幕上的时相/滤镜/雾档面板（createSceneUI）
     · 每帧推进：动画 → 云的流场/淡出 → 戳云 → 相机模式 → 后处理
   ============================================================ */

/* ============================================================
   0a. 画质档位（手机 / 平板自动降档）
   ------------------------------------------------------------
   这套场景的绘制开销主要在「数量」上：体积云是 360 个 Sprite，
   每个还配一块投影 Plane ⇒ 光云就 720 次 draw call，再加 3.5 万株
   实例化植被和 2048² 的阴影贴图。桌面独显无所谓，手机必卡。
   触屏 + 窄屏 ⇒ 按 scene.json 的 renderer.mobile 打折；
   URL 加 ?mobile=1 可强制走移动档（方便在无头浏览器里验证）。
   ============================================================ */
const _QS = new URLSearchParams(location.search);

const _FORCE_MOBILE = _QS.get('mobile') === '1' || _QS.get('mobile') === 'true';

const IS_TOUCH = ((navigator.maxTouchPoints || 0) > 1) || _FORCE_MOBILE;

const IS_SMALL = Math.min(innerWidth, innerHeight) <= 900;

const AUTO_MOBILE = IS_TOUCH && IS_SMALL;

let PR_CAP   = 2;      // 像素比上限

let SHADOW_SZ = null;  // 阴影贴图边长（null = 用 JSON 里的值）

let CFG_EFF   = {};    // config.json 的生效值快照（applyConfig 返回；无 config.json 时为空对象）

/* 进来看电视那会儿 BGM 在不在放 —— 复位 / 退出时照原样接回来。
   ★ 必须**模块级**：setupModes 和 createSceneUI 是同一个模块里的并列顶层函数，
   谁都看不见对方的 let。早先放在 setupModes 里，createSceneUI 那句赋值就成了
   ReferenceError，被 try/catch 吞掉，AUD.pause() 连跑都没跑（2026-10-06 实测）。 */
let bgmBefore = false;

/* ============================================================
   2b. 可行走面查询：地形 / 床垫顶面
   ------------------------------------------------------------
   support.at(x, z, footY) 返回脚下最高的「够得着」的面。
   「比我高太多」的面不参与吸附 —— 否则会凭空瞬移到床上。
   ★ 梯档刻意不在这里：它只能由 ladder 状态到达（见 tryClimb），
     否则「第一级横档」会同时是「可以迈上去的台阶」和「要爬的东西」，
     两者打架会把角色卡在第一级上。
   ============================================================ */
function makeSupport(rig, W){
  const stepUp  = (W.stepUp  !== undefined) ? W.stepUp  : 0.62;   // 可直接迈上去的高度
  const climbUp = (W.climbUp !== undefined) ? W.climbUp : 0.95;   // 「够得着」的判定上限
  const grab    = (W.ladderGrab !== undefined) ? W.ladderGrab : 1.15;
  const LD = rig.ladder;

  /* 投影到梯轴：s = 沿轴弧长，d = 到轴的垂距 */
  function project(x, y, z){
    const px = x - LD.foot[0], py = y - LD.foot[1], pz = z - LD.foot[2];
    const s  = px*LD.up[0] + py*LD.up[1] + pz*LD.up[2];
    const qx = LD.foot[0] + LD.up[0]*s, qy = LD.foot[1] + LD.up[1]*s, qz = LD.foot[2] + LD.up[2]*s;
    return { s, d: Math.hypot(x - qx, y - qy, z - qz), q:[qx, qy, qz] };
  }
  function at(x, z, footY){
    let y = terrainHeight(x, z), kind = 'ground';
    const B = rig.bed;
    if(Math.abs(x - B.x) <= B.rx && Math.abs(z - B.z) <= B.rz &&
       B.top <= footY + Math.max(stepUp, climbUp) && B.top > y){ y = B.top; kind = 'bed'; }
    return { y, kind };
  }
  return { stepUp, climbUp, grab, project, at };
}

/* ============================================================
   2b-2. 相机焦点：数组 or 具名锚点
   ------------------------------------------------------------
   焦点的含义是「画面正中被谁占住」。默认要让梯子中点落在正中，
   于是不管梯子多长、倾角多少、床被抬到多高，进来第一眼都正对梯子。
   但梯子中点是个**算出来的**位置：它同时取决于 length / rotation /
   床高（bottom[1]=null 时梯脚吸附到床面），手抄一个 [x,y,z] 进 JSON，
   改一次梯长或床高就变成对着空气看。
   所以这里支持写锚点名，等 rig 建好再解析。
     ladderFoot / ladderMid / ladderTop —— 梯脚 / 中点 / 顶端（沿梯轴）
     bed                              —— 床面正中
     cloud                            —— 云心
   数组形式仍完全照旧（直接的世界坐标），不写锚点的老配置不受影响。
   ============================================================ */
function resolveViewTarget(t, rig, cfg){
  if(Array.isArray(t)) return [t[0], t[1], t[2]];
  const k = rig && rig.ladder;
  if(k){
    const along = h => [k.foot[0] + k.up[0]*h, k.foot[1] + k.up[1]*h, k.foot[2] + k.up[2]*h];
    if(t === 'ladderMid')  return along(k.length*0.5);
    if(t === 'ladderFoot') return along(0);
    if(t === 'ladderTop')  return along(k.length);
  }
  const B = rig && rig.bed;
  if(B && t === 'bed') return [B.x, B.top, B.z];
  if(t === 'cloud' && cfg && cfg.cloud && Array.isArray(cfg.cloud.center)) return cfg.cloud.center.slice();
  return null;                       // 解析不了（rig 还没建好，或名字写错）⇒ 调用方保持原值
}

/* ============================================================
   2c. 相机模式：自由（OrbitControls）/ 漫游（脚本巡演）/ 步行（第一人称）
   ------------------------------------------------------------
   三种模式共用同一个「角色 rig」P：P.x / P.z 是脚的水平位置，
   P.foot 是脚底高度，相机 = foot + eyeHeight。
     · 支撑面 = 地形 ∪ 床垫顶面 ∪ 梯子横档（makeSupport）
     · 状态机 ground → air（重力/跳跃）→ ladder（沿梯逐级）→ bed（翻上床）
     · 漫游：按 scene.json 的 route 自动演出「走到床 → 上床 → 爬梯 → 云端跳下」
     · 步行：左半屏摇杆移动、右半屏摇杆转视角，右下角按钮或空格跳跃
   ============================================================ */
function setupModes(cfg, camera, controls, renderer, rig, AUD, ladder, tvHooks){
  const WALK = cfg.walk || {}, ROAM = cfg.roam || {};
  /* 音效出口。传不进来（老调用点、无头脚本）时给个空壳 —— 漫游落地那声「噗」
     是演出的一部分，不该因为它把整段动画带崩。 */
  const SFX = AUD || { poof(){} };
  const S = makeSupport(rig, WALK);
  /* 只有带 data-mode 的才算模式开关。复位按钮同样是 .mode-btn（共用那套胶囊外观），
     但它是个**动作**、没有 data-mode —— 不过滤掉的话，点它会走
     setMode(undefined)：三个模式的 active 全灭、controls.enabled 变 false，
     整个镜头直接锁死，而画面看起来只是「点了没反应」。 */
  const btns   = Array.prototype.slice.call(document.querySelectorAll('.mode-btn'))
                      .filter(b => b.dataset.mode);
  /* 三种玩法怎么操作，写在按钮的 title 里（悬停可见）。
     底部那条常驻说明文字已经去掉，用 title 兜住「查得到」这一步，不占画面。 */
  const MODE_TIP = {
    free: '自由：拖拽旋转 · 滚轮缩放 · 右键平移 · 点击云朵戳一下',
    roam: '漫游：自动巡游 —— 原地转向梯子 → 飞过去 → 沿梯爬升 → 停在顶端（点右下「跳」就往下一跃落到床上，然后重新开始）',
    walk: '步行：左半屏拖动走动 · 右半屏拖动转视角 · 走到床/梯子自动攀爬 · 跳跃＝右下按钮或空格 · 碰到云会漾开'
  };
  btns.forEach(b => { const t = MODE_TIP[b.dataset.mode]; if(t && !b.title) b.title = t; });
  const hint   = document.getElementById('mode-hint');
  const layer  = document.getElementById('sticks');
  const jumpBt = document.getElementById('jump-btn');

  const eye        = WALK.eyeHeight || 1.7;
  const speed      = WALK.speed     || 4.0;
  const lookSpeed  = WALK.lookSpeed || 1.7;
  const gravity    = WALK.gravity   || 18;
  const jumpV      = WALK.jumpSpeed || 6.2;
  const climbSpeed = WALK.climbSpeed|| 2.3;
  /* 「爬上床面」那一段单独一个速度：它和爬梯子共用过 climbSpeed，
     但梯子减速 50% 之后上床也一起变慢，看着像卡在半空浮上去。
     默认沿用 climbSpeed（不写 mountSpeed 时行为与从前一致）。 */
  const mountSpeed = (WALK.mountSpeed !== undefined) ? WALK.mountSpeed : climbSpeed;
  const landDip    = (WALK.landDip !== undefined) ? WALK.landDip : 0.3;
  const followK    = WALK.ySmooth   || 11;
  const LD = rig.ladder;

  /* 角色状态 */
  const P = { x:0, z:0, foot:0, yaw:0, pitch:0, vy:0,
              state:'ground', ls:0, lsq:0, landT:0 };
  /* orbitAim = 「切回自由模式时，环绕中心放在哪」。
     它的生命周期有点绕，所以单独说明：
       · 初值 = controls.target（也就是 scene.json 里那个焦点锚点，默认梯子中点）；
       · 自由模式里每帧跟着用户拖出来的 controls.target 走（用户转到哪就继续放哪）；
       · 漫游/步行里被 applyCamera 改成「当前视线上前方 12m 那个点」——
         这样从第一人称切回自由，镜头不会跳，只是把环绕中心挪到眼前。
     换句话说：配置里的焦点决定**首屏**与自由模式下的取景中心，
     而「从漫游/步行切回来」采用的是你当时的视线方向，不是硬拉回梯子中点。 */
  const orbitAim = new THREE.Vector3().copy(controls.target);
  const tmp = new THREE.Vector3();
  const aimT = new THREE.Vector3();
  let jumpReq = false;

  /* ---------- 虚拟摇杆 ---------- */
  const SR = WALK.stickRadius || 62;
  function makeStick(label){
    const el = document.createElement('div'); el.className = 'stick';
    const knob = document.createElement('div'); knob.className = 'stick-knob';
    const lab = document.createElement('div'); lab.className = 'stick-label';
    lab.textContent = label;
    el.appendChild(knob); el.appendChild(lab); layer.appendChild(el);
    el.style.width = el.style.height = (SR*2) + 'px';
    return { el, knob, id:null, cx:0, cy:0, x:0, y:0 };
  }
  const sMove = makeStick('移动'), sLook = makeStick('视角');
  function stickStart(s, id, x, y){
    s.id = id; s.cx = x; s.cy = y; s.x = 0; s.y = 0;
    s.el.style.left = (x - SR) + 'px';
    s.el.style.top  = (y - SR) + 'px';
    s.el.classList.add('on');
    s.knob.style.transform = 'translate(0px, 0px)';
  }
  function stickDrag(s, x, y){
    let dx = x - s.cx, dy = y - s.cy;
    const d = Math.hypot(dx, dy);
    if(d > SR){ dx = dx/d*SR; dy = dy/d*SR; }
    s.x = dx/SR; s.y = dy/SR;
    s.knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
  }
  function stickEnd(s){ if(s.id === null) return; s.id = null; s.x = 0; s.y = 0; s.el.classList.remove('on'); }
  function stickById(id){ return sMove.id === id ? sMove : (sLook.id === id ? sLook : null); }
  function hideSticks(){ stickEnd(sMove); stickEnd(sLook); }

  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', e=>{
    if(mode !== 'walk' && !(fp.on)) return;     // 看电视时同样挂双摇杆：左走 / 右转头
    /* ⚠ 第一人称下只让**左半屏**当移动摇杆：右半屏是转头的那一路拖拽。
       两边都挂摇杆的话，右半屏按下时会被「摇杆已占用」挡掉，转头就没反应了。 */
    if(fp.on && e.clientX >= innerWidth*0.5) return;
    const s = (e.clientX < innerWidth*0.5) ? sMove : sLook;
    if(s.id !== null) return;
    stickStart(s, e.pointerId, e.clientX, e.clientY);
    try{ dom.setPointerCapture(e.pointerId); }catch(_){}
    e.preventDefault();
  });
  dom.addEventListener('pointermove', e=>{
    const s = stickById(e.pointerId);
    if(s) stickDrag(s, e.clientX, e.clientY);
  });
  ['pointerup','pointercancel'].forEach(t => dom.addEventListener(t, e=>{
    const s = stickById(e.pointerId); if(s) stickEnd(s);
  }));
  addEventListener('blur', hideSticks);

  /* ---------- 键盘 ---------- */
  const keys = Object.create(null);
  addEventListener('keydown', e=>{
    if(e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    keys[e.code] = true;
    if(e.code === 'Space' && (mode === 'walk' || mode === 'roam')){ jumpReq = true; e.preventDefault(); }
  });
  addEventListener('keyup', e=>{ keys[e.code] = false; });
  jumpBt.addEventListener('click', e=>{ e.preventDefault(); jumpReq = true; });

  /* ---------- 攀爬判定：走到位自动上床 / 挂梯子 ---------- */
  function tryClimb(wx, wz){
    if(P.state !== 'ground') return false;
    const B = rig.bed;
    /* 梯子：朝梯子 Ammo 方向推进，且下一级够得着 */
    const info = S.project(P.x, P.foot, P.z);
    if(info.d < S.grab && info.s < LD.length - 0.15){
      const hl = Math.hypot(LD.up[0], LD.up[2]) || 1;
      const toward = (wx*LD.up[0] + wz*LD.up[2])/hl;
      const nextS  = (Math.floor(Math.max(info.s, 0)/LD.step) + 1)*LD.step;
      const nextY  = LD.foot[1] + nextS*LD.up[1];
      if(toward > 0.4 && nextY - P.foot <= LD.step*LD.up[1] + 0.45){
        P.state = 'ladder'; P.ls = nextS; P.lsq = Math.max(info.s, 0); P.vy = 0;
        return true;
      }
    }
    /* 床：贴着床沿且朝床走 */
    const ex = Math.max(Math.abs(P.x - B.x) - B.rx, 0);
    const ez = Math.max(Math.abs(P.z - B.z) - B.rz, 0);
    if(Math.hypot(ex, ez) < 0.8 && B.top > P.foot + 0.05 && B.top - P.foot < 2.4){
      const tx = B.x - P.x, tz = B.z - P.z, tl = Math.hypot(tx, tz) || 1;
      if((wx*tx + wz*tz)/tl > 0.4){ P.state = 'bed'; P.vy = 0; return true; }
    }
    return false;
  }

  /* ---------- 角色推进 ---------- */
  function movePlayer(dt, wx, wz, jump, climbDir, dropLadder){
    if(P.state === 'ladder'){
      /* 沿梯轴推进，量化到最近横档后平滑追随 ⇒ 一级一级、每级略作停留 */
      P.ls = THREE.MathUtils.clamp(P.ls + (climbDir || 0)*climbSpeed*dt, 0, LD.length);
      const rr = Math.round(P.ls/LD.step)*LD.step;
      P.lsq  += (rr - P.lsq)*(1 - Math.exp(-15*dt));
      P.x     = LD.foot[0] + LD.up[0]*P.lsq + LD.off[0];
      P.z     = LD.foot[2] + LD.up[2]*P.lsq + LD.off[1];
      P.foot  = LD.foot[1] + LD.up[1]*P.lsq;
      P.vy    = 0;
      if(jump){ P.state = 'air'; P.vy = jumpV; P.lastJump = performance.now();
                P.x += LD.off[0]*2.4; P.z += LD.off[1]*2.4; }
      else if(dropLadder || (P.ls <= 0.02 && (climbDir || 0) < 0)){ P.state = 'air'; P.vy = 0; }
      return;
    }
    if(P.state === 'bed'){
      P.foot = Math.min(P.foot + mountSpeed*dt, rig.bed.top);
      P.x += wx*speed*0.3*dt; P.z += wz*speed*0.3*dt;
      if(P.foot >= rig.bed.top - 0.004){ P.foot = rig.bed.top; P.state = 'ground'; }
      if(jump){ P.state = 'air'; P.vy = jumpV; P.lastJump = performance.now(); }
      return;
    }

    /* 水平移动：逐轴试探，高差超过 stepUp 的面挡住（否则会直接走上床） */
    const prev = P.foot;
    const mag  = Math.hypot(wx, wz);
    if(mag > 1e-3){
      const inv = Math.min(mag, 1)/mag;
      const dx = wx*inv*speed*dt, dz = wz*inv*speed*dt;
      if(P.state === 'ground'){
        const s1 = S.at(P.x + dx, P.z, P.foot);
        if(s1.y - P.foot <= S.stepUp + 0.02) P.x += dx;
        const s2 = S.at(P.x, P.z + dz, P.foot);
        if(s2.y - P.foot <= S.stepUp + 0.02) P.z += dz;
      }else{
        P.x += dx*0.7; P.z += dz*0.7;                 // 空中有惯性感，但控制权仍在手上
      }
    }

    if(P.state === 'ground'){
      const sup = S.at(P.x, P.z, P.foot);
      if(sup.y < P.foot - 0.08){                      // 走出边缘 → 开始下落
        P.state = 'air'; P.vy = 0;
      }else{
        P.foot += (sup.y - P.foot)*(1 - Math.exp(-followK*dt));
      }
      if(jump){ P.state = 'air'; P.vy = jumpV; P.lastJump = performance.now(); }
    }
    if(P.state === 'air'){
      P.vy  -= gravity*dt;
      const sup = S.at(P.x, P.z, prev);
      P.foot += P.vy*dt;
      if(P.vy <= 0 && P.foot <= sup.y && prev >= sup.y - 0.02){
        P.foot = sup.y; P.vy = 0; P.state = 'ground';
        if(prev - sup.y > 0.6) P.landT = 0.3;         // 落地微蹲
      }
    }
  }

  /* ---------- 视线（漫游：平滑看向目标点） ---------- */
  function aimCamera(dt, target){
    const eyeY = P.foot + eye;
    const dx = target.x - P.x, dy = target.y - eyeY, dz = target.z - P.z;
    let d = Math.atan2(-dx, -dz) - P.yaw;
    while(d >  Math.PI) d -= Math.PI*2;
    while(d < -Math.PI) d += Math.PI*2;
    const k = 1 - Math.exp(-(ROAM.lookAim || 2.4)*dt);
    P.yaw   += d*k;
    P.pitch += (Math.atan2(dy, Math.hypot(dx, dz)) - P.pitch)*k;
    P.pitch  = THREE.MathUtils.clamp(P.pitch, -0.95, 0.72);
  }
  function applyCamera(dt){
    if(P.landT > 0) P.landT -= dt;
    let y = P.foot + eye;
    if(P.landT > 0) y -= landDip*Math.sin(Math.max(P.landT, 0)/0.3*Math.PI);
    camera.rotation.set(P.pitch, P.yaw, 0);
    camera.position.set(P.x, y, P.z);
    const cp = Math.cos(P.pitch);
    tmp.set(-Math.sin(P.yaw)*cp, Math.sin(P.pitch), -Math.cos(P.yaw)*cp);
    orbitAim.copy(camera.position).add(tmp.multiplyScalar(12));
  }

  /* ---------- 视场角：可以按「站」拉宽（爬梯那一段 +8°） ----------
     为什么要平滑而不是直接赋值：FOV 是**突变就露馅**的量 —— 一帧内从 56°跳到 64°，
     画面边缘会像被拽了一把。这里用指数逼近（每秒走完 (1-e^-rate)），
     进站约 0.4 秒铺开、出站同样慢慢收回来，正好盖住「迈上第一级」那一下。
     目标值 = 原值 + 本步的 fovBoost（写在 scene.json 的 route 里，一步一份）。
     非漫游模式、以及没写 fovBoost 的步骤一律回原值 —— 所以步行 / 自由模式下
     这个函数每帧都是「已经到位、什么都不做」。 */
  const FOV0    = camera.fov;          // 原视场角（scene.json camera.fov）
  const FOV_RATE = 2.6;                // 逼近似率（1/s）。2.6 ⇒ 时间常数 0.38 秒
  /* 看电视时的「视角增量」。走 fovStep 的 boost 通道（下方自由/步行分支传
     tvState ? TV_FOV_BOOST : 0），自带 FOV_RATE 指数缓动，不是落地瞬间硬切。
     轨迹：+15°（2026-10-05 用户上调）→ +30°（同日又嫌不够广）→ 又嫌太大，
     2026-10-05 晚再减 8° ⇒ +22°；2026-10-06 上午「减少 10°」⇒ +12°；
     2026-10-06 下午改成给**绝对值**：「fov 调为 65 度」⇒ 65 − 56 = **+9**。
     ⚠ 这里存的是**增量**不是绝对值，改的时候记得减去 camera.fov（scene.json 里是 56）。
     想改：scene.json / config.json 写 projector.tvFovBoost（当前没写，用这个默认值）。 */
  const TV_FOV_BOOST = +((cfg.projector && cfg.projector.tvFovBoost !== undefined)
                        ? cfg.projector.tvFovBoost : 9);
  let   fovNow  = FOV0;                // 当前写到相机上的值（自己记着，不读回 camera.fov）
  function fovStep(dt, boost){
    const want = FOV0 + (boost || 0);
    if(Math.abs(fovNow - want) < 1e-3) return;
    fovNow += (want - fovNow)*(1 - Math.exp(-FOV_RATE*dt));
    if(Math.abs(want - fovNow) < 0.02) fovNow = want;   // 收尾：浮点尾巴别一直留着
    camera.fov = fovNow;
    camera.updateProjectionMatrix();
  }
  /* 复位用：瞬时回原值。复位是「一笔还原」，让它慢慢飘回去反而像没复位干净 */
  function fovReset(){
    if(fovNow === FOV0) return;
    fovNow = FOV0;
    camera.fov = FOV0;
    camera.updateProjectionMatrix();
  }
  /* 声音的左右：按落点相对「相机右方向」的分量给声像。
     范围压到 ±0.5 —— 落点本来就该在画面正前方，只给一点点偏向即可，
     给满 ±1 会像有人从侧面拍下来。 */
  const panV = new THREE.Vector3();
  function panOf(x, z){
    camera.updateMatrixWorld();
    panV.set(1, 0, 0).applyQuaternion(camera.quaternion);       // 相机的 +X = 画面右
    const dx = x - camera.position.x, dz = z - camera.position.z;
    const d  = Math.hypot(dx, dz) || 1;
    return THREE.MathUtils.clamp((dx*panV.x + dz*panV.z)/d, -1, 1) * 0.5;
  }

  /* ---------- 漫游：按 route 演一段自动巡游 ---------- */
  const route = ROAM.route || null;
  const run = { i:0, t:0 };
  const flyT = new THREE.Vector3();          // 飞行目标（不能和 aimT 共用，会互相覆盖）
  function resolveLook(v){
    if(!v) return null;
    if(v === 'cloud'){ const c = cfg.cloud.center; return aimT.set(c[0], c[1], c[2]); }
    if(v === 'bed')  return aimT.set(rig.bed.x, rig.bed.top + 0.4, rig.bed.z);
    if(v === 'ladder'){
      const k = rig.ladder, h = k.length*0.55;
      return aimT.set(k.foot[0] + k.up[0]*h, k.foot[1] + k.up[1]*h, k.foot[2] + k.up[2]*h);
    }
    if(v === 'ladderTop'){                    // 梯顶再往上一点：爬升全程都是抬头看
      const k = rig.ladder, h = k.length + ((k.length*0.2) || 2);
      return aimT.set(k.foot[0] + k.up[0]*h, k.foot[1] + k.up[1]*h, k.foot[2] + k.up[2]*h);
    }
    if(Array.isArray(v)) return aimT.set(v[0], v[1], v[2]);
    return null;
  }
  /* 飞行目标：'ladder' = 梯轴上「开始攀爬」的那个点（梯脚 + 侧向让位，
     和挂上梯子后第一帧的位置完全一致，所以飞到位下一帧必定抓得住）。
     也可以直接写世界坐标 [x, y, z]。 */
  function resolveFly(v){
    if(v === 'ladder')
      return flyT.set(LD.foot[0] + LD.off[0], LD.foot[1], LD.foot[2] + LD.off[1]);
    if(Array.isArray(v)) return flyT.set(v[0], v[1], v[2]);
    return null;
  }
  const flyDist = (st)=>{
    const t = resolveFly(st.fly);
    if(!t) return Infinity;
    return Math.hypot(t.x - P.x, t.z - P.z, (t.y - P.foot)*0.75);
  };
  /* 飞：先在原地「慢慢转过头」（look 目标生效），再按指数逼近飞过去。
     全程自己写位置、不调 movePlayer —— 走那条路会被重力和台阶判定按回地面，
     就不叫飞了。竖直方向按 0.75 加权，镜头不会像电梯那样直上直下。 */
  function flyStep(dt, st){
    const t = resolveFly(st.fly);
    if(!t) return;
    const dx = t.x - P.x, dz = t.z - P.z, dy = t.y - P.foot;
    const d  = Math.hypot(dx, dz, dy*0.75);
    if(d < 0.22){                                      // 到点：精确贴合，好让下面 tryClimb 抓得住
      P.x = t.x; P.z = t.z; P.foot = t.y;
      P.vy = 0; P.state = 'ground';
      return;
    }
    if(run.t <= ((st.turn !== undefined) ? st.turn : 1.3)) return;   // 先转头，别一边冲一边扭
    const vmax = (st.speed !== undefined) ? st.speed : 12;
    const v    = Math.min(vmax, Math.max(0.5, d*0.62));             // 距离越近越慢 ⇒ 收得平滑
    const k    = Math.min(1, v*dt/d);
    P.x += dx*k; P.z += dz*k; P.foot += dy*k;
    P.vy = 0; P.state = 'ground';
  }

  /* ---------- 落点 / 翻身跳下（leap） ----------
     从梯顶「翻下来落到床上」这一步，用一条**真正的抛物线**，不是瞬移、
     也不是匀速插值：起跳给一个明确的上抛初速 rise，然后由重力接管，
     所以它会先窜一下再落下去 —— 眼睛一看就知道这是「跳」，不是「飘」。
     落点 = 锚点 + leapOff 偏移（世界坐标，[dx, dz]）。
       为什么要能偏移：默认锚点 'bed' 是床面正中，而梯脚正是从床心长出来的，
       人正好落在梯子两轨之间。往床里侧让开半米，落点干净、也看得出「翻到床上」。
     落地后写 landT ⇒ applyCamera 会吃掉这个值做出「落地微蹲」，和步行模式同一套。 */
  const leapS = { on:false, landed:false, t:0, T:1, x0:0, y0:0, z0:0, tx:0, ty:0, tz:0, vy0:0 };
  function resolveLanding(v, off){
    let p = null;
    if(v === 'bed'){
      const B = rig.bed;
      p = [B.x, B.top, B.z];
    }else if(v === 'ladderFoot'){
      p = [LD.foot[0] + LD.off[0], LD.foot[1], LD.foot[2] + LD.off[1]];
    }else if(Array.isArray(v)) p = [v[0], v[1], v[2]];
    if(!p) return null;
    if(Array.isArray(off)){ p[0] += off[0] || 0; p[2] += (off[1] || 0); }
    return p;
  }
  function startLeap(st){
    const p = resolveLanding(st.leap, st.leapOff);
    if(!p) return false;
    leapS.x0 = P.x; leapS.y0 = P.foot; leapS.z0 = P.z;
    leapS.tx = p[0]; leapS.ty = p[1]; leapS.tz = p[2];
    leapS.vy0 = (st.rise !== undefined) ? st.rise : 4.5;
    /* 飞行时长：由「初速 + 重力」解出 y(t) = ty 的正根。
       下限 0.05 防「落点比起点还高」时 sqrt 里出负数（那样该用 fly，不是 leap）。 */
    const dh = Math.max(leapS.y0 - leapS.ty, 0.05);
    leapS.T  = (leapS.vy0 + Math.sqrt(leapS.vy0*leapS.vy0 + 2*gravity*dh))/gravity;
    leapS.t  = 0; leapS.on = true; leapS.landed = false;
    P.state  = 'air'; P.vy = leapS.vy0;
    jumpReq  = false;                       // 这一跳把请求用掉了，别让它溢到下一步
    return true;
  }
  function leapStep(dt, st){
    if(!leapS.on){ if(!startLeap(st)) return; }
    leapS.t = Math.min(leapS.T, leapS.t + dt);
    if(leapS.t > leapS.T - 1e-6) leapS.t = leapS.T;      // 浮点收尾，见 README 的雾渐变同款坑
    const u = leapS.t / leapS.T;
    P.x    = leapS.x0 + (leapS.tx - leapS.x0)*u;          // 水平匀速
    P.z    = leapS.z0 + (leapS.tz - leapS.z0)*u;
    P.foot = leapS.y0 + leapS.vy0*leapS.t - 0.5*gravity*leapS.t*leapS.t;   // 竖直抛物
    P.vy   = leapS.vy0 - gravity*leapS.t;
    if(leapS.t >= leapS.T){
      P.x = leapS.tx; P.z = leapS.tz; P.foot = leapS.ty;
      /* 「噗」——身体砸进被子那一下，就在落地这一帧。
         强度跟着**落地冲击速度**走：抛物线末端本来就最快，所以这一声天然是「砸」
         而不是「放」；把下限压在 0.45 是为了「轻轻放上去」那种情况也别没声。
         落地微蹲（landT）也写在这里，两者同一帧 —— 看到的是同一下。 */
      const hit = Math.abs(leapS.vy0 - gravity*leapS.T);
      SFX.poof({ strength: THREE.MathUtils.clamp(hit/9, 0.45, 1), pan: panOf(leapS.tx, leapS.tz) });
      P.vy = 0; P.state = 'ground';
      P.landT = 0.3;
      leapS.on = false; leapS.landed = true;
    }
  }
  /* 漫游提示条：只在「有话说」时出现。
     常驻的操作说明（自由模式那句「点击云朵可以戳一下 · 拖动旋转 · 滚轮缩放」、
     步行模式那一长串走法）已经**去掉** —— 底部这条留给按钮，画面干净、
     也不和左下角的面板抢地方。仍然保留的两种：
       · 一次性反馈（切时相/滤镜/雾档、戳云）→ flashHint，一两秒后自己退场
       · 漫游台词（route 里的 hint）→ 走到那一步才出现
     所以 baseHint() 一律返回空串，空串 = 不显示，不是「显示一个空胶囊」。 */
  function baseHint(){ return ''; }
  function refreshHint(){
    hint.textContent = baseHint();
    hint.classList.remove('hold');
    hint.style.opacity = hint.textContent ? 1 : 0;
  }
  function stepHint(st){
    if(st && st.hint){
      hint.textContent = st.hint;
      hint.classList.add('hold');
      hint.style.opacity = 1;
    }else refreshHint();
  }
  /* 一次性提示（碰云时用）：闪一下再自己退回去。
     漫游模式有自己的台词，不去抢它。 */
  let flashTimer = 0;
  function flashHint(text, ms){
    if(mode === 'roam') return;
    hint.textContent = text;
    hint.classList.add('hold');
    hint.style.opacity = 1;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if(mode !== 'roam') refreshHint(); }, ms || 1600);
  }
  window.__hintFlash = flashHint;
  function routeDone(st){
    if(st.fly)              return flyDist(st) < 0.24;
    /* 停住：hold 这一步本来永远不完成（它就该一直停着）。
       onJump = true 是例外 —— 它表示「停在这里等人按跳」，
       按了才放行到下一步（梯顶 → 翻下身落到床上就是这么接起来的）。 */
    if(st.hold)             return st.onJump ? jumpReq : false;
    if(st.leap)             return leapS.landed;
    if(st.go)               return (P.state === 'ladder' || P.state === 'bed') ||
                                   Math.hypot(st.go[0] - P.x, st.go[1] - P.z) < (st.tol || 0.6);
    if(st.climbBed)         return P.foot >= rig.bed.top - 0.03;
    if(st.climbLadder !== undefined)                   // 0.22 级：停得离顶端更近（默认阈值会差半级）
                            return P.state === 'ladder' && P.ls >= st.climbLadder*LD.length - LD.step*0.22;
    if(st.wait !== undefined) return run.t >= st.wait;
    return true;                                       // jump 等瞬时动作立即完成
  }
  function routeTick(dt){
    const st = route[run.i % route.length];
    run.t += dt;
    let wx = 0, wz = 0, jump = false, climbDir = 0;
    const tgt = resolveLook(st.look);

    if(st.go){
      const dx = st.go[0] - P.x, dz = st.go[1] - P.z, d = Math.hypot(dx, dz) || 1;
      wx = dx/d; wz = dz/d;
      if(st.run){ wx *= st.run; wz *= st.run; }
      tryClimb(wx, wz);                                // 走到床沿/梯脚会自动攀附
    }else if(st.climbBed){
      const tx = rig.bed.x - P.x, tz = rig.bed.z - P.z, tl = Math.hypot(tx, tz) || 1;
      wx = tx/tl; wz = tz/tl;
      tryClimb(wx, wz);
    }else if(st.climbLadder !== undefined){
      climbDir = 1;
      if(P.state !== 'ladder'){
        /* 直接朝「梯子向上的水平方向」走 —— 若改成朝某个具体点走，
           站到点上之后方向会退化，toward 判定失效、永远挂不上梯子 */
        const hl = Math.hypot(LD.up[0], LD.up[2]) || 1;
        wx = LD.up[0]/hl; wz = LD.up[2]/hl;
        tryClimb(wx, wz);
      }
    }else if(st.jump){
      jump = true;
    }else if(st.leap){
      /* 进来就把跳跃请求吃掉：这一步的触发条件就是「上一拍的按跳」，
         不吃掉的话，飞行途中再点一下会一路活到下一轮的 hold，
         于是「每次到顶都自动翻下去」——看起来像有人一直按着跳。 */
      jumpReq = false;
      leapStep(dt, st);                                // 自己写位置（抛物线），下面不再走 movePlayer
    }else if(st.fly){
      flyStep(dt, st);                                 // 自己写位置，下面不再走 movePlayer
    }

    if(!st.fly && !st.leap) movePlayer(dt, wx, wz, jump, climbDir, false);

    const eyeY = P.foot + eye;
    if(tgt) aimCamera(dt, tgt);
    else if(Math.hypot(wx, wz) > 0.01) aimCamera(dt, aimT.set(P.x + wx*16, eyeY - 1.0, P.z + wz*16));

    /* 超时保护：hold 步骤不吃这套（它就该一直停着） */
    const mx = (st.max !== undefined) ? st.max : (st.hold ? Infinity : 18);
    if(routeDone(st) || run.t > mx){
      const ended = run.i >= route.length - 1;         // 刚走完的是最后一站
      run.i = (run.i + 1) % route.length; run.t = 0;
      stepHint(route[run.i]);
      /* 整段演出走完（跳下床、最后那句台词也停够了）⇒ 把操作权交回玩家：
         自动切到步行模式 —— 人就站在床上，可以直接走两步。
         为什么挂在**最后一站结束时**、而不是 leap 落地那一帧：后面还有一段 wait
         的停顿和「落在床上了」这句台词，落地就切会把这句吞掉、也让人来不及看清
         自己是怎么落下来的。
         setMode 在这里调用是安全的：它是函数声明（提升可见），内部只动模式与相机，
         不碰 routeTick 正在用的 wx/wz。切完立刻 return，免得本帧继续用漫游那套输入
         去 drive 一个已经不属于这个模式的角色（也就是「切了模式还自己走了一步」）。 */
      if(ended && ROAM.autoWalk !== false){
        setMode('walk');
        return;
      }
    }
    /* 「跳」只在 onJump（等人按）与 leap（把请求吃掉）这两步有意义，
       其余步骤一律丢弃 —— 否则爬梯途中手贱点一下，会在爬到顶的那一帧直接翻下去。 */
    if(!st.onJump && !st.leap) jumpReq = false;
  }

  /* ---------- 模式切换 ---------- */
  let mode = 'free';
  function syncFromCamera(){
    P.x = camera.position.x; P.z = camera.position.z;
    P.foot = camera.position.y - eye;
    camera.getWorldDirection(tmp);
    P.yaw   = Math.atan2(-tmp.x, -tmp.z);
    P.pitch = Math.asin(THREE.MathUtils.clamp(tmp.y, -1, 1));
    P.vy = 0; P.state = 'ground'; P.ls = 0; P.lsq = 0; P.landT = 0;
  }
  function setMode(m){
    if(m === mode && m !== 'free'){ setMode('free'); return; }   // 再点一次 = 退出
    mode = m;
    btns.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    controls.enabled = (m === 'free');
    jumpBt.classList.toggle('on', m === 'walk' || m === 'roam');
    if(m === 'free'){
      hideSticks();
      controls.target.copy(orbitAim);
      controls.update();
    }else{
      syncFromCamera();
      if(m === 'roam'){ run.i = 0; run.t = 0; }
    }
    refreshHint();
    /* 第一站就带提示的话（一般是最后那句「爬到顶了」）要立刻显示 */
    if(m === 'roam' && route) stepHint(route[0]);
  }
  /* ---------- 复位 ----------
     「打开页面时的那个位姿」在这里存下来：setupModes 被调用时，相机位置还是
     scene.json 的 camera.position，controls.target 也已经被 build() 解析成
     焦点锚点（梯子中点）了 —— 正是首屏看到的那一帧。之后无论漫游把镜头带到
     哪、用户旋到多远，复位都能一笔还原。
     ⚠ 存的是**当时**的 controls.target，不是 orbitAim：后者在自由模式里
     每帧被用户拖出来的中心改写，拿它当复位点等于「复位到你现在看的地方」。 */
  const HOME = { pos: camera.position.clone(), target: controls.target.clone() };

  /* ---------- 夜间「看电视」位姿 ----------
     点击「看电视」后，镜头缓缓飞到床上、面向床前投影幕布，模拟靠在床上观影；
     同时把梯子隐藏，避免挡画面。点击「复位」再飞回原位并把梯子显示回来。 */
  const bedTop = bedSurfaceHeight(cfg.bed);
  const screenPos = (cfg.projector && cfg.projector.screen && cfg.projector.screen.position) || [-2, 3.95, -3.6];
  /* 「靠在床上看」的机位必须锚在**床**上，不能锚在幕布上 ——
     幕布现在挪到床尾外 2 米（且旋转了 90°），沿用 screenPos[0] 会把镜头
     直接甩到幕布底下。x/z 一律取床心，只有 y 从床顶起算。
     再沿 **床尾方向（-X）** 退 1.2 米：躺姿贴在床尾一侧、脚朝床头，
     视线正好对着床尾外那块幕布（床尾 = 世界 -X，床头 = +X）。
     eye 高度 = 躺卧视点 0.38 + 历史抬高 0.3 + 2026-10-05 用户反馈「eye 跑到床里
     去了」再抬 0.6 + 2026-10-06 用户「再调高 0.4 米」
     ⇒ 0.38+0.3+0.6+0.4 = **1.68**（相对床顶）。1.28 时是半靠坐起的视高，
     1.68 更接近站着俯看幕布 —— 床沿和被褥基本退出画面下缘。
     想微调改这一个常量就行（别再往上叠硬编码，历史值都留着做注释）。 */
  /* 朝床尾（-X）平移量。1.2 → 0.2（2026-10-06 用户「位置不对，要靠近床头
     （再远离电视 1 米）」）：床的长轴在 X，床心 x=-2、床尾 -6.23、**床头 +2.23**，
     幕布在 x=-8.23 的床尾外 ⇒ 「靠近床头」与「远离电视」是**同一个方向（+X）**。
     1.2 → 0.2 让 eye.x 从 -3.2 挪到 -2.2，离幕布 5.03m → 6.03m（正好远 1 米）。 */
  const WATCH_FOOT_SHIFT = 0.2;     // 朝床尾（-X）平移；往 +X 调 = 靠近床头
  const WATCH_EYE_LIFT  = 0.38 + 0.3 + 0.6 + 0.4 + 0.5; // 躺卧 0.38 + 抬高 0.3 + 0.6 + 0.4（10-06 上午）+ 0.5（10-06 下午）= 2.18
  const watchPos = new THREE.Vector3(
    cfg.bed.position[0] - WATCH_FOOT_SHIFT,
    bedTop + WATCH_EYE_LIFT,
    (cfg.bed.position[2] || 1.2) + 0.7);
  const watchTarget = new THREE.Vector3(screenPos[0], screenPos[1], screenPos[2]);
  const tvHome = { pos: camera.position.clone(), target: controls.target.clone() };
  let tvState = false;
  let fly = null;
  function easeInOutQuad(t){ return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2; }
  function startFly(toPos, toTarget, duration, keepLocked, done){
    controls.enabled = false;
    fly = {
      t:0, duration: Math.max(0.2, duration || 1.2),
      fromPos: camera.position.clone(), toPos,
      fromTarget: controls.target.clone(), toTarget,
      keepLocked: !!keepLocked, done
    };
  }
  /* ⚠ 看电视的落位会被 OrbitControls 的轨道约束「顶回去」—— 这是个实打实的 bug：
     `controls.minDistance = 6`，而机位到幕布（controls.target）只有 5.2m；
     视线还略微朝上（极角 103°，而 `maxPolarAngleDeg = 99`）。两者都会在
     controls.update() 里把相机硬拽回合法区 ⇒ 实测永远落在 (-2.36, 3.01, 2.02)，
     比设计的 (-3.2, 2.755, 1.9) 差 0.87m、仰角被压平（三点都算得出来：
     松开约束后按 r=6 / φ=99° 反解就是 x=-2.362, y=3.011, z=2.016）。
     所以看电视期间**临时**放松这两个约束，飞完保持放松、飞回落地再收回
     （复位瞬间就收会把还停在床上的相机猛推一下，必须等飞回结束）。 */
  let tvLimits = null;
  function applyTVLimits(on){
    if(on){
      if(!tvLimits) tvLimits = { min: controls.minDistance, max: controls.maxPolarAngle };
      controls.minDistance = Math.min(controls.minDistance, 1.5);
      controls.maxPolarAngle = Math.max(controls.maxPolarAngle, THREE.MathUtils.degToRad(115));
    } else if(tvLimits){
      controls.minDistance = tvLimits.min;
      controls.maxPolarAngle = tvLimits.max;
      tvLimits = null;
    }
  }

  /* ---------- 看电视：第一人称操控 ----------
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
  /* 进来看电视时 BGM 在不在放用的是模块级 bgmBefore（见文件头）——
     这里再声明一次会让外面那次赋值又变成未声明赋值（= ReferenceError）。 */

  function setTVMode(on, done){
    if(!!on === tvState){ if(done) done(); return; }
    if(on){
      setMode('free');
      tvHome.pos.copy(camera.position);
      tvHome.target.copy(controls.target);
      if(ladder) ladder.visible = false;
      /* ⚠ 速度是「原来的 30%」⇒ 时长 = 原时长 / 0.3：1.4s ⇒ 4.7s。
         之前 1.4s 飞过去太快，像瞬移；现在慢慢飘过去才像「靠回床上」。 */
      /* keepLocked=false：飞到位就把控制权交还给用户 ——
         此时镜头停在床上、焦点在幕布，玩家可以自由拖拽 / 滚轮 / 右键平移微调视角，
         也可以照常点「漫游 / 步行」走开再看回来（梯子仍在藏着，直到复位）。 */
      applyTVLimits(true);          // 先松约束，再起飞，否则飞完最后一帧就被钳回去
      startFly(watchPos.clone(), watchTarget.clone(), 4.7, false, ()=>{
        tvState = true;
        /* 第一人称接管：轨道门先关掉（下面 fp.on 直接写相机），
           一帧 controls.update() 都不要 —— 它会按轨道约束把人从床上拽走。 */
        controls.enabled = false;
        fpFromCamera(); fp.on = true;
        /* 三个玩法按钮一并锁掉（见 setupModes 顶部 btns 那条注释）——
           放在状态机里而不是按钮回调里，是因为「看电视」还会从别的路退出：
           切非夜间时相、按 R 复位。锁挂在状态上，两条路都能解锁。 */
        btns.forEach(b => { b.disabled = true; });
        /* BGM 的暂停挪到点击那一刻（见上方 projBtn 分支），这里只管状态机；
           复位那条路会原样把 BGM 接回来。AUD 是空壳 / 老版本没 pause() 时空转不报错。 */
        if(done) done();
      });
    } else {
      /* 一按下复位就把 tvState 翻假（回调里那次只是双保险）：
         云飘的开关读的就是 tvState —— 若留到飞回结束才翻，整段返程里「还想看」
         依旧为真，云会一路飘到幕布上面去，等镜头到家才开始往回挪，看着像先跑过头再倒回。 */
      tvState = false;
      btns.forEach(b => { b.disabled = false; });   // 交还玩法模式（对应落地时那次锁）
      if(mode !== 'free') setMode('free');
      if(ladder) ladder.visible = true;
      fp.on = false; fp.dragId = null;          // 交还给 OrbitControls 之前先收掉第一人称
      controls.enabled = true;
      /* bgmBefore 是「进来看电视前在不在放」，照原样接回来；没在放就别自作主张起播。
         AUD 是空壳 / 老版本没这个 api 时空转不报错。 */
      try{ if(AUD && bgmBefore && AUD.state !== 'playing' && AUD.resume) AUD.resume(); }catch(_){}
      startFly(tvHome.pos.clone(), tvHome.target.clone(), 4.0, false, ()=>{
        tvState = false;
        controls.enabled = true;
        applyTVLimits(false);       // 飞回落地才收回约束，别在按复位的瞬间推相机
        if(done) done();
      });
    }
  }

  /* 复位 = 回到刚打开时的样子。复位的是**玩法状态**（机位 / 焦点 / 模式 /
     角色 / 漫游进度 / 跳跃请求），不动画面风格 —— 时相、滤镜、雾档归它们
     自己的按钮（要回原片按 0）。两件事分开，复位才不会把刚调好的天色一块抹掉。
    2026-10-05 又补一条：**时相跟着回到「下午」** —— 用户点复位要的是「回到刚打开时
    的样子」，不是留下夜间那一档。滤镜 / 雾档仍归它们自己的按钮（要回原片按 0）。 */
  function resetView(){
    if(mode !== 'free') setMode('free');   // 先退出漫游 / 步行（顺便清掉摇杆）
    /* 若正处在「看电视」位姿，先把这个状态连同它绑住的每一样东西一起清掉再复位。
       ⚠ 原来这里直接调 closeProjector() —— 它是 createSceneUI **内部**的函数，
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
    }
    /* 角色状态清零。P.foot 归 0 就够 —— 切模式时 syncFromCamera() 会按当时的
       相机位置重算一次，这里只是别让「复位后立刻切步行」沿用旧坐标。 */
    P.x = 0; P.z = 0; P.foot = 0; P.yaw = 0; P.pitch = 0; P.vy = 0;
    P.state = 'ground'; P.ls = 0; P.lsq = 0; P.landT = 0;
    run.i = 0; run.t = 0;                  // 漫游排回第一站
    leapS.on = false; leapS.landed = false; leapS.t = 0;
    jumpReq = false;
    camera.position.copy(HOME.pos);
    orbitAim.copy(HOME.target);            // 自由模式的环绕中心
    controls.target.copy(HOME.target);
    /* 把 OrbitControls 里那点「拖拽残留」清干净，再按 HOME 重新定位。
       这里必须 **update 两次**，原因写在它源码里（vendor 的 update）：
         第 204~212 行   enableDamping=false 时会 spherical.theta += sphericalDelta.theta
                        —— 是把**整个余量一次性吐出来**，不是丢弃；
         第 292~296 行   然后才 sphericalDelta.set(0,0,0) / panOffset.set(0,0,0)。
       所以第一次 update 是「把上次拖拽剩下没走完的旋转角一次走完」（相机会甩到别处），
       第二次 update 才是「余量已归零，按刚写进去的 position/target 精确定位」。
       只 update 一次就复位 ⇒ 残留角度被一并加上，实测相机绕到 -8.05,9,32.43
       （半径对、**方位角**全错，差 26.5 米）——看着像「复位了但又没完全复位」。
       两次之后 posErr / targetErr 都是 0（见 tools/reset-autowalk-lock.json）。 */
    const damp = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();                     // ① 吐掉残留（相机会被甩到别处，无所谓）
    camera.position.copy(HOME.pos);        // ② 重新写回 HOME 再算一次朝向
    controls.target.copy(HOME.target);
    controls.update();
    controls.enableDamping = damp;
    fovReset();                            // 视场角回原值（爬梯那一段可能正拉到 64°）
    /* 「复位 = 打开页面时的样子」也包含时相：回到「下午」这一档（首屏）。
       ⚠ 必须放在**最末**：atmos.apply → onPhase 会顺手再走一次 closeProjector /
       tvEnter(false)，那时 tvState 已是 false、幕布也早关了，两条都是空操作；
       要是放在最前，tvEnter(false) 会立刻起飞 4s 往回飞，跟下面的硬归位互相拉扯，
       相机就停在半路上了。 */
    try{ if(tvHooks && tvHooks.applyPhase) tvHooks.applyPhase(tvHooks.defaultPhase || 'afternoon'); }catch(_){}
    try{ if(tvHooks && tvHooks.syncUi) tvHooks.syncUi(); }catch(_){}
    refreshHint();
  }

  btns.forEach(b => b.addEventListener('click', ()=> setMode(b.dataset.mode)));
  btns.forEach(b => { if(b.dataset.mode === 'free') b.classList.add('active'); });

  /* 复位按钮：按一下闪白 220ms —— 复位是瞬时的、没有 active 高亮可看，
     不给点反馈会像「点了没反应」。
     flashHint 在漫游里有自己的台词、会被它忽略，所以先 resetView() 退到自由模式，
     再提示（顺序反了就没提示）。 */
  const resetBt = document.getElementById('reset-btn');
  if(resetBt){
    resetBt.addEventListener('click', e => {
      e.preventDefault();
      resetView();
      resetBt.classList.add('hit');
      setTimeout(() => resetBt.classList.remove('hit'), 220);
      flashHint('复位：回到打开时的机位', 1200);
    });
    addEventListener('keydown', e => {
      if(e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if(e.key === 'r' || e.key === 'R'){ resetBt.click(); e.preventDefault(); }
    });
  }

  /* 支持 ?mode=roam|walk 直接以某个模式开场（便于截图 / 分享链接） */
  const q = new URLSearchParams(location.search).get('mode');
  if(q && (q === 'roam' || q === 'walk' || q === 'free')) setMode(q);

  /* 调试出口：控制台里可以直接看角色状态（无头脚本也靠它判断进度）。
     goto(i) 直接跳到 route 第 i 步 —— 漫游全程要十几秒仿真时间，
     截图/回归时没必要每次都从「飞向梯子」开始等一遍。 */
  window.__rig = {
    P, get mode(){ return mode; }, setMode, rig, leap: leapS,
    reset: resetView,                       // 无头脚本按「复位」用（等价于点一下那个按钮）
    home: HOME,                             // 复位目标位姿，便于断言「确实回到了原处」
    tvEnter: setTVMode,                     // 夜间「看电视」飞床动画入口
    get tvActive(){ return tvState || !!fly; },
    get tvState(){ return tvState; },
    get fpOn(){ return fp.on; },   // 看电视期间是不是第一人称（无头断言用）
    get autoWalk(){ return ROAM.autoWalk !== false; },
    /* 爬梯/上床的速度（无头脚本按它做「速率 = Δls / Δt」的实测断言） */
    get climb(){ return { speed: climbSpeed, mountSpeed }; },
    get step(){ return run.i; },
    get steps(){ return route ? route.length : 0; },
    goto(i){
      if(!route) return -1;
      run.i = Math.max(0, Math.min(route.length - 1, i|0));
      run.t = 0;
      stepHint(route[run.i]);
      return run.i;
    }
  };
  /* ---------- 每帧 ---------- */
  function step(dt){
    if(fly){
      fly.t += dt;
      const a = Math.min(1, fly.t / fly.duration);
      const k = easeInOutQuad(a);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, k);
      controls.target.lerpVectors(fly.fromTarget, fly.toTarget, k);
      camera.lookAt(controls.target);
      controls.update();
      if(a >= 1){
        const done = fly.done;
        const keep = fly.keepLocked;
        fly = null;
        if(!keep) controls.enabled = true;
        if(done) done();
      }
      return;
    }
    if(mode === 'roam' && route){
      routeTick(dt);
      /* 本步的视场角增量。⚠ 要在 routeTick **之后**取 run.i —— 它可能刚推进到下一站，
         这时候按新那一步给值才对（爬梯结束的那一帧不加延迟地开始收回来）。 */
      fovStep(dt, route[run.i % route.length].fovBoost);
      applyCamera(dt);
      return;
    }
    /* ⚠ 不能无条件 boost=0：正在看电视时视角要 +15°（躺床上视野更开、更贴影院感）。
       tvState 在点「看电视」落位后为真、点「复位」瞬间翻假 ⇒ 飞回途中仍保持广角，
       落地才收，收得平滑（fovStep 本身是指数缓动，不是硬切）。
       想改这个广角幅度：config.json 的 projector.tvFovBoost 或 scene.json 同键。 */
    fovStep(dt, tvState ? TV_FOV_BOOST : 0);   // 步行 / 自由：无看电视时回原值
    if(tvState && fp.on){ fpStep(dt); return; }  // 看电视：第一人称，一帧都不碰 OrbitControls
    if(mode === 'walk'){
      /* 视角 */
      P.yaw   -= sLook.x*lookSpeed*dt;
      P.pitch -= sLook.y*lookSpeed*0.7*dt;
      if(keys.KeyQ || keys.ArrowLeft)  P.yaw   += lookSpeed*0.8*dt;
      if(keys.KeyE || keys.ArrowRight) P.yaw   -= lookSpeed*0.8*dt;
      if(keys.ArrowUp)   P.pitch += lookSpeed*0.5*dt;
      if(keys.ArrowDown) P.pitch -= lookSpeed*0.5*dt;
      P.pitch = THREE.MathUtils.clamp(P.pitch, -0.95, 0.72);

      /* 输入 → 世界方向。
         applyCamera/syncFromCamera 定的相机朝向是：
           前 fwd = (-sin yaw, -cos yaw)      右 right = (cos yaw, -sin yaw)
         ⇒ 世界方向 = right*mx + fwd*(-my)（摇杆/按键里 my<0 = 前）
           展开：wx = cy*mx + sy*my
                 wz = -sy*mx + cy*my */
      let mx = sMove.x, my = sMove.y;
      if(keys.KeyW) my -= 1;
      if(keys.KeyS) my += 1;
      if(keys.KeyA) mx -= 1;
      if(keys.KeyD) mx += 1;
      const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
      let wx = cy*mx + sy*my, wz = -sy*mx + cy*my;
      const m = Math.hypot(wx, wz);
      if(m > 1){ wx /= m; wz /= m; }
      tryClimb(wx, wz);
      const jump = jumpReq; jumpReq = false;

      /* 已挂梯子：按相对梯轴的推拉决定上/下/停 */
      let climbDir = 0;
      if(P.state === 'ladder'){
        const hl = Math.hypot(LD.up[0], LD.up[2]) || 1;
        const proj = (wx*LD.up[0] + wz*LD.up[2])/hl;
        climbDir = proj > 0.25 ? 1 : (proj < -0.25 ? -1 : 0);
      }
      movePlayer(dt, wx, wz, jump, climbDir, false);
      applyCamera(dt);
      return;
    }
    controls.update();
    orbitAim.copy(controls.target);
  }
  step.tvEnter = (on, done) => setTVMode(on, done);
  step.tvActive = () => tvState || !!fly;
  step.tvState = () => tvState;
  return step;
}

/* ============================================================
   2.5 调参台：config.json 覆盖 scene.json
   ------------------------------------------------------------
   config.json 是给人手动改的一层「面板」，只放会经常调的键。
   只认已知键：config 里写了的就覆盖到 cfg 上（就地改），没写的
   沿用 scene.json 原值 ⇒ 删掉一项就等于恢复默认，不用记两份值。
   太阳不用再手写坐标：给「方位角 + 仰角 + 距离」，这里换算成
   position；不写角度时反解出当前角度，方便在面板里微调。
   返回一个「生效值」快照，挂在 window.__dbg.config 上便于核对。
   ============================================================ */
function applyConfig(cfg, k){
  const eff = {};
  if(!k) return eff;
  const num = v => (typeof v === 'number' ? +v.toFixed(3) : v);

  /* ---- 白菊花簇（必须最先做） ----
     面板里写了 daisies.clusters 就整组替换。给的是「最终世界坐标」，
     下面 bedScale 那段不会再把它按比例外推 —— 否则手填一个数要自己倒推
     1/1.2，边调边错。不写这一项就沿用 scene.json 的花簇（会跟着床缩放走）。 */
  const DC = k.daisies || {};
  if(cfg.daisies && Array.isArray(DC.clusters) && DC.clusters.length){
    cfg.daisies.clusters = DC.clusters.map(c => Object.assign({}, c));
    eff.daisyClustersFromPanel = cfg.daisies.clusters.length;
  }
  /* daisies.grow：整株长高倍率（只改 Y）。和 sizes.daisyScale 是两回事 ——
     后者等比放大整株（花头一起变大），前者只把茎拉长。 */
  if(DC.grow !== undefined && cfg.daisies){ cfg.daisies.grow = DC.grow; eff.daisyGrow = DC.grow; }
  /* ---- 蝴蝶巡航（整组浅合并） ----
     写在面板里就覆盖 scene.json 的同名键，写几个覆盖几个。
     flight / flowerRadius / flowerHeight / flowerDrift / speedFlower
     都是「绕白菊飞」那一套的旋钮，改完刷新即可。 */
  if(k.butterflies && cfg.butterflies){
    Object.assign(cfg.butterflies, k.butterflies);
    eff.butterflyFromPanel = Object.keys(k.butterflies).join(',');
  }
  /* 草离床边多远（无草区由床尺寸推出来，这里只调外面加的那一圈 margin） */
  if(k.bed && k.bed.avoidMargin !== undefined && cfg.grass && cfg.grass.avoid)
    cfg.grass.avoid.margin = k.bed.avoidMargin;

  /* ---- 阳光 ---- */
  const L = cfg.lights || {};
  const S = k.sun || {};
  if(L.sun){
    const p = L.sun.position || [0, 1, 0];
    const h = Math.hypot(p[0], p[2]);
    let az = Math.atan2(p[0], p[2]) * 180/Math.PI;      // 0° = +Z，顺时针到 +X
    let el = Math.atan2(p[1], h) * 180/Math.PI;
    let dist = Math.hypot(h, p[1]);
    const wantAz = (S.azimuthDeg   !== undefined) || (S.elevationDeg !== undefined) || (S.distance !== undefined);
    if(S.azimuthDeg   !== undefined) az = S.azimuthDeg;
    if(S.elevationDeg !== undefined) el = S.elevationDeg;
    if(S.distance     !== undefined) dist = S.distance;
    if(wantAz){
      const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
      L.sun.position = [ dist*Math.cos(e)*Math.sin(a), dist*Math.sin(e), dist*Math.cos(e)*Math.cos(a) ];
    }
    if(S.intensity !== undefined) L.sun.intensity = S.intensity;
    if(S.color) L.sun.color = S.color;
    eff.sunAzimuthDeg   = num(az);
    eff.sunElevationDeg = num(el);
    eff.sunDistance     = num(dist);
    eff.sunIntensity    = L.sun.intensity;
    eff.sunPosition     = L.sun.position.map(num);
  }

  /* ---- 环境光 / 半球光 ---- */
  const A = k.ambient || {};
  if(L.ambient){
    if(A.intensity !== undefined) L.ambient.intensity = A.intensity;
    if(A.color) L.ambient.color = A.color;
    eff.ambientIntensity = L.ambient.intensity;
  }
  const H = k.hemisphere || {};
  if(L.hemisphere){
    if(H.intensity !== undefined) L.hemisphere.intensity = H.intensity;
    if(H.sky)    L.hemisphere.sky    = H.sky;
    if(H.ground) L.hemisphere.ground = H.ground;
    eff.hemisphereIntensity = L.hemisphere.intensity;
  }

  /* ---- 常雾（默认那一档） ----
     写在 scene.fog 上：applyFog 把它当作「没自己写 near/far 的时相」的兜底
     （只有「下午」用得上）。改这两个数 = 改默认画面的雾浓淡。
     ⚠ 必须在 build() 之前生效 —— atmosphere 的 base 快照就是在建场景时从
       scene.fog 读的，晚一步改就只在下一帧的 fallback 里生效（而那时早就
       apply 过一次了）。这里在 applyConfig 里改，天然早于 build()。 */
  const FG = k.fog || {};
  if(cfg.scene && cfg.scene.fog){
    if(FG.near  !== undefined) cfg.scene.fog.near  = FG.near;
    if(FG.far   !== undefined) cfg.scene.fog.far   = FG.far;
    if(FG.color)               cfg.scene.fog.color = FG.color;
    eff.fog = { near: cfg.scene.fog.near, far: cfg.scene.fog.far };
  }
  /* ---- 爬升速度（梯子 / 上床分开） ---- */
  const WK = k.walk || {};
  if(cfg.walk){
    if(WK.climbSpeed !== undefined) cfg.walk.climbSpeed = WK.climbSpeed;
    if(WK.mountSpeed !== undefined) cfg.walk.mountSpeed = WK.mountSpeed;
    eff.climbSpeed = cfg.walk.climbSpeed;
    eff.mountSpeed = cfg.walk.mountSpeed;
  }

  /* ---- 云 ---- */
  const C = k.cloud || {}, CL = cfg.cloud || {};
  if(C.puffCount !== undefined) CL.puffCount = C.puffCount;
  if(C.nearFade   !== undefined) CL.nearFade   = C.nearFade;
  if(C.insideFade !== undefined) CL.insideFade = C.insideFade;
  if(C.size)      CL.puffSize  = C.size.slice();
  if(C.radius)    CL.radii     = C.radius.slice();
  if(C.height !== undefined && CL.center) CL.center[1] = C.height;
  if(C.opacity)   CL.opacity   = C.opacity.slice();
  if(C.flatten !== undefined && CL.puffScale) CL.puffScale[1] = C.flatten;
  /* 风：整体替换（不是逐键合并）—— 面板里写 wind 就是想完整接管这一组参数，
     逐键合并会让「把 speed 改成 0」这种操作被 scene.json 的默认值顶掉。 */
  if(C.wind) CL.wind = JSON.parse(JSON.stringify(C.wind));
  /* 碰云：整体替换，同上 */
  if(C.poke) CL.poke = JSON.parse(JSON.stringify(C.poke));
  /* 梦核 BGM：浅合并（只写 volume 时不该把 tracks 清空），sfx 再合并一层 */
  if(k.audio){
    const merged = Object.assign({}, cfg.audio || {}, k.audio);
    merged.sfx = Object.assign({}, ((cfg.audio || {}).sfx || {}), k.audio.sfx || {});
    cfg.audio = merged;
    eff.audio = { enabled: merged.enabled, volume: merged.volume,
                  tracks: (merged.tracks || []).map(t => t && (t.title || t.file)) };
  }
  eff.cloudPuffCount = CL.puffCount;
  eff.cloudSize      = CL.puffSize;
  eff.cloudRadius    = CL.radii;
  eff.cloudHeight    = CL.center ? num(CL.center[1]) : undefined;
  eff.cloudNearFade  = CL.nearFade;
  eff.cloudInsideFade = CL.insideFade;
  eff.cloudWind      = CL.wind;
  eff.cloudPoke      = CL.poke;

  /* ---- 屏幕后处理 / 时相 ----
     这两组的「数值表」（四档滤镜的 bloom+调色、四档时相的灯/雾/天空/天体）
     都写死在各自的 JS 模块里当 DEFAULTS，JSON 只放顶层开关；
     想在面板里改具体数值就写到 presets / states 下面。
     三阶浅合并 = 只覆盖写到的键，没写的沿用下层（写 presets.vhs.bloom
     不会把 vhs.grade 清空，写 states.dawn.orb 不会把 orb 的其它键吃掉）。 */
  const mergeL3 = (base, patch) => {
    const out = Object.assign({}, base || {});
    Object.keys(patch || {}).forEach(n => {
      const b = out[n] || {}, p = patch[n] || {}, merged = Object.assign({}, b);
      Object.keys(p).forEach(k => {
        merged[k] = (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k]))
          ? Object.assign({}, b[k] || {}, p[k]) : p[k];
      });
      out[n] = merged;
    });
    return out;
  };
  if(k.postfx && typeof k.postfx === 'object'){
    const merged = Object.assign({}, cfg.postfx || {});
    Object.keys(k.postfx).forEach(key => {
      if(key.charAt(0) === '_') return;                      // _说明 只是注释
      if(key === 'presets') merged.presets = mergeL3(merged.presets, k.postfx.presets);
      else merged[key] = k.postfx[key];
    });
    cfg.postfx = merged;
    eff.postfx = { enabled: merged.enabled, default: merged.default, samples: merged.samples,
                   bloom: merged.bloom, bloomScale: merged.bloomScale,
                   presets: Object.keys(merged.presets || {}) };
  }
  if(k.atmosphere && typeof k.atmosphere === 'object'){
    const merged = Object.assign({}, cfg.atmosphere || {});
    Object.keys(k.atmosphere).forEach(key => {
      if(key.charAt(0) === '_') return;
      if(key === 'states') merged.states = mergeL3(merged.states, k.atmosphere.states);
      else merged[key] = k.atmosphere[key];
    });
    cfg.atmosphere = merged;
    eff.atmosphere = { enabled: merged.enabled, default: merged.default,
                       fogModeDefault: merged.fogModeDefault,
                       states: Object.keys(merged.states || {}) };
  }

  /* ---- 数量（草 / 花 / 蝴蝶 / 高光） ---- */
  const N = k.counts || {}, G = cfg.grass || {};
  if(N.grass !== undefined)                        G.count = N.grass;
  if(N.grassTuft   !== undefined && G.tuft)        G.tuft.count     = N.grassTuft;
  if(N.lavender    !== undefined && G.lavender)    G.lavender.count = N.lavender;
  if(N.butterfly   !== undefined && cfg.butterflies) cfg.butterflies.count = N.butterfly;
  if(cfg.glints){
    if(N.glintBed    !== undefined && cfg.glints.bed)    cfg.glints.bed.count    = N.glintBed;
    if(N.glintLadder !== undefined && cfg.glints.ladder) cfg.glints.ladder.count = N.glintLadder;
  }
  /* 白菊花在 scene.json 里是按「每一簇各给一个株数」写的；
     面板上只给一个总数，这里按各簇原有占比分摊（簇间相对疏密不变） */
  if(N.daisy !== undefined && cfg.daisies && cfg.daisies.clusters && cfg.daisies.clusters.length){
    const cl = cfg.daisies.clusters;
    /* 面板里的花簇通常只写位置和铺展、不写 count ⇒ 这里给「等权」。
       若照旧用 count||0，raw 全为 0 会把两百株花全塞进最后一簇。 */
    const raw = cl.map(c => (c.count > 0 ? c.count : 1));
    const tot = raw.reduce((a, b) => a + b, 0) || cl.length;
    let acc = 0;
    cl.forEach((c, i) => {
      c.count = (i === cl.length - 1) ? Math.max(0, Math.round(N.daisy) - acc)
                                      : Math.max(0, Math.round(N.daisy * raw[i] / tot));
      acc += c.count;
    });
  }
  eff.counts = {
    grass: G.count,
    grassTuft: G.tuft ? G.tuft.count : undefined,
    lavender: G.lavender ? G.lavender.count : undefined,
    daisy: cfg.daisies && cfg.daisies.clusters
             ? cfg.daisies.clusters.reduce((a, c) => a + (c.count || 0), 0) : undefined,
    butterfly: cfg.butterflies ? cfg.butterflies.count : undefined,
    glintBed: cfg.glints && cfg.glints.bed ? cfg.glints.bed.count : undefined,
    glintLadder: cfg.glints && cfg.glints.ladder ? cfg.glints.ladder.count : undefined
  };

  /* ---- 尺寸 / 铺展半径 ---- */
  const Z = k.sizes || {};
  const mulPair = (arr, m) => arr ? arr.map(v => +(v*m).toFixed(4)) : arr;
  if(Z.grassRadius    !== undefined) G.radius = Z.grassRadius;
  if(Z.tuftRadius     !== undefined && G.tuft)     G.tuft.radius     = Z.tuftRadius;
  if(Z.lavenderRadius !== undefined && G.lavender) G.lavender.radius = Z.lavenderRadius;
  if(Z.bladeHeight    !== undefined) G.bladeHeight = Z.bladeHeight;
  if(Z.daisyScale !== undefined && cfg.daisies){
    if(cfg.daisies.size) cfg.daisies.size = mulPair(cfg.daisies.size, Z.daisyScale);
    (cfg.daisies.clusters || []).forEach(c => { if(c.size) c.size = mulPair(c.size, Z.daisyScale); });
  }
  if(Z.butterflyScale !== undefined && cfg.butterflies && cfg.butterflies.size)
    cfg.butterflies.size = mulPair(cfg.butterflies.size, Z.butterflyScale);
  if(Z.glintScale !== undefined && cfg.glints && cfg.glints.size)
    cfg.glints.size = mulPair(cfg.glints.size, Z.glintScale);
  eff.sizes = {
    grassRadius: G.radius,
    tuftRadius: G.tuft ? G.tuft.radius : undefined,
    lavenderRadius: G.lavender ? G.lavender.radius : undefined,
    bladeHeight: G.bladeHeight,
    bedScale: Z.bedScale,
    daisyScale: Z.daisyScale,
    butterflyScale: Z.butterflyScale,
    glintScale: Z.glintScale
  };

  /* ---- 床的整体缩放（B.scale / 面板 sizes.bedScale） ----
     床组以「床底中心」为原点缩放 ⇒ 底面永远贴在地形上，只向外、向上长，
     所以「放大」本身不会让床陷进土里。真正会被床吞进去的是周围那几样「让位」的东西：
       ① 无草区（近处草叶 / 中景草丛 / 薰衣草散点共用）—— 尺寸由床尺寸现推，
          见 resolveAvoid()，改床尺寸/缩放时自动跟着走，不用手改数字；
       ② 蝴蝶巡航椭圆 —— 不放大就会擦着甚至穿过床板；
       ③ 手摆的床边花簇（白菊、床边薰衣草）—— 不放大就会贴到床框上。
     都在这里按**同一套逐轴比例**外推，保持与床的相对位置不变。
     ⚠ 必须是逐轴、而不是「一个代表缩放」：床可以在 X/Z 上被拉长而 Y 不动，
       这时花簇该按各自轴的倍率往外挪。用一个标量外推的后果是床沿压住白菊
       （或花被甩得太远），而且两轴永远对不上。 */
  const BD = cfg.bed || {};
  if(Z.bedScale !== undefined) BD.scale = Z.bedScale;
  const [bsx, bsy, bsz] = bedScaleTriple(BD);
  const r4 = v => +v.toFixed(4);
  if(bsx !== 1 || bsz !== 1){
    const bx = BD.position ? BD.position[0] : 0;
    const bz = BD.position ? BD.position[2] : 0;
    const growPair = (a, f) => Array.isArray(a) ? a.map(v => r4(v*f)) : a;
    if(cfg.butterflies){
      cfg.butterflies.radiusX = growPair(cfg.butterflies.radiusX, bsx);
      cfg.butterflies.radiusZ = growPair(cfg.butterflies.radiusZ, bsz);
    }
    const pushOut = arr => {
      if(!Array.isArray(arr)) return;
      arr.forEach(c => {
        if(!c || !Array.isArray(c.center)) return;
        c.center = [ r4(bx + (c.center[0]-bx)*bsx), r4(bz + (c.center[1]-bz)*bsz) ];
      });
    };
    /* 面板手填的白菊花簇不跟着外推（它的坐标就是最终位置） */
    if(cfg.daisies && !eff.daisyClustersFromPanel) pushOut(cfg.daisies.clusters);
    if(G.lavender)  pushOut(G.lavender.clusters);
  }
  const AV = resolveAvoid(cfg);
  eff.bed = { scale: [bsx, bsy, bsz], surfaceY: bedSurfaceHeight(BD),
              avoidHalf: AV ? [AV.halfX, AV.halfZ] : undefined,
              daisyCenters: (cfg.daisies && cfg.daisies.clusters) ? cfg.daisies.clusters.map(c => c.center) : undefined,
              lavenderCenters: (G.lavender && G.lavender.clusters) ? G.lavender.clusters.map(c => c.center) : undefined };

  /* ---- 草的颜色 ----
     近处草叶（mesh 顶点色渐变）× 实例色，中远处草丛（tuft 贴图）× 实例色，
     两者都是「乘法叠加」，所以贴图/顶点色越深，成品越黑。 */
  const GC = k.grassColors || {};
  if(GC.blade && GC.blade.length >= 2){
    G.colors.a = GC.blade[0];
    G.colors.b = GC.blade[1];
  }
  if(GC.bladeTintLight && G.tint) G.tint.l = GC.bladeTintLight.slice();
  if(GC.tuftBlade && GC.tuftBlade.length >= 3 && G.tuft) G.tuft.blade = GC.tuftBlade.slice();
  if(GC.tuftTintLight && G.tuft && G.tuft.tint) G.tuft.tint.l = GC.tuftTintLight.slice();
  eff.grassColors = {
    blade: [G.colors.a, G.colors.b],
    bladeTintLight: G.tint ? G.tint.l : undefined,
    tuftBlade: G.tuft ? G.tuft.blade : undefined,
    tuftTintLight: (G.tuft && G.tuft.tint) ? G.tuft.tint.l : undefined
  };

  /* ---- 床底暗部：深色草环 + 接地阴影（"让床看起来踏在地上"） ---- */
  const B = k.bedShadow || {}, BS = cfg.bedShadow;
  if(BS){
    if(B.enabled !== undefined)     BS.enabled     = B.enabled;
    if(B.grass !== undefined)       BS.grass       = B.grass;
    if(B.ringWidth !== undefined)   BS.ringWidth   = B.ringWidth;
    if(B.falloff   !== undefined)   BS.falloff     = B.falloff;
    if(B.heightScale !== undefined) BS.heightScale = B.heightScale;
    if(B.size      !== undefined)   BS.size        = B.size.slice();
    if(B.edgeBoost !== undefined)   BS.edgeBoost   = B.edgeBoost;
    if(B.tintLight)                 BS.tint.l      = B.tintLight.slice();
    if(BS.ao){
      if(B.aoOpacity !== undefined) BS.ao.opacity = B.aoOpacity;
      if(B.aoSpread  !== undefined) BS.ao.spread  = B.aoSpread;
    }
    eff.bedShadow = {
      enabled: BS.enabled, grass: BS.grass, ringWidth: BS.ringWidth,
      falloff: BS.falloff, heightScale: BS.heightScale,
      size: BS.size, edgeBoost: BS.edgeBoost,
      tintLight: BS.tint ? BS.tint.l : undefined,
      aoOpacity: BS.ao ? BS.ao.opacity : undefined,
      aoSpread:  BS.ao ? BS.ao.spread  : undefined
    };
  }

  console.log('[config.json] 已覆盖的参数：', eff);
  return eff;
}

/* ============================================================
   2d. 隐藏 UI（底部正中那个开关）
   ------------------------------------------------------------
   点一下 = 把界面上所有按钮/面板/提示收起来，只留左上角标题
   （「云端之梯」+「#梦核」）和这个开关自己；再点一下全部还原。

   ★ 为什么是「给 <body> 挂一个 class」而不是逐个元素改 style.display：
     这些元素的显隐本来就各有各的主 —— #jump-btn 靠 .on、#mode-hint 靠内联
     opacity、#scene-ui 的按钮靠 .active、摇杆靠 .stick.on。
     这里若直接写 style.display，就会跟那些逻辑打架：切模式时 .on 会把按钮
     重新显示出来，而「还原」时又得知道它「原本该不该显示」。
     挂在 body 上的 class 是纯 CSS 层的一次性覆盖（见 style.css 的 !important 组），
     逻辑类照旧切换、状态一点不丢，摘掉 class 就是原样。

   ★ 快捷键 H（HUD 的首字母）= 让「不看界面也能把界面收起来」。
     收起后 1–4 / 5–9 / F / 空格 这些键仍然有效 —— 隐藏的是显示，不是能力。
   ★ URL 参数 ?ui=0（也认 off / hide）直接以收起状态开场，便于截图与分享。
   ============================================================ */
function setupUiToggle(){
  const btn = document.getElementById('ui-toggle');
  if(!btn) return null;
  let hidden = false;
  function apply(v){
    hidden = !!v;
    document.body.classList.toggle('ui-hidden', hidden);
    const tip = (hidden ? '显示' : '隐藏') + '界面上的所有按钮与提示（快捷键 H）';
    btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    btn.setAttribute('title', tip);
    /* 两个 span 里只有一个显示，但 textContent 会读出「隐藏 UI显示 UI」——
       给一个明确的 aria-label 兜住读屏，别让它念串 */
    btn.setAttribute('aria-label', tip);
  }
  btn.addEventListener('click', e => { e.preventDefault(); apply(!hidden); });
  addEventListener('keydown', e => {
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if(e.key === 'h' || e.key === 'H'){ apply(!hidden); e.preventDefault(); }
  });
  const q = (new URLSearchParams(location.search).get('ui') || '').toLowerCase();
  apply(q === '0' || q === 'off' || q === 'hide' || q === 'hidden');

  const api = {
    el: btn,
    get hidden(){ return hidden; },
    toggle(){ apply(!hidden); },
    set: apply
  };
  window.__ui = api;      // 无头脚本/控制台用它断言收起状态
  return api;
}

/* ============================================================
   1.5 禁止页面缩放：拦住浏览器级的缩放快捷键 / 手势
   ------------------------------------------------------------
   <meta viewport user-scalable=no> 只管得住移动端 WebView 的捏合缩放；
   桌面浏览器那几套（Ctrl+滚轮、Ctrl +/−/0）与 Safari 的私有 gesture 事件
   必须在 JS 里拦。三条实打实的注意：
     · wheel 必须 passive:false 才允许 preventDefault —— 默认是**被动**监听，
       在里面调 preventDefault 只会静默失效（控制台丢一句
       "Unable to preventDefault inside passive event listener"，然后照旧缩放）。
     · 只在 e.ctrlKey / e.metaKey 时才拦：普通滚轮是 OrbitControls 的镜头推拉，
       一起拦掉的话自由模式直接废掉。这也正是无头回归里要断言的那一对正反面
       （Ctrl+滚轮被吃掉 / 普通滚轮必须放行）。
     · 必须 capture + stopPropagation：OrbitControls 自己也在 canvas 上听 wheel，
       不掐断传播的话事件照样送进去，Ctrl+滚轮会被它当成一次推拉吃下去。
   keydown 那一路（Ctrl +/−/0）桌面浏览器多数不接受页面取消 —— 拦得住是赚的，
   拦不住也不算失败，主路径是 meta + touch-action + 上面这条 wheel。
   为什么不放进 config.json 做成开关：它必须在**页面一加载**就生效，而 config.json
   是 fetch 来的 —— 前几百毫秒会漏过去，那时用户已经能捏合了。
   ============================================================ */
function lockViewport(){
  const opt = { passive:false, capture:true };
  addEventListener('wheel', e => {
    if(!e.ctrlKey && !e.metaKey) return;      // 普通滚轮放行给 OrbitControls
    e.preventDefault(); e.stopPropagation();
  }, opt);
  /* Safari 专有事件：双指捏合时抛的私有 gesture*，取消它才是真的关掉捏合 */
  ['gesturestart','gesturechange','gestureend'].forEach(t =>
    addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); }, opt));
  addEventListener('keydown', e => {
    if(!(e.ctrlKey || e.metaKey)) return;
    if(e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_' || e.key === '0')
      e.preventDefault();
  }, true);
  /* 双击：桌面端 = 页面缩放，移动端 = 双击缩放。一起按掉，别让画面在双击时跳一下。
     只在非控件处生效 —— 按钮上的双击是「连点两下」，不该被吞。 */
  addEventListener('dblclick', e => {
    const t = e.target;
    if(t && t.closest && t.closest('button,input,textarea,select,a')) return;
    e.preventDefault();
  }, true);

  return {
    meta: (document.querySelector('meta[name=viewport]') || {}).content || '',
    get touchAction(){ return getComputedStyle(document.documentElement).touchAction; },
    get userSelect(){ return getComputedStyle(document.body).userSelect; }
  };
}
/* 和 setupUiToggle 一样立刻装上：纯 DOM/事件的事，不依赖任何三维资源 */
window.__vp = lockViewport();

/* ============================================================
   1.6 Flex gap 能力检测（style.css 里那层「margin 基线」的增强开关）
   ------------------------------------------------------------
   style.css 末尾给 Flex 间距铺了一层子项 margin 基线，因为 WebView 61 不支持
   **Flex 容器**的 gap（那时 gap 只对 Grid 生效）—— 不铺就等于所有间距塌成 0。
   gap 本身是增强层，挂上 .supports-flex-gap 之后基线 margin 全归零、交回给 gap。
   为什么必须「建一个 Flex 容器量高度」而不是 CSS.supports('gap','1px')：
   语法检测只证明内核认识这个属性，不证明它在 Flex 里生效 —— 支持 Grid gap、
   不支持 Flex gap 的内核同样通过语法检测，而那正是最需要拦下的一批。
   这段照抄 css-compatibility.md §4 给的行为检测写法；只测一次，不进渲染循环。 */
function detectFlexGap(){
  let ok = false;
  try{
    const flex = document.createElement('div');
    flex.style.cssText = 'position:absolute;visibility:hidden;display:flex;'
                       + 'flex-direction:column;row-gap:1px;';
    flex.appendChild(document.createElement('div'));   // 两个 0 高度的子项
    flex.appendChild(document.createElement('div'));
    document.body.appendChild(flex);
    ok = (flex.scrollHeight === 1);   // 生效=两子项之间正好 1px；不生效=0
    flex.parentNode.removeChild(flex);
  }catch(e){ ok = false; }
  if(ok) document.documentElement.classList.add('supports-flex-gap');
  return ok;
}
window.__flexGap = detectFlexGap();

/* 立刻装上：它是纯 DOM 的事，不依赖任何三维资源 ——
   场景加载失败时也能把界面收起来（那时更该收）。 */
setupUiToggle();

/* ============================================================
   2.5 起不来时的兜底界面
   ------------------------------------------------------------
   performance-budget.md §5：getContext() 失败、着色器编译失败、上下文反复丢失时
   **必须进入可理解的兜底界面，不能白屏、不能死循环重试、不能一直弹错**。
   最容易白屏的一种情况是「WebGL 上下文建不出来」：WebGLRenderer 的构造函数会直接
   抛异常，异常从 build() 里冒出来 —— 以前它只会在控制台留一条 unhandled rejection，
   页面上什么都看不到，用户只会说「打不开」。
   这里把它接住，显示项目本来就带的那层 #boot-error（index.html 里的 DOM）。
   错误文本要转义后插入 —— 它可能带着内核返回的原始消息，不能直接当 HTML 用。
   注意它一进来就先调 BOOT.hide()：加载提示得先退场，否则两层颜色互相掺。 */
/* ============================================================
   2.6 加载提示（#boot-tip）
   ------------------------------------------------------------
   为什么要有：build() 是**一整段同步代码** —— 15000 株草 + 16000 丛草 +
   4200 薰衣草 + 150 片云 + 4096² 阴影贴图 + 几十张 canvas 贴图，
   全在主线程上一次性生成；之后还有异步的床 GLB。这段几百毫秒到几秒里
   画面是**静止**的（不是白屏，也不转圈），看着很像「点了没反应」。

   隐藏条件是两条的合取：「首帧已经画出来了」∧「登记过的异步资源都到齐」：
     · 只等 build() 返回不够 —— 那时还没画过一帧，app 里是空的；
     · 只等首帧也不够 —— 床 GLB 要晚几百毫秒才到，会看见床「啪」地换一次。

   还要一个「最短显示时长」：命中缓存时整个启动可能只要几十毫秒，
   提示一闪而过反而像画面在抖，所以不足 MIN_MS 就压到 MIN_MS 再淡出。

   URL 开关：?boot=hold 强制不隐藏（截图 / 排查用），?boot=off 完全不显示。
   ============================================================ */
const BOOT_MIN_MS = 420;

function createBootTip(){
  const el   = document.getElementById('boot-tip');
  const mode = (new URLSearchParams(location.search).get('boot') || '').toLowerCase();
  const st = {
    mode: mode, tasks: 0, firstFrame: false, hidden: false,
    reason: null, startedAt: performance.now(), ms: null, timer: 0,
    /* 启动各阶段的毫秒时间戳。用户说「加载有点慢」时，第一个要回答的问题
       就是「慢在哪一段」—— 而这个页面里没有别的地方能回答它：
       build() 是一段同步代码，它内部的耗时在外部看不出来。
       读数用 __boot.state.marks，形如 [[123,'build+'], [456,'build-'], ...]。 */
    marks: []
  };
  function mark(what){ st.marks.push([+(performance.now() - st.startedAt).toFixed(0), what]); }
  mark('tip');
  if(mode === 'off' && el) el.style.display = 'none';

  function hide(reason){
    if(st.hidden) return;
    st.hidden = true;
    st.reason = reason;
    st.ms = +(performance.now() - st.startedAt).toFixed(1);
    mark('hide:' + reason);
    if(!el) return;
    el.classList.add('is-hidden');
    /* 过渡走完（0.6s）再 display:none —— 从这一刻起它连「参与逐像素比对」的
       资格都没有了。兜这一下是给不支持 transition 的老 WebView：那时 class
       换了却不会淡出，元素会一直悬在画面上（虽然不挡点击）。 */
    setTimeout(() => { el.style.display = 'none'; }, 700);
  }
  function settle(){
    if(st.mode === 'hold' || st.hidden) return;
    if(!(st.firstFrame && st.tasks === 0)) return;
    const wait = BOOT_MIN_MS - (performance.now() - st.startedAt);
    if(wait > 0){
      /* 定时器回调里**重新判一次「该退了吗」，而不是重算剩余时长再排一个定时器**。
         重算那版有个致命的自我重排：`wait = MIN - (now - startedAt)` 只要时钟
         不动（无头脚本把 performance.now 钉成常量、系统休眠唤醒、某些 WebView
         的时钟被降精度）就恒等于 MIN ⇒ 回调里再算还是 > 0 ⇒ 每 420ms 排一次、
         永远不退场。改成「到期就看条件」之后，提示的退场只依赖条件成立，
         不依赖时钟怎么走。 */
      if(!st.timer) st.timer = setTimeout(() => {
        st.timer = 0;
        if(st.mode === 'hold' || st.hidden) return;
        if(st.firstFrame && st.tasks === 0) hide('ready');
        else settle();                 // 还没就绪：等下一次 task/frame 通知再来
      }, wait);
      return;
    }
    hide('ready');
  }
  return {
    /* 登记一个异步资源：拿到返回的 done 之后，无论如何都要调一次
       （成功、失败、异常三条路都得调，否则提示永远不退）。 */
    task(){
      st.tasks++;
      mark('task+' + st.tasks);
      let called = false;
      return function(){
        if(called) return;            // 兜住「.then(onOk, onErr) 传同一个函数」被调两回
        called = true;
        st.tasks--;
        mark('task-' + st.tasks);
        settle();
      };
    },
    /* 首帧已经上屏 */
    frame(){ if(!st.firstFrame) mark('frame'); st.firstFrame = true; settle(); },
    mark: mark,
    hide: hide,
    get state(){
      return { mode: st.mode, tasks: st.tasks, firstFrame: st.firstFrame,
               hidden: st.hidden, reason: st.reason, ms: st.ms,
               marks: st.marks.slice(),
               /* 元素究竟在不在画面上：只看自己那个标记会被 CSS 骗过去，
                  再读一次计算样式 —— visibility 管「露不露脸」、display 管
                  「有没有盒子」，两者都得看（?boot=off 是直接 display:none）。 */
               visible: !!(el && !st.hidden
                           && el.style.display !== 'none'
                           && getComputedStyle(el).display !== 'none'
                           && getComputedStyle(el).visibility !== 'hidden') };
    }
  };
}

/* 让浏览器先把当前这一帧画出来，再继续跑后面的同步重活。
   单 rAF 不够：它的回调是「在下一帧开始之前」执行，回调里同步跑 build()
   会把那一帧一直推迟到构建结束 —— 提示照样看不见。
   双 rAF = 至少跨过一个完整绘制周期。再兜一个定时器：页面在后台
   （或容器刚建好还没显示）时 rAF 根本不派发，没有它就永远不会开始构建。 */
function nextPaint(){
  return new Promise(resolve => {
    let fired = false;
    const go = () => { if(fired) return; fired = true; resolve(); };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 150);
  });
}

function showBootError(e){
  BOOT.hide('error');              // 兜底界面要盖住提示，提示先退场，别两层颜色互相掺
  const box  = document.getElementById('boot-error');
  const body = document.getElementById('boot-error-body');
  const msg  = String((e && (e.message || e)) || '未知错误');
  const esc  = msg.replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
  const html = '<h2>画面起不来了</h2>'
    + '<p>这台设备的 WebGL 能力不足（或被系统临时收回），场景没法初始化。</p>'
    + '<p style="font-size:11px;color:#7a7a8a;word-break:break-all">' + esc + '</p>';
  if(box && body){ body.innerHTML = html; box.style.display = 'grid'; }
  else console.error('BOOT-FAIL ' + msg);
}

/* ============================================================
   3. 读取 scene.json + config.json 并搭建场景
   ============================================================ */
/* 加载提示的控制器。必须在下面这条 Promise 链**之前**建出来 ——
   showBootError() 会调 BOOT.hide()，而它可能在网上就出发（fetch 失败）。 */
const BOOT = createBootTip();
window.__boot = BOOT;             // 无头脚本断言「提示出现过、并且退掉了」用它

Promise.all([
  fetch('./scene.json').then(r => { if(!r.ok) throw new Error('scene.json ' + r.status); return r.json(); }),
  /* 调参面板：缺失/写坏都不该让场景挂掉 ⇒ 静默退回 scene.json 原值。
     默认读 ./config.json；想留几套预设就加 URL 参数，例如
     index.html?config=config-黄昏.json（路径相对 index.html）。 */
  fetch(new URLSearchParams(location.search).get('config') || './config.json')
    .then(r => r.ok ? r.json() : null)
    .catch(e => { console.warn('config.json 读取失败，全部使用 scene.json 原值：', e); return null; })
])
  .then(([cfg, conf]) => {
    CFG_EFF = applyConfig(cfg, conf);
    BOOT.mark('config');          // 两份 JSON 到手
    /* 先让浏览器把「梦境加载中」这一帧画出来，再做后面那段同步重活
       （见 nextPaint 的注释：双 rAF + 定时器兜底）。 */
    return nextPaint().then(() => {
      BOOT.mark('paint');         // 提示那一帧已经画出去，可以开始重活了
      /* build() 里最常炸的是 new THREE.WebGLRenderer()：上下文建不出来就直接抛，
         不接住的话页面是白的（见 showBootError 的注释）。 */
      try{ build(cfg); }
      catch(e){ console.error('BUILD-FAIL', e); showBootError(e); }
    });
  })
  .catch(err => {
    console.error('加载 scene.json 失败（请通过本地服务器打开，而非 file:// 直接双击）：', err);
    showBootError(err);
  });

/* ============================================================
   X. 时相 / 滤镜 / 雾档 面板
   ------------------------------------------------------------
   三行胶囊按钮，挂在左下角（画面左下角本来就是草地，不挡景）：
     时相  1-4   下午 / 清晨 / 日落 / 夜间      → atmos.apply(name)
     滤镜  5-9   四档梦核 + 原片               → postfx.set(name)
     雾    F     在「小雾 / 超大雾」之间切换    → atmos.toggleFog()
                 （near/far 由 atmos.update 在 2 秒内渐变过去，不是硬切）

   按钮**不写死在 HTML 里**，而是按 atmos.names / postfx.names 生成 ——
   以后加一档时相或滤镜，只要 XML 配置里多一项，面板自动跟着长，
   不会出现「配置加了、按钮忘了加」的两头维护。

   雾档按钮的文案显示的是「当前 → 点击后」，因为这一个按钮承担两个方向，
   只写「雾」会让人分不清现在是哪一档。
   ============================================================ */
function createSceneUI(atmos, postfx, flashHint, projector, step, AUD){
  const box = document.getElementById('scene-ui');
  if(!box) return null;
  const rowTime   = document.getElementById('ui-time');
  const rowFilter = document.getElementById('ui-filter');
  const rowFog    = document.getElementById('ui-fog');
  const rowProj   = document.getElementById('ui-projector');
  const hint = (typeof flashHint === 'function') ? flashHint : function(){};
  if(!atmos || !postfx || !rowTime || !rowFilter || !rowFog) return null;

  const mkBtn = (text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  /* ---- 时相 ---- */
  const timeNames = atmos.names;
  const timeBtns = {};
  timeNames.forEach((k, i) => {
    const b = mkBtn(atmos.labels[k] || k, () => {
      atmos.apply(k);
      syncTime();
      hint('时相 · ' + (atmos.labels[k] || k) + '（' + (atmos.fogHeavy ? '超大雾' : '小雾') + '）', 1100);
    });
    b.title = '时相：' + (atmos.labels[k] || k) + '（快捷键 ' + (i + 1) + '）';
    rowTime.appendChild(b);
    timeBtns[k] = b;
  });
  function syncTime(){
    timeNames.forEach(k => timeBtns[k].classList.toggle('active', k === atmos.state));
  }

  /* ---- 滤镜 ---- */
  const fxNames = postfx.names;             // [四档…, 'off']，'off' 是原片（旁路 composer）
  const fxBtns = {};
  fxNames.forEach((k, i) => {
    const b = mkBtn(postfx.shortLabels[k] || postfx.labels[k] || k, () => {
      postfx.set(k);
      syncFx();
      hint('滤镜 · ' + (postfx.labels[k] || k), 1100);
    });
    b.title = '滤镜：' + (postfx.labels[k] || k) + '（快捷键 ' + (i < 4 ? (5 + i) : 9) + '）';
    rowFilter.appendChild(b);
    fxBtns[k] = b;
  });
  function syncFx(){
    fxNames.forEach(k => fxBtns[k].classList.toggle('active', k === postfx.name));
  }

  /* ---- 雾档（near/far 在 fogAnimMs 内渐变过去；按钮闪一下只是点按反馈） ---- */
  const fogBtn = mkBtn('雾', () => {
    const heavy = atmos.toggleFog();
    syncFog();
    hint(heavy ? '超大雾·世界没了' : '雾档 · 小雾', 1100);
    fogBtn.classList.add('flash');
    setTimeout(() => fogBtn.classList.remove('flash'), 160);
  });
  fogBtn.title = '雾档：小雾 ⇄ 超大雾（快捷键 F）';
  rowFog.appendChild(fogBtn);
  function syncFog(){
    fogBtn.textContent = atmos.fogHeavy ? '超大雾 → 小雾' : '小雾 → 超大雾';
    fogBtn.classList.toggle('active', atmos.fogHeavy);
  }

  syncTime(); syncFx(); syncFog();

  /* ---- 夜间投影按钮 ----
     这里不是单纯的「开/关幕布」，而是进入「靠在床上看电视」的观赏位姿：
     点击「看电视」→ 点亮幕布、镜头缓缓飞到床上、隐藏梯子；
     点击「复位」→ 镜头飞回、重新显示梯子。 */
  let projectorOn = false;
  let projectorAvailable = false;
  let isWatching = false;
  /* ⚠ 播放/复位期间**不要**去碰三个玩法按钮的 disabled ——
     那是状态机（setupModes 的 setTVMode）在管：看电视会从三条路退出
     （点复位、切非夜间时相、按 R 复位），锁必须挂在状态上，不该挂在这里。 */
  function tvAudio(on){                          // 视频声音跟着幕布一起开合
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
    tvAudioUnlocked = false;
    clearTimeout(tvAudioTimer);
  }
  /* 解锁电视声音：只在视频真的 playing 之后调（见 projBtn 回调里的注释）。 */
  let tvAudioUnlocked = false, tvAudioTimer = 0;
  const unlockTvAudio = ()=>{
    if(tvAudioUnlocked) return;
    tvAudioUnlocked = true;
    clearTimeout(tvAudioTimer);
    tvAudio(true);
  };

  const projBtn = mkBtn('看电视', () => {
    if(!projectorAvailable || !step) return;
    if(step.tvActive() && !isWatching) return;   // 飞行途中忽略点击
    if(isWatching){
      closeProjector();                          // 幕布淡出 + 停视频 + 收声音
      step.tvEnter(false, ()=>{ isWatching = false; syncProj(); });
      hint('已退出看电视 · 梯子回来了', 1100);
    } else {
      /* 声音必须在**这次点击**里开：WebAudio 增益链路要用户手势才起得来
         （createMediaElementSource 接上后音频只走这条图，上下文不上就是静音）。 */
      if(!projectorOn){
        /* 幕布一亮就把 BGM 让给视频声（2026-10-05「播视频时就要关掉正在播的音乐」）：
           放在**这次点击**里做，而不是 4.7s 飞行动画落地后 —— 用户说的是「播视频时」，
           幕布出现就该静下来。bgmBefore 也在这里记，复位靠它决定要不要接回来。 */
        try{ if(AUD){ const st = AUD.state;
                      bgmBefore = (st === 'playing' || st === 'proc');
                      /* ★ 无条件 pause()：早先写成 if(bgmBefore) AUD.pause()，
                         音乐还在 loading / proc 那几拍里就会整个跳过，人听着 BGM
                         没停。pause() 自己在状态不对时是空操作，多调一次无所谓。 */
                      if(AUD.pause) AUD.pause(); } }catch(e){ console.warn('[cloud-ladder] BGM 暂停失败:', e); }
        projectorOn = true;
        if(projector && projector.userData.setOn) projector.userData.setOn(true);
      }
      /* ⚠ 别在这里直接 tvAudio(true)：此刻视频还没 playing。iOS 上「先 unmute +
         再接 Web Audio 增益链」容易把播放掐在第一帧（model.js tvAudioOn 的注释有详述）。
         改成：先静音起播，等 projector 抛 onFirstPlay（真的动起来了）再解锁声音。
         兜底 2.5 秒 —— 声音晚一点无所谓，画面停着才是致命的。 */
      tvAudioUnlocked = false;
      clearTimeout(tvAudioTimer);
      tvAudioTimer = setTimeout(()=>{ if(!tvAudioUnlocked) unlockTvAudio(); }, 2500);
      step.tvEnter(true, ()=>{ isWatching = true; syncProj(); });
      hint('靠在床上看电视 · 拖屏转头 / WASD 走动', 1600);
    }
  });
  projBtn.title = '夜间专属：靠在床上看电视（第一人称：拖屏转头 · WASD/方向键走动） / 退出看电视（快捷键 P）';
  if(rowProj) rowProj.appendChild(projBtn);
  function syncProj(){
    projBtn.textContent = isWatching ? '退出看电视' : '看电视';
    projBtn.classList.toggle('active', isWatching);
  }
  function setProjectorAvailable(v){
    projectorAvailable = !!v;
    if(rowProj) rowProj.style.display = projectorAvailable ? 'flex' : 'none';
    if(!projectorAvailable){
      isWatching = false;
      projectorOn = false;
      tvAudio(false);
      if(projector && projector.userData.setOn) projector.userData.setOn(false);
      syncProj();
    }
  }

  /* ---- 快捷键 ---- */
  function onKey(e){
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key;
    if(k >= '1' && k <= '4'){
      const name = timeNames[+k - 1];
      if(name){ atmos.apply(name); syncTime(); hint('时相 · ' + (atmos.labels[name] || name), 900); e.preventDefault(); }
      return;
    }
    if(k >= '5' && k <= '9'){
      const name = fxNames[+k - 5];
      if(name){ postfx.set(name); syncFx(); hint('滤镜 · ' + (postfx.labels[name] || name), 900); e.preventDefault(); }
      return;
    }
    if(k === '0'){
      postfx.set('off'); syncFx(); hint('滤镜 · 原片', 900); e.preventDefault();
      return;
    }
    if(k === 'f' || k === 'F'){
      const heavy = atmos.toggleFog(); syncFog();
      hint(heavy ? ' 超大雾 · 世界没了 ' : '雾档 · 小雾', 900); e.preventDefault();
    }
    if(k === 'p' || k === 'P'){
      if(projectorAvailable){ projBtn.click(); e.preventDefault(); }
    }
  }
  addEventListener('keydown', onKey);

  return {
    el: box,
    sync(){ syncTime(); syncFx(); syncFog(); },
    timeNames, fxNames,
    click(name){ if(timeBtns[name]) timeBtns[name].click(); else if(fxBtns[name]) fxBtns[name].click(); },
    toggleFog(){ fogBtn.click(); },
    setProjectorAvailable,
    closeProjector(){ closeProjector(); },        // 复位用（tvHooks.closeProjector 转发进来）
    dispose(){ removeEventListener('keydown', onKey); }
  };
}

function build(cfg){
  BOOT.mark('build+');          // 启动耗时剖面（读数：__boot.state.marks）
  /* 地形谷地 / 远山参数（必须在任何 terrainHeight() 调用之前注入） */
  RT.mound  = (cfg.terrain && cfg.terrain.mound ) ? cfg.terrain.mound  : null;
  RT.ranges = (cfg.terrain && cfg.terrain.ranges) ? cfg.terrain.ranges : null;
  RT.micro  = (cfg.terrain && cfg.terrain.micro ) ? cfg.terrain.micro  : null;
  RT.broad  = (cfg.terrain && cfg.terrain.broad ) ? cfg.terrain.broad  : null;

  /* 渲染器 */
  const RM = cfg.renderer || {};
  const MB = RM.mobile || {};
  const useMobile = AUTO_MOBILE && MB.enabled !== false;
  if(useMobile){
    if(MB.quality      !== undefined) RT.quality   = MB.quality;
    if(MB.pixelRatioMax!== undefined) PR_CAP    = MB.pixelRatioMax;
    if(MB.cloudPuffs   !== undefined) RT.cloudQ   = MB.cloudPuffs;
    if(MB.shadowMapSize!== undefined) SHADOW_SZ = MB.shadowMapSize;
  }
  /* 可视视口尺寸。**优先 visualViewport** —— 它给的是真实可见区域
     （不含被地址栏 / 底部 home 指示条 / 安全区吃掉的部分），而 innerWidth/innerHeight
     在 iOS 横屏与 standalone 全屏下会给出偏大的布局视口，
     两者不一致时 canvas 就铺不满（2026-10-06「横版上面空一截」）。
     CSS 那边已改成 fixed inset:0 + 100%，所以这里 setSize 的第三个参数传 false：
     **只设 drawing buffer，不写内联 style**，免得跟 CSS 打架。 */
  const viewportSize = ()=>{
    const vv = window.visualViewport;
    const w = Math.max(1, Math.round(vv ? vv.width  : innerWidth));
    const h = Math.max(1, Math.round(vv ? vv.height : innerHeight));
    return { w, h };
  };
  const _vp0 = viewportSize();

  const renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setSize(_vp0.w, _vp0.h, false);
  renderer.setPixelRatio(Math.min(devicePixelRatio, useMobile ? PR_CAP : ((RM.pixelRatioMax !== undefined) ? RM.pixelRatioMax : 2)));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RM.toneExposure;
  if(RM.shadows){ renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
  document.getElementById('app').appendChild(renderer.domElement);

  /* 场景 / 天空 / 雾 */
  const scene = new THREE.Scene();
  if(cfg.sky && cfg.sky.background) scene.background = new THREE.Color(cfg.sky.background);
  if(cfg.scene.fog) scene.fog = new THREE.Fog(new THREE.Color(cfg.scene.fog.color), cfg.scene.fog.near, cfg.scene.fog.far);

  /* 相机 */
  const cam = cfg.camera;
  const camera = new THREE.PerspectiveCamera(cam.fov, _vp0.w/_vp0.h, cam.near, cam.far);
  camera.position.set(cam.position[0], cam.position[1], cam.position[2]);

  /* 控制器。
     焦点可以是 [x,y,z]，也可以是具名锚点（'ladderMid' / 'bed' / …）。
     具名锚点要等 rig 造好才算得出（梯中点取决于梯长/倾角/床高），
     所以这里先解析一次（数组能过、锚点返回 null 保持默认），
     字符串留到 build() 末尾、setupModes 之前再解析一次。 */
  const controls = new OrbitControls(camera, renderer.domElement);
  const ct0 = resolveViewTarget(cfg.controls.target, null, cfg);
  if(ct0) controls.target.set(ct0[0], ct0[1], ct0[2]);
  controls.enableDamping = true;
  controls.dampingFactor = cfg.controls.dampingFactor;
  controls.minDistance = cfg.controls.minDistance;
  controls.maxDistance = cfg.controls.maxDistance;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(cfg.controls.maxPolarAngleDeg);
  controls.update();

  /* 灯光 */
  const L = cfg.lights;
  /* 三盏灯都留引用 —— 时相模块要按「下午/清晨/日落/夜间」改它们的颜色与强度 */
  const hemi = new THREE.HemisphereLight(new THREE.Color(L.hemisphere.sky), new THREE.Color(L.hemisphere.ground), L.hemisphere.intensity);
  scene.add(hemi);
    RT.sun = new THREE.DirectionalLight(new THREE.Color(L.sun.color), L.sun.intensity);
  RT.sun.position.set(L.sun.position[0], L.sun.position[1], L.sun.position[2]);
  if(L.sun.shadow){
    RT.sun.castShadow = true;
    RT.sun.shadow.mapSize.set(SHADOW_SZ || L.sun.shadow.mapSize, SHADOW_SZ || L.sun.shadow.mapSize);
    const sc = L.sun.shadow.camera;
    RT.sun.shadow.camera.left=sc.left; RT.sun.shadow.camera.right=sc.right;
    RT.sun.shadow.camera.top=sc.top; RT.sun.shadow.camera.bottom=sc.bottom;
 
    RT.sun.shadow.camera.near = (sc.near !== undefined) ? sc.near : 0.5;
    RT.sun.shadow.camera.far  = sc.far;
    if(L.sun.shadow.bias !== undefined) RT.sun.shadow.bias = L.sun.shadow.bias;
    if(L.sun.shadow.normalBias !== undefined) RT.sun.shadow.normalBias = L.sun.shadow.normalBias;
    RT.sun.shadow.camera.updateProjectionMatrix();
  }
  scene.add(RT.sun);
  const ambient = new THREE.AmbientLight(new THREE.Color(L.ambient.color), L.ambient.intensity);
  scene.add(ambient);
  const SUN_DIR = new THREE.Vector3(L.sun.position[0], L.sun.position[1], L.sun.position[2]).normalize();

  /* 天空渐变穹顶（含噪声贴图）。换时相就是改它的 uniform 颜色，
     所以这里必须留着引用 —— 重建一整个穹顶既贵又没必要。 */
  const skyMesh = cfg.sky ? buildSky(scene, cfg.sky) : null;

  /* 体积云 */
  const cloudGrp = buildCloud(scene, cfg.cloud, SUN_DIR);
  const cloudFade   = (cfg.cloud && cfg.cloud.nearFade   !== undefined) ? cfg.cloud.nearFade   : 2.5;
  const cloudInside = (cfg.cloud && cfg.cloud.insideFade !== undefined) ? cfg.cloud.insideFade : true;
  /* 云「飘到电视上面」的缓动状态。
     看电视时（tvState 为真，且直到点复位之前都保持）云慢慢横向挪到幕布正上方；
     复位后再慢慢挪回原来的位置。挪动用的是整组平移 + 同步改写 cloud.center
     —— 云片本身是按绝对坐标生成的，只改 center 不会让云动，必须一起搬组；
     而戳云 / 近处淡出都读 C.center，所以 center 要跟着一起改，否则交互会错位。
     系数刻意给得很小（rate 0.22 ⇒ 时间常数约 4.5s），「慢慢移」才成立。 */
  const cloudHome = { x: cfg.cloud.center[0], z: cfg.cloud.center[2] };
  const cloudHomeY = cloudGrp.position.y;      // 云整组原始高度（降 2m 的基准）
  /* 云飞到幕布上方时要**往下压 2 米**（用户 2026-10-05）：原来只是平着挪到幕布正上方，
     云离布太远，夜里看着像「天上一片白」而不是「飘到幕布跟前」。压下来才有贴上去的近感。
     想改幅度：scene.json / config.json 写 projector.cloudDrop。 */
  const CLOUD_DROP = +(cfg.projector && cfg.projector.cloudDrop !== undefined
                       ? cfg.projector.cloudDrop : 2);
  const cloudGoal = { x: (cfg.projector && cfg.projector.screen ? cfg.projector.screen.position[0] : cloudHome.x),
                      z: (cfg.projector && cfg.projector.screen ? cfg.projector.screen.position[2] : cloudHome.z) };
  let cloudShift = 0;

  /* 远处天空的大 billboard 云 */
  if(cfg.sky && cfg.sky.farClouds) cfg.sky.farClouds.forEach(g => buildFarClouds(scene, g));

  /* 远景环山（多层剪影山脊带 → 层峦叠嶂） */
  if(cfg.sky && cfg.sky.ridgeBands) cfg.sky.ridgeBands.forEach(b => buildRidgeBand(scene, b));

  BOOT.mark('sky');
  /* 地形（含地表草地贴图；各向异性上限由渲染器能力决定） */
  const terrain = buildTerrain(scene, cfg.terrain, renderer.capabilities.getMaxAnisotropy());

  /* 无草区（床的位置）尺寸必须在种草之前定好 —— 幂等，配置里没给就用床尺寸推 */
  resolveAvoid(cfg);

  BOOT.mark('terrain');
  /* 草地（需要共享的 uTime 供风动着色器使用） */
  const uTime = { value: 0 };
  const grass = buildGrass(cfg.grass, uTime);
  scene.add(grass);

  /* 中景草丛（地面细节） */
  const tufts = buildTufts(cfg.grass, uTime);
  if(tufts) scene.add(tufts);

  /* 薰衣草（成片参杂在草地中） */
  const lavender = buildLavender(cfg.grass, uTime);
  if(lavender) scene.add(lavender);

  /* 白菊花：床边一小簇 */
  const daisies = buildDaisies(cfg, uTime);
  if(daisies) scene.add(daisies);

  BOOT.mark('veg');
  /* 床 */
  const bed = buildBed(cfg.bed);
  scene.add(bed);
  /* GLB 床模型：加载成功后替换程序化床的外观（行走/碰撞数据不变）；
     加载完再把床侧高光吸附到真实表面上。
     床底暗部必须等在 GLB 之后再做 —— 否则量到的是程序化床的尺寸，
     草环会跟真实床沿错开一截。 */
  const spawnBedShadow = ()=>{
    const g = buildBedShadow(cfg, uTime, bed);
    if(g) scene.add(g);
  };
  if(cfg.bed.model){
    /* 床 GLB 是启动路径上唯一一个「异步且看得见」的资源：它到之前显示的是
       程序化床，到了之后整张床换一次。加载提示要一直挂到它落地，
       否则用户会看见床在自己眼前「啪」地换掉。 */
    const bedReady = BOOT.task();
    loadBedModel(cfg.bed, bed)
      .then(ok => { if(ok && glints) snapGlintsToBed(glints, bed, cfg); spawnBedShadow(); })
      .catch(e => { console.warn('床 GLB 加载失败，保留程序化床：', e); spawnBedShadow(); })
      .then(bedReady, bedReady);   // 成功/失败/抛异常三条路都必须销账，否则提示不退
  } else spawnBedShadow();

  BOOT.mark('bed');
  /* 梯子（梯脚可吸附到床面：bottom[1] 写 null 即取 bedTopY） */
  const bedTopY = bed.position.y + bedSurfaceHeight(cfg.bed);
  const ladder = buildLadder(cfg.ladder, bedTopY);
  scene.add(ladder);

  /* 蝴蝶：床边绕飞（billboard，逐帧在 CPU 上写实例矩阵） */
  const butterflies = buildButterflies(cfg, bed, camera);
  if(butterflies) scene.add(butterflies);

  /* 萤火虫：夜间替代蝴蝶，在床周围成群忽明忽暗（默认隐藏，切夜间由 atmos.onPhase 打开） */
  const fireflies = buildFireflies(cfg, bed, camera);
  if(fireflies) scene.add(fireflies);

  /* 闪烁高光：床板侧面 + 梯杆（锚点挂在各自局部坐标，父级带旋转也贴得住） */
  bed.updateMatrixWorld(true); ladder.updateMatrixWorld(true);
  const glints = buildGlints(cfg, bed, ladder, camera);
  if(glints) scene.add(glints);

  /* 夜间投影幕布：默认关闭，切到夜间再由 UI/时相钩子打开 */
  const projector = buildProjectorScreen(cfg);
  if(projector) scene.add(projector);
  /* 电视视频回退时把**原因**显示到提示条上（2026-10-06）。
     之前 failToCanvas 只 console.warn，而 <video> 是 createElement 出来的、
     页面里摸不到，出问题时用户只看到「还是默认画面」，谁也猜不出是加载失败、
     超时还是解码不支持。有了这行，下次不播 —— 提示条会直接写出原因。 */
  /* 「看电视时 bloom 提高 30%」（2026-10-06 用户要求）。挂在 projector 的 setOn 上
     ⇒ 点按钮 / 复位 / 切时相三条路径都自动跟上；增益值走 setBloomGain（乘数）而不是
     改夜间档的 strength，因为时相覆盖每次切档都会把 strength 写死。 */
  const TV_BLOOM_GAIN = (cfg.projector && cfg.projector.bloomGain !== undefined)
                     ? +(cfg.projector.bloomGain) : 1.3;
  if(projector) projector.userData.onSetOn = (on)=>{
    try{ postfx.setBloomGain(on ? TV_BLOOM_GAIN : 1); }catch(_){}
  };

  /* 视频真的开始播了 ⇒ 现在才解锁声音（iOS 上 unmute 必须晚于 playing）。 */
  if(projector) projector.userData.onFirstPlay = ()=>{ try{ unlockTvAudio(); }catch(_){} };
  if(projector) projector.userData.onVideoFallback = (why)=>{
    try{ if(window.__hintFlash) window.__hintFlash('电视视频没出来（' + why + '）· 正在重试', 3200); }catch(_){}
  };

  /* 行走 rig：床的可站立矩形（含 rotationY 旋转）+ 梯子的轴向几何。
     世界坐标，必须带上床的整体缩放 —— 否则床放大了、「可站立矩形」还是旧的，
     人一走到放大的床沿外面就直接掉下去。 */
  const { bw, bd } = bedHalfLocal(cfg);
  const [fsx, , fsz] = bedScaleTriple(cfg.bed);
  const bth = cfg.bed.rotationY || 0;
  const rig = {
    bed: {
      x: bed.position.x, z: bed.position.z, top: bedTopY,
      rx: Math.abs(bw*fsx*Math.cos(bth)) + Math.abs(bd*fsz*Math.sin(bth)),
      rz: Math.abs(bw*fsx*Math.sin(bth)) + Math.abs(bd*fsz*Math.cos(bth))
    },
    ladder: ladder.userData.rig
  };

  BOOT.mark('rig');
  /* 相机焦点落位（具名锚点在这里才算得出来）。
     必须在 setupModes 之前 —— 它构造时会 copy(controls.target) 存成
     「自由模式切回来时要恢复的视角」，晚了就存到旧值。
     update() 只重算朝向：相机的世界位置不变，改的只是「看向哪」。 */
  const ctv = resolveViewTarget(cfg.controls.target, rig, cfg);
  if(ctv){ controls.target.set(ctv[0], ctv[1], ctv[2]); controls.update(); }

  /* 梦核 BGM：启动随机抽一首就放（被自动播放策略拦下就先挂着，
     第一次点屏幕/按键时自动接上）。碰云的星铃、落到床上那声「噗」也走它。
     ⚠ 必须建在 setupModes **之前**：漫游的 leap（从梯顶翻下床）要在落地那一帧
     发声，那个调用点在 setupModes 内部 —— 晚建的话它拿不到 AUD。 */
  const AUD = createAudio(cfg.audio);

  /* 相机模式（自由 / 漫游 / 步行） */
  camera.rotation.order = 'YXZ';
  /* 复位要从 setupModes 那头关幕布 / 切时相，可这两个出口一个藏在 createSceneUI 内部
     （closeProjector）、一个要到 build 后面才建出来（atmos）。先挂个空壳，
     等走到那两步再填真身（见下方 ATMOS-FAIL 与 window.__sceneUI 那两处）。 */
  const tvHooks = { applyPhase: null, closeProjector: null, syncUi: null, defaultPhase: 'afternoon' };
  const step = setupModes(cfg, camera, controls, renderer, rig, AUD, ladder, tvHooks);

  /* 碰云：点击戳一下 + 钻进云里让云让开（漫游爬到梯顶就正好在云里） */
  const pokeStep = setupCloudPoke(scene, cloudGrp, camera, renderer.domElement, cfg, AUD);

  /* 屏幕后处理：bloom + 梦核四档调色。
     `off` 档不是把参数调成 0，而是整个 composer 旁路（直接 renderer.render 上屏）——
     这样「原片」就是真正的原片，也让低端机能一键退回最快路径。
     ⚠ 必须建在 atmosphere **之前**：时相要往它里面写「本档的 bloom 阈值」
     （亮雾的清晨和暗的夜间不可能共用一套阈值，见 postfx.applyBloom）。 */
  const postfx = createPostFX(renderer, scene, camera, cfg);

  /* 时相（下午/清晨/日落/夜间）+ 月亮星空 + 雾档切换。
     必须在所有构建函数之后创建：云的乘色登记表要已经填满。
     创建时会 apply('afternoon')，而「下午」是空覆盖 ⇒ 等价于什么都不做。 */
  let atmos;
  try {
    atmos = createAtmosphere({
      scene, renderer, sun: RT.sun, hemi, ambient, sky: skyMesh,
      tintCloud: TINT_CLOUD, tintBg: TINT_BG, cfg,
      bloomSet: postfx,         // ← 时相改 bloom 阈值的出口
      /* 云的「背光面压暗 + 暗面混环境色」：atmosphere 在 setTint **之后**回调这里，
         给的是本档的平行光位置（夜间那盏就是月亮）与本档的 ambient 颜色。
         没写 cloudShade 的时相（下午）⇒ 权重恒为 0 ⇒ 颜色一个字节都不动。 */
      paintCloud: (sunPos, st, envCol) => { shadeCloud(sunPos, st && st.cloudShade, envCol); }
    });
  } catch(e){ console.error('ATMOS-FAIL ' + (e && e.stack ? e.stack : e)); throw e; }

  /* 复位切「下午」的出口（tvHooks.applyPhase 见 resetView 末尾那几行） */
  tvHooks.applyPhase = (name) => { try{ if(atmos) atmos.apply(name); }catch(_){} };
  tvHooks.defaultPhase = ((atmos && atmos.names && atmos.names[0]) || 'afternoon');

  /* 时相交互钩子：切到夜间 → 收起蝴蝶、放出萤火虫、显示投影按钮；其余时相反之。
     投影幕布只由按钮显隐控制：钩子把「夜间可用」状态记下来，按钮据此切开关。
     初始 apply 在 createAtmosphere 内部已跑过一次（那时 onPhase 还没挂上，是空操作），
     所以挂上钩子后，再手动同步一次初始可见性。 */
  atmos.onPhase = (name) => {
    const night = (name === 'night');
    if(butterflies) butterflies.visible = !night;
    if(fireflies)  fireflies.visible  = night;
    if(window.__sceneUI) window.__sceneUI.setProjectorAvailable(night);
    /* 离开夜间时，如果正在「看电视」，自动复位并显示梯子（幕布一并淡出关掉） */
    if(!night){
      closeProjector();
      if(window.__rig && window.__rig.tvEnter) window.__rig.tvEnter(false);
    }
  };
  { const night = (atmos.state === 'night');
    if(butterflies) butterflies.visible = !night;
    if(fireflies)  fireflies.visible  = night; }

  /* 时相 / 滤镜 / 雾档 面板。放在最后：它要读 atmos.names、postfx.names。
     flashHint 是 setupModes 里的提示条，这里借来给按钮点按一点文字反馈。
     投影按钮也在这里生成，需要 projector 引用。 */
  /* ⚠ AUD 必须显式传进来：createSceneUI 和 build 是同一模块里的**并列**顶层函数，
     不是嵌套关系 —— createSceneUI 里直接写 `if(AUD)` 会 ReferenceError
     （2026-10-06 实测：BGM 一点没停，那行还套在 try/catch 里被吞了）。
     同理，setupModes / createSceneUI 之间共享的状态（bgmBefore）得提到模块顶层。 */
  const sceneUI = createSceneUI(atmos, postfx, window.__hintFlash, projector, step, AUD);
  window.__sceneUI = sceneUI;
  /* resetView（在 setupModes 里）要从外面关幕布：closeProjector 是 createSceneUI 内部的函数，
     这里转发一份出去 —— 千万别在 setupModes 里按名字直接调它（会 ReferenceError）。
     同步时相/滤镜/雾档按钮的高亮也一并交给 UI 的 sync()。 */
  tvHooks.closeProjector = () => { try{ if(window.__sceneUI && window.__sceneUI.closeProjector) window.__sceneUI.closeProjector(); }catch(_){} };
  tvHooks.syncUi = () => { try{ if(window.__sceneUI && window.__sceneUI.sync) window.__sceneUI.sync(); }catch(_){} };

  /* 调试出口：场景 / 渲染器 / 太阳（核对阴影开关与绘制统计；无头脚本也用它） */
  window.__dbg = { THREE, scene, renderer, camera, sun: RT.sun, controls, terrain, grass, tufts, lavender, bed, ladder,
    daisies, butterflies, fireflies, glints, cloud: cloudGrp, audio: AUD, postfx, atmos, sceneUI, projector, hemi, ambient, sky: skyMesh,
    config: CFG_EFF,   // config.json 里真正生效的值（调参后用它核对）
    /* 云的背光面压暗 + 暗面混环境色（调试/验证出口）：
       shadeCloud(dir, S, env) —— 强制重算一遍。
         · 只给 dir（或不给）⇒ 用本档的 cloudShade + 本档的 ambient 颜色（= 正常路径）；
         · 显式给 S（哪怕 null / {backDark:0}）⇒ 用它，且**不改配置** ——
           这是 A/B 的关键：同一份代码、同一帧基线，只切这一个系数，
           差异就只能来自它（比跨版本对比干净得多）。
           S = null / {backDark:0} 正好逐位复现「没有压暗」的改前状态
           （backMix 不给 ⇒ 不混环境色 ⇒ 颜色是逐位复制）。
         · env 不给就用当前 ambient.color。 */
    shadeCloud(dir, S, env){
      const stt = (atmos && atmos.state && atmos.states) ? atmos.states[atmos.state] : null;
      const use = (arguments.length > 1) ? S : (stt && stt.cloudShade);
      const e   = (arguments.length > 2) ? env : (ambient ? ambient.color : null);
      return shadeCloud(dir || (RT.sun ? RT.sun.position : null), use, e);
    },
    cloudShadeStats,
    terrainHeight,     // 采样地形高度（工具脚本定位物体时常用）
    uTime,             // 场景时钟句柄。把 uTime.value 直接改掉 = 跳到任意场景时刻，
                       // 这是验证「周期性动画」的钥匙：无头下 dt 被钳到 0.1s、帧率又只有
                       // 零点几，靠等待推进的话一个 20 秒周期要等好几分钟才走完。
                       // 用法：`__dbg.uTime.value = 35` 之后等一帧，动画即按 t=35 求解。
    get time(){ return uTime.value; },   // 场景累计时间（秒）。注意无头帧率极低、
                                         // dt 被钳到 0.1s，所以它远慢于墙钟时间，
                                         // 验证动画要按它算，不能按等了多久算
    get quality(){ return { mobile: AUTO_MOBILE, plantQ: RT.quality, cloudQ: RT.cloudQ, pr: renderer.getPixelRatio(),
                            puffs: RT.puffN, shadowMap: RT.sun ? RT.sun.shadow.mapSize.x : 0 }; },
    /* 碰云的两个验证入口（无头脚本用它，控制台也能用）：
       poke      —— 在某点戳一下，返回被影响的云片数
                    （opt.fromCamera = 以镜头所在点为中心，即「人钻进云里」那种）
       cloudStat —— 现在有几片正被推着、最大位移多少、历史峰值多少、累计戳了几次 */
    poke(x, y, z, opt){
      const o = opt || {};
      const p = o.fromCamera ? camera.position : new THREE.Vector3(x, y, z);
      return pokeStep.doPoke(p, o);
    },
    cloudStat(){
      const list = cloudGrp.userData.puffs || [];
      let act = 0, max = 0, sum = 0, peak = 0;
      for(let i=0;i<list.length;i++){
        const it = list[i];
        const d = it.off.length();
        if(d > 1e-5){ act++; if(d > max) max = d; sum += d; }
        if(it.peak > peak) peak = it.peak;
      }
      const st = pokeStep.stats;
      return { active: act, max: +max.toFixed(4), sum: +sum.toFixed(4), peak: +peak.toFixed(4),
               pokes: st.pokes, taps: st.taps, contacts: st.contacts, lastN: st.lastN,
               trace: st.trace.slice() };
    },
    cloudPeakReset(){
      const list = cloudGrp.userData.puffs || [];
      for(let i=0;i<list.length;i++) list[i].peak = 0;
    },
    cloudHit(cx, cy){
      const h = pokeStep.hitAt(cx, cy);
      return h ? { x: +h.point.x.toFixed(3), y: +h.point.y.toFixed(3), z: +h.point.z.toFixed(3) } : null;
    },
    pokeCfg: pokeStep.cfg };

  BOOT.mark('build-');
  /* 动画循环 */
  const clock = new THREE.Clock();
  /* running = 渲染循环的闸门。什么时候关：页面不可见（切到后台 / 锁屏）、
     WebGL 上下文丢失。performance-budget.md §4 要求页面隐藏时停掉 rAF，
     §5 要求上下文丢失时停止渲染并给出可理解的提示，而不是白屏或无限重建。 */
  let running = true, rafId = 0;
  function resume(){
    if(running) return;
    running = true;
    /* 关键：先把暂停期间挂着的那次 rAF 作废。
       否则「可见时补发的那一帧」和这里新起的循环会各拍一张，之后每帧翻倍。 */
    cancelAnimationFrame(rafId);
    clock.getDelta();          // 丢掉暂停期间累积的时间差，回来不会「跳一大步」
    animate();
  }
  function animate(){
    if(!running) return;
    rafId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);   // 钳制：切标签页/低帧率时不让一帧跳太远
    uTime.value += dt;
    if(butterflies) butterflies.userData.update(uTime.value);
    if(fireflies) fireflies.userData.update(uTime.value);
    if(glints) glints.userData.update(uTime.value);
    if(projector) projector.userData.update(dt, uTime.value);
    if(cloudGrp){
      /* 云随「看电视」**快速**沉到幕布上方（原来 dt*0.22 ⇒ 时间常数 4.5s，慢得像在漂；
         现在 dt*1.5 ⇒ 约 0.66s 到位），点复位就按同一条曲线飘回原位。 */
      const want = (step.tvState ? step.tvState() : false) || (window.__rig && window.__rig.tvState);
      cloudShift += ((want ? 1 : 0) - cloudShift) * Math.min(1, dt*1.5);
      const cx = cloudHome.x + (cloudGoal.x - cloudHome.x)*cloudShift;
      const cz = cloudHome.z + (cloudGoal.z - cloudHome.z)*cloudShift;
      cloudGrp.position.x = cx - cloudHome.x;
      cloudGrp.position.z = cz - cloudHome.z;
      cloudGrp.position.y = cloudHomeY - CLOUD_DROP*cloudShift;   // 边飞边压 2m
      if(cfg.cloud && cfg.cloud.center){
        cfg.cloud.center[0] = cx;
        cfg.cloud.center[2] = cz;
      }
      /* 云的不可见拾取体（戳云用的椭球代理）也要跟着挪，否则它钉在旧位置 */
      if(pokeStep && pokeStep.pick){
        const pk = pokeStep.pick;
        pk.position.x = cx; pk.position.z = cz;
        pk.position.y = -CLOUD_DROP*cloudShift;  // pick 挂在 scene 上（绝对坐标），跟着一起沉
        pk.updateMatrix(); pk.updateMatrixWorld(true);
      }
      updateCloudFlow(cloudGrp, uTime.value, dt);
      updateCloudFade(cloudGrp, camera, cloudFade, cloudInside, cfg.cloud);
    }
    pokeStep(dt, uTime.value);
    if(atmos && typeof atmos.update === 'function') atmos.update(dt);   // 雾的 near/far 渐变
    step(dt);
    if(postfx.enabled) postfx.render(dt);
    else renderer.render(scene, camera);
    /* 首帧已经上屏 ⇒ 加载提示的两条隐藏条件之一达成（另一条是床 GLB）。
       放在这里而不是 animate() 开头：只有真的调过 render 才算「画出东西了」。 */
    BOOT.frame();
  }
  animate();

  /* 页面不可见就停。注意只停渲染，不动 <audio> —— BGM 是这个小工具的一半，
     后台继续放才是对的（容器也没有后台播放限制）。 */
  document.addEventListener('visibilitychange', ()=> {
    if(document.hidden){ running = false; return; }
    resume();
  });

  /* WebGL 上下文丢失 / 恢复：真机切后台久了、显存吃紧时会遇到 */
  const glcv = renderer.domElement;
  glcv.addEventListener('webglcontextlost', e => {
    e.preventDefault();                    // 阻止默认「永久丢失」，之后才会派发 restored
    running = false;
    if(!document.getElementById('gl-lost')){
      const d = document.createElement('div');
      d.id = 'gl-lost';
      d.textContent = '画面渲染被系统中断，正在恢复…';
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:14%;text-align:center;color:#fff;'
        + 'font:600 13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;'
        + 'text-shadow:0 2px 12px rgba(60,30,90,.65);pointer-events:none;z-index:40;';
      document.body.appendChild(d);
    }
  }, false);
  glcv.addEventListener('webglcontextrestored', ()=> {
    const d = document.getElementById('gl-lost');
    if(d && d.parentNode) d.parentNode.removeChild(d);
    resume();
  }, false);

  /* 无头脚本用它断言「隐藏时确实停了、回来只有一条循环」 */
  window.__loop = { get running(){ return running; }, get raf(){ return rafId; }, resume };

  /* ⚠ iOS 从竖屏切横屏时，单靠 resize 常常不够：地址栏收起的动画会让它
     触发好几次且时机偏早，安全区变化更是只在 orientationchange 里报。
     三个都挂上，尺寸统一走 visualViewport。 */
  const applyViewport = ()=>{
    const { w, h } = viewportSize();
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);   // false = 别写内联样式，铺满交给 CSS
    postfx.setSize();                 // composer 的 RT 与各 pass 都要跟着重建
  };
  addEventListener('resize', applyViewport);
  addEventListener('orientationchange', ()=>{ setTimeout(applyViewport, 120); setTimeout(applyViewport, 400); });
  if(window.visualViewport) window.visualViewport.addEventListener('resize', applyViewport);
  /* 屏幕常亮工具条/旋转时页面可能短暂失焦，回来补一次 */
  addEventListener('pageshow', applyViewport);
}
