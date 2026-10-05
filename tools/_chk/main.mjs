import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAudio } from './audio.js?v=55';
import { createPostFX } from './postfx.js';
import { createAtmosphere } from './atmosphere.js';
import {
  RT, terrainHeight, TINT_CLOUD, TINT_BG,
  buildSky, buildRidgeBand, buildTerrain, buildFarClouds
} from './scene.js';
import {
  resolveAvoid, bedHalfLocal, bedScaleOf, bedSurfaceHeight,
  buildGrass, buildTufts, buildLavender, buildBed, loadBedModel,
  buildDaisies, buildBedShadow, buildLadder, buildButterflies,
  buildGlints, snapGlintsToBed, buildCloud,
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
function setupModes(cfg, camera, controls, renderer, rig){
  const WALK = cfg.walk || {}, ROAM = cfg.roam || {};
  const S = makeSupport(rig, WALK);
  const btns   = Array.prototype.slice.call(document.querySelectorAll('.mode-btn'));
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
    if(mode !== 'walk') return;
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
      P.foot = Math.min(P.foot + climbSpeed*dt, rig.bed.top);
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
      run.i = (run.i + 1) % route.length; run.t = 0;
      stepHint(route[run.i]);
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
  btns.forEach(b => b.addEventListener('click', ()=> setMode(b.dataset.mode)));
  btns.forEach(b => { if(b.dataset.mode === 'free') b.classList.add('active'); });

  /* 支持 ?mode=roam|walk 直接以某个模式开场（便于截图 / 分享链接） */
  const q = new URLSearchParams(location.search).get('mode');
  if(q && (q === 'roam' || q === 'walk' || q === 'free')) setMode(q);

  /* 调试出口：控制台里可以直接看角色状态（无头脚本也靠它判断进度）。
     goto(i) 直接跳到 route 第 i 步 —— 漫游全程要十几秒仿真时间，
     截图/回归时没必要每次都从「飞向梯子」开始等一遍。 */
  window.__rig = {
    P, get mode(){ return mode; }, setMode, rig, leap: leapS,
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
    if(mode === 'roam' && route){
      routeTick(dt);
      applyCamera(dt);
      return;
    }
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
     都在这里按同一比例外推，保持与床的相对位置不变。 */
  const BD = cfg.bed || {};
  if(Z.bedScale !== undefined) BD.scale = Z.bedScale;
  const bedSC = (BD.scale !== undefined) ? BD.scale : 1;
  const r4 = v => +v.toFixed(4);
  if(bedSC !== 1){
    const bx = BD.position ? BD.position[0] : 0;
    const bz = BD.position ? BD.position[2] : 0;
    const growPair = a => Array.isArray(a) ? a.map(v => r4(v*bedSC)) : a;
    if(cfg.butterflies){
      cfg.butterflies.radiusX = growPair(cfg.butterflies.radiusX);
      cfg.butterflies.radiusZ = growPair(cfg.butterflies.radiusZ);
    }
    const pushOut = arr => {
      if(!Array.isArray(arr)) return;
      arr.forEach(c => {
        if(!c || !Array.isArray(c.center)) return;
        c.center = [ r4(bx + (c.center[0]-bx)*bedSC), r4(bz + (c.center[1]-bz)*bedSC) ];
      });
    };
    /* 面板手填的白菊花簇不跟着外推（它的坐标就是最终位置） */
    if(cfg.daisies && !eff.daisyClustersFromPanel) pushOut(cfg.daisies.clusters);
    if(G.lavender)  pushOut(G.lavender.clusters);
  }
  const AV = resolveAvoid(cfg);
  eff.bed = { scale: bedSC, surfaceY: bedSurfaceHeight(BD),
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
   3. 读取 scene.json + config.json 并搭建场景
   ============================================================ */
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
    build(cfg);
  })
  .catch(err => {
    console.error('加载 scene.json 失败（请通过本地服务器打开，而非 file:// 直接双击）：', err);
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);color:#fff;font-family:sans-serif;text-align:center;';
    tip.innerHTML = 'scene.json 加载失败<br>请用本地服务器打开（如：python -m http.server）'
                  + '<br><span style="font-size:13px;opacity:.75">' + String(err && err.message || err) + '</span>';
    document.body.appendChild(tip);
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
function createSceneUI(atmos, postfx, flashHint){
  const box = document.getElementById('scene-ui');
  if(!box) return null;
  const rowTime   = document.getElementById('ui-time');
  const rowFilter = document.getElementById('ui-filter');
  const rowFog    = document.getElementById('ui-fog');
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
  }
  addEventListener('keydown', onKey);

  return {
    el: box,
    sync(){ syncTime(); syncFx(); syncFog(); },
    timeNames, fxNames,
    click(name){ if(timeBtns[name]) timeBtns[name].click(); else if(fxBtns[name]) fxBtns[name].click(); },
    toggleFog(){ fogBtn.click(); },
    dispose(){ removeEventListener('keydown', onKey); }
  };
}

function build(cfg){
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
  const renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setSize(innerWidth, innerHeight);
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
  const camera = new THREE.PerspectiveCamera(cam.fov, innerWidth/innerHeight, cam.near, cam.far);
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

  /* 远处天空的大 billboard 云 */
  if(cfg.sky && cfg.sky.farClouds) cfg.sky.farClouds.forEach(g => buildFarClouds(scene, g));

  /* 远景环山（多层剪影山脊带 → 层峦叠嶂） */
  if(cfg.sky && cfg.sky.ridgeBands) cfg.sky.ridgeBands.forEach(b => buildRidgeBand(scene, b));

  /* 地形（含地表草地贴图；各向异性上限由渲染器能力决定） */
  const terrain = buildTerrain(scene, cfg.terrain, renderer.capabilities.getMaxAnisotropy());

  /* 无草区（床的位置）尺寸必须在种草之前定好 —— 幂等，配置里没给就用床尺寸推 */
  resolveAvoid(cfg);

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
    loadBedModel(cfg.bed, bed)
      .then(ok => { if(ok && glints) snapGlintsToBed(glints, bed, cfg); spawnBedShadow(); })
      .catch(e => { console.warn('床 GLB 加载失败，保留程序化床：', e); spawnBedShadow(); });
  } else spawnBedShadow();

  /* 梯子（梯脚可吸附到床面：bottom[1] 写 null 即取 bedTopY） */
  const bedTopY = bed.position.y + bedSurfaceHeight(cfg.bed);
  const ladder = buildLadder(cfg.ladder, bedTopY);
  scene.add(ladder);

  /* 蝴蝶：床边绕飞（billboard，逐帧在 CPU 上写实例矩阵） */
  const butterflies = buildButterflies(cfg, bed, camera);
  if(butterflies) scene.add(butterflies);

  /* 闪烁高光：床板侧面 + 梯杆（锚点挂在各自局部坐标，父级带旋转也贴得住） */
  bed.updateMatrixWorld(true); ladder.updateMatrixWorld(true);
  const glints = buildGlints(cfg, bed, ladder, camera);
  if(glints) scene.add(glints);

  /* 行走 rig：床的可站立矩形（含 rotationY 旋转）+ 梯子的轴向几何。
     世界坐标，必须带上床的整体缩放 —— 否则床放大了、「可站立矩形」还是旧的，
     人一走到放大的床沿外面就直接掉下去。 */
  const { bw, bd } = bedHalfLocal(cfg);
  const bsc = bedScaleOf(cfg);
  const bth = cfg.bed.rotationY || 0;
  const rig = {
    bed: {
      x: bed.position.x, z: bed.position.z, top: bedTopY,
      rx: (Math.abs(bw*Math.cos(bth)) + Math.abs(bd*Math.sin(bth))) * bsc,
      rz: (Math.abs(bw*Math.sin(bth)) + Math.abs(bd*Math.cos(bth))) * bsc
    },
    ladder: ladder.userData.rig
  };

  /* 相机焦点落位（具名锚点在这里才算得出来）。
     必须在 setupModes 之前 —— 它构造时会 copy(controls.target) 存成
     「自由模式切回来时要恢复的视角」，晚了就存到旧值。
     update() 只重算朝向：相机的世界位置不变，改的只是「看向哪」。 */
  const ctv = resolveViewTarget(cfg.controls.target, rig, cfg);
  if(ctv){ controls.target.set(ctv[0], ctv[1], ctv[2]); controls.update(); }

  /* 相机模式（自由 / 漫游 / 步行） */
  camera.rotation.order = 'YXZ';
  const step = setupModes(cfg, camera, controls, renderer, rig);

  /* 梦核 BGM：启动随机抽一首就放（被自动播放策略拦下就先挂着，
     第一次点屏幕/按键时自动接上）。碰云的星铃也走它。 */
  const AUD = createAudio(cfg.audio);

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
      bloomSet: postfx          // ← 时相改 bloom 阈值的出口
    });
  } catch(e){ console.error('ATMOS-FAIL ' + (e && e.stack ? e.stack : e)); throw e; }

  /* 时相 / 滤镜 / 雾档 面板。放在最后：它要读 atmos.names、postfx.names。
     flashHint 是 setupModes 里的提示条，这里借来给按钮点按一点文字反馈。 */
  const sceneUI = createSceneUI(atmos, postfx, window.__hintFlash);

  /* 调试出口：场景 / 渲染器 / 太阳（核对阴影开关与绘制统计；无头脚本也用它） */
  window.__dbg = { THREE, scene, renderer, camera, sun: RT.sun, controls, terrain, grass, tufts, lavender, bed, ladder,
    daisies, butterflies, glints, cloud: cloudGrp, audio: AUD, postfx, atmos, sceneUI, hemi, ambient, sky: skyMesh,
    config: CFG_EFF,   // config.json 里真正生效的值（调参后用它核对）
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

  /* 动画循环 */
  const clock = new THREE.Clock();
  function animate(){
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);   // 钳制：切标签页/低帧率时不让一帧跳太远
    uTime.value += dt;
    if(butterflies) butterflies.userData.update(uTime.value);
    if(glints) glints.userData.update(uTime.value);
    if(cloudGrp){ updateCloudFlow(cloudGrp, uTime.value, dt); updateCloudFade(cloudGrp, camera, cloudFade, cloudInside, cfg.cloud); }
    pokeStep(dt, uTime.value);
    if(atmos && typeof atmos.update === 'function') atmos.update(dt);   // 雾的 near/far 渐变
    step(dt);
    if(postfx.enabled) postfx.render(dt);
    else renderer.render(scene, camera);
  }
  animate();

  addEventListener('resize', ()=>{
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    postfx.setSize();     // composer 的 RT 与各 pass 都要跟着重建
  });
}
