/* ============================================================
   屏幕后处理 · 梦核四档（bloom + 调色）
   ------------------------------------------------------------
   管线（顺序很讲究，别随手调）：

     场景 → [RenderPass] 线性 HDR（HalfFloat RT，MSAA 4x）
          → [UnrealBloomPass] 只对高光做多级模糊再叠加（仍在线性空间）
          → [OutputPass] ACES 色调映射 + sRGB 编码（把 HDR 压回显示器）
          → [GradePass] 调色 / 暗角 / 颗粒 / 扫描线 / 色散（显示空间）
          → 屏幕

   三个「为什么」：

   1) **bloom 必须在色调映射之前**。ACES 会把高光压到 1 以内，
      压完再取阈值，整片云、白床单都不会超过阈值 —— 要么取不到高光，
      要么把中灰也一起糊上去（变成一层灰雾而不是光晕）。所以 bloom 吃
      的是线性 HDR 缓冲，阈值 0.6 才等于「天空以上那一点点」。

   2) **调色放在 OutputPass 之后**。对比度/饱和/抬黑的数值直觉都是在
      显示空间（0~1 的 sRGB）里长出来的 —— 0.5 是中灰、对比 1.1 是
      「稍微硬一点」。在线性空间里同一组数字会得到完全不同的结果。

   3) **别让 three 再乘一次曝光/色彩空间**。渲染到 render target 时
      three 自己会跳过色调映射与色彩空间转换（见 WebGLPrograms：
      `currentRenderTarget === null` 才应用），所以场景 materials 交出来的
      就是纯线性 HDR —— 这正是我们要的；而最终那个 GradePass 用的是
      自己的 ShaderMaterial，里面没有 `#include <colorspace_fragment>`，
      因此也不会被二次编码。

   `off` 档不是「参数全 0」，而是**整个 composer 旁路**：
   直接 renderer.render() 上屏，拿回原来的抗锯齿与最快帧率，
   方便随时对照「加了特效 vs 原片」。
   ============================================================ */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* 四档梦核 + 原片。数值不是拍的，是按「这一档想让人看见什么」反推的：
   梦境柔光 = 大而柔的光晕，粉紫偏色，几乎不脏；
   阈限泳池 = 偏青绿、对比硬一点、暗角收边，像白瓷砖房间的日光灯；
   模糊录像带 = 暖偏色 + 扫描线 + 颗粒 + 色散 + 整帧微抖，旧带子；
   过曝白梦 = 阈值 0.55 / 强度 0.95 + radius 拉满，靠「柔雾 + 褪色 + 抬黑」
              做过曝记忆，而不是把曝光真的拉上去（见该档注释）。 */
const PRESETS = {
  dream: {
    label: '梦境柔光', short: '梦境',
    bloom: { strength: 0.80, radius: 0.85, threshold: 0.62 },
    grade: { mix: 1, sat: 1.14, contrast: 1.04, lift: 0.015, gain: 1.03,
             tint: [1.02, 0.99, 1.04], vig: 0.20, grain: 0.015, scan: 0, ca: 0.15, wobble: 0 }
  },
  liminal: {
    label: '阈限泳池', short: '阈限',
    bloom: { strength: 0.55, radius: 0.45, threshold: 0.68 },
    grade: { mix: 1, sat: 0.92, contrast: 1.10, lift: 0.020, gain: 1.00,
             tint: [0.90, 1.00, 1.10], vig: 0.30, grain: 0.020, scan: 0, ca: 0.55, wobble: 0 }
  },
  vhs: {
    label: '模糊录像带', short: '录像带',
    bloom: { strength: 0.70, radius: 0.35, threshold: 0.62 },
    grade: { mix: 1, sat: 1.08, contrast: 1.14, lift: 0.028, gain: 1.00,
             tint: [1.07, 1.00, 0.93], vig: 0.42, grain: 0.075, scan: 0.14, ca: 1.5, wobble: 1 }
  },
  white: {
    label: '过曝白梦', short: '过曝',
    /* 第一版给的是 strength 1.35 / threshold 0.32，实测直接糊成一张白纸 ——
       原因：bloom 在线性空间取阈值，而天空的线性亮度本来就有 0.7~0.9，
       阈值压到 0.32 等于「连天空一起发光」，再叠加抬黑 0.07 就什么都不剩了。
       「记忆过曝」要的是柔雾 + 褪色，不是把曝光拉满，所以阈值收到 0.55、
       强度 0.95，靠 radius 1.0（最大范围）和抬黑/降对比做味道。 */
    bloom: { strength: 0.95, radius: 1.00, threshold: 0.55 },
    grade: { mix: 1, sat: 0.82, contrast: 0.92, lift: 0.050, gain: 1.00,
             tint: [1.02, 1.01, 1.01], vig: 0.12, grain: 0.012, scan: 0, ca: 0.20, wobble: 0 }
  }
};
const ORDER = ['dream', 'liminal', 'vhs', 'white'];
const OFF = 'off';

/* 调色 / 质感着色器。所有旋钮都在「显示空间」里：
   0~1 的像素值，0.5 = 中灰，1.0 = 白。 */
const GradeShader = {
  name: 'DreamcoreGrade',
  uniforms: {
    tDiffuse:  { value: null },
    uTime:     { value: 0 },
    uRes:      { value: new THREE.Vector2(1, 1) },
    uSat:      { value: 1 },
    uContrast: { value: 1 },
    uLift:     { value: 0 },
    uGain:     { value: 1 },
    uTint:     { value: new THREE.Vector3(1, 1, 1) },
    uVig:      { value: 0 },
    uGrain:    { value: 0 },
    uScan:     { value: 0 },
    uCA:       { value: 0 },
    uWobble:   { value: 0 },
    uMix:      { value: 1 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSat, uContrast, uLift, uGain, uVig, uGrain, uScan, uCA, uWobble, uMix;
    uniform vec3 uTint;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash21(vec2 p){
      p = fract(p*vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x*p.y);
    }
    void main(){
      vec2 uv = vUv;
      /* 录像带的「歪」：整帧极慢的上下漂 + 行内高频抖动。
         幅度刻意压到 0.2%/0.16%（约 1~2 像素），多了就会晕。 */
      if(uWobble > 0.0){
        uv.y += uWobble * (sin(uTime*7.3 + uv.y*43.0)*0.0016 + sin(uTime*1.7)*0.0009);
      }
      /* 色散：R/B 沿「离画面中心的方向」反向偏移，中心不动、边缘最重 */
      vec2 d = uv - 0.5;
      float ca = uCA * 0.0025;
      vec3 c;
      c.r = texture2D(tDiffuse, uv + d*ca).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - d*ca).b;
      /* 扫描线：按输出像素行算，和分辨率无关（换窗口不改变粗细） */
      if(uScan > 0.0){
        float s = 0.5 + 0.5*sin(uv.y*uRes.y*1.15 + uTime*3.0);
        c *= 1.0 - uScan*s;
      }
      c *= uTint * uGain;
      /* 饱和 → 对比 → 抬黑（顺序：先定色相浓度，再定反差，最后抬黑位） */
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = (c - 0.5)*uContrast + 0.5 + uLift;
      /* 暗角：以「到中心的距离」算，16:9 的角落在 1.0 附近 */
      if(uVig > 0.0) c *= 1.0 - uVig*smoothstep(0.30, 1.00, length(d)*1.42);
      if(uGrain > 0.0) c += (hash21(uv*uRes + fract(uTime)*137.0) - 0.5)*uGrain;
      c = clamp(c, 0.0, 1.0);
      /* uMix < 1 时和「没过调色的原帧」混 —— 让每一档都能调淡 */
      if(uMix < 0.999) c = mix(texture2D(tDiffuse, vUv).rgb, c, uMix);
      gl_FragColor = vec4(c, 1.0);
    }`
};

const num = (v, d) => (v === undefined || v === null) ? d : v;
function hexOrArr(v, out){
  if(Array.isArray(v)){ out.set(v[0], v[1], v[2]); return out; }
  if(typeof v === 'string'){ const c = new THREE.Color(v); out.set(c.r, c.g, c.b); return out; }
  return out;
}

export function createPostFX(renderer, scene, camera, cfg){
  const P = (cfg && cfg.postfx) || {};
  const on = P.enabled !== false;

  /* 预设表：JS 默认 ← JSON 覆盖（逐字段浅合并，写几个覆盖几个） */
  const presets = {};
  Object.keys(PRESETS).forEach(k => {
    const j = (P.presets && P.presets[k]) || {};
    presets[k] = {
      label: j.label || PRESETS[k].label,
      short: j.short || PRESETS[k].short || PRESETS[k].label,
      bloom: Object.assign({}, PRESETS[k].bloom, j.bloom || {}),
      grade: Object.assign({}, PRESETS[k].grade, j.grade || {})
    };
  });
  const names = ORDER.filter(k => presets[k]);

  /* MSAA：三个月的教训 —— antialias:true 在「渲染到 render target」时是无效的
     （它只作用于默认帧缓冲），所以走 composer 之后必须自己开 samples，
     否则草叶、梯子、床沿的边会全是锯齿。 */
  const MSAA = num(P.samples, 4);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(Math.max(2, size.x), Math.max(2, size.y), {
    type: THREE.HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
    samples: MSAA
  });
  rt.texture.name = 'cloud-ladder.postfx';

  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);        // RT 尺寸我们自己按设备像素管，别再乘一次

  const renderPass = new RenderPass(scene, camera);
  const bloomPass  = new UnrealBloomPass(new THREE.Vector2(rt.width, rt.height), 0.85, 0.85, 0.6);
  const outputPass = new OutputPass();
  const gradePass  = new ShaderPass(GradeShader);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);
  composer.addPass(gradePass);

  /* bloom 的分辨率倍率 —— 手机 / 低端机上把 bloom 自身的 RT 缩小，
     画面里的 bloom 只是更柔一点，但省掉一半以上的带宽。 */
  let bloomScale = num(P.bloomScale, 1);
  const bloomOff = P.bloom === false;
  let bloomOverride = null;      // 「时相覆盖」，由 atmosphere 通过 setBloomOverride 打进来
  let pinnedT = null;            // 非 null 时调色时钟被钉住（无头逐像素对照用，见 pinTime）

  const state = { name: 'dream', enabled: on && !!names.length, t: 0 };
  const U = gradePass.uniforms;

  function applyGrade(g){
    const tint = new THREE.Vector3(1, 1, 1);
    hexOrArr(g.tint, tint);
    U.uSat.value      = num(g.sat, 1);
    U.uContrast.value = num(g.contrast, 1);
    U.uLift.value     = num(g.lift, 0);
    U.uGain.value     = num(g.gain, 1);
    U.uTint.value.copy(tint);
    U.uVig.value      = num(g.vig, 0);
    U.uGrain.value    = num(g.grain, 0);
    U.uScan.value     = num(g.scan, 0);
    U.uCA.value       = num(g.ca, 0);
    U.uWobble.value   = num(g.wobble, 0);
    U.uMix.value      = num(g.mix, 1);
  }

  /* 切换：`off` = 旁路 composer（不是参数归零） */
  function set(name){
    if(name === OFF || name === 'none' || name === false){
      state.name = OFF; state.enabled = false;
      return state;
    }
    if(!presets[name]) return state;
    state.name = name;
    const p = presets[name];
    applyBloom(p.bloom);
    applyGrade(p.grade);
    state.enabled = !!on;
    return state;
  }
  /* bloom 三参数：预设值 ← 「时相覆盖」（overlay 里谁写了就顶掉谁）。
     为什么需要覆盖：bloom 是在**线性空间**取阈值的，而各时相的整体亮度差很远 ——
     「清晨」整片雾的线性亮度就有 0.7~0.95，dream 档 0.72 的阈值等于把整个雾
     一起点亮，画面直接糊成一张白纸（实测：同一帧 mean 从 [165,187,168]
     涨到 [231,229,235]，连脚下的草地都变白）。
     所以亮雾时相要把阈值顶到 0.95 左右、把强度压下来；夜间反过来可以放宽。
     覆盖只写在 overlay 里，不动预设本身 —— 同一档滤镜在四个时相下可以各自合适。 */
  /* 「看电视时」这类**条件性**的 bloom 增强（2026-10-06）。
     为什么不能直接改预设/时相里的 strength：atmosphere.apply() 每次切时相都会调
     setBloomOverride 把该档的值直接覆盖过来，写死会在下一次切时相时失效。
     所以拆成与「时相覆盖」正交的一层乘数：最终 = 时相/预设算出的 strength × bloomGain。
     只乘 strength（不乘 threshold）：threshold 决定「哪些像素参与辉光」，
     拉低它会让整个夜空都发亮而不是只让电视更亮。 */
  let bloomGain = 1;
  function applyBloom(b){
    const o = bloomOverride || {};
    const pick = (k, d) => num((o[k] !== undefined ? o[k] : b[k]), d);
    bloomPass.enabled   = !bloomOff;
    bloomPass.strength  = pick('strength', 0.8) * bloomGain;
    /* ⚠ radius 必须夹在 [0,1]（2026-10-06 加的保护）。它在 UnrealBloomPass 里是
       `mix(factor, 1.2 − factor, radius)` 的插值权重：bloomFactors = [1,.8,.6,.4,.2]、
       mirror = [.2,.4,.6,.8,1]，所以 radius>1 时最近那级会算成**负权重**
       （1.6 ⇒ 1.0 + (0.2−1.0)×1.6 = −0.28），高光被反相成**黑核**。
       「半径」要放大请调 bloomKernel（见 setBloomKernel），不是 radius。 */
    bloomPass.radius    = Math.min(1, Math.max(0, pick('radius', 0.8)));
    bloomPass.threshold = pick('threshold', 0.6);
  }

  /* ---- bloom 半径（真正的那个）----
     UnrealBloomPass 每一级 mip 用一个固定大小的高斯 kernel：
     `kernelSizeArray = [3,5,7,9,11]`，系数 `0.39894·exp(−i²/2R²)/R`
     预计算进 `gaussianCoefficients`，**完全不受 radius 影响**。
     所以「把 bloom 半径放大一倍」要动的是这里。
     kernel 长度 = `defines.KERNEL_RADIUS`，数组长度由它决定 ⇒ 改数值必须
     同时改 define 与系数数组，并置 `needsUpdate` 让 three 重编译 shader。

     ⚠⚠⚠ **2026-10-09 修正：kernel 必须「高分辨率大、低分辨率小」，而 three 的基线
        是**递增**的 [3,5,7,9,11] —— 那在低分辨率级上等于严重欠采样。**

     量化一下（以手机 DPR3、drawing buffer 1200×2700 为例）：
        mip0 = 1/2 分辨率 = 600px 宽   mip4 = 1/32 分辨率 = **37px 宽**
     当时配的是 `2.1 × 基线 = [6,11,15,19,23]`：
        · mip0 的 6px 只柔化全屏 12px ⇒ 电视屏幕的边缘几乎还是硬的 → **方框**
        · mip4 的 23px 用在 **37px 宽**的 RT 上 = 覆盖 62% → 采样点严重不足
          → **星点糊不开就是一个个方块**（用户实机截图正是这个现象）
     ⇒ 规律：**kernel 占比（kernel / 该级 RT 宽度）必须远小于 1**，否则 undersampling。

     现在用**递减**序列 `[11, 9, 7, 5, 3]`：
        · mip0 = 11px/600px = 1.8%  → 硬边被彻底柔化
        · mip4 =  3px/ 37px = 8.1%  → 平滑，没有块状
     各级「有效半径（kernel × 2^(i+1)）」= 22 / 36 / 56 / 80 / 96 px，**递增且都平滑**
     —— 这才是多尺度辉光该有的样子。
     ⚠ 能量会重新集中（峰值更高），所以夜间 strength 可能要往下调一点，实拍看着定。 */
  const BLOOM_KERNEL_BASE = [3, 5, 7, 9, 11];
  /* 递减序列：绝对值直接给（不做比例缩放）。奇数避免高斯中心半像素偏移。 */
  const BLOOM_KERNEL_FIXED = [11, 9, 7, 5, 3];

  function normalizeKernel(k){
    if (Array.isArray(k) && k.length === BLOOM_KERNEL_BASE.length)
      return k.map(v => Math.max(1, Math.round(Math.abs(+v) || 1)));
    const s = Math.max(0.25, num(k, 1));
    return BLOOM_KERNEL_BASE.map(r => Math.max(1, Math.round(r * s)));
  }

  function setBloomKernel(scale){
    const ks = normalizeKernel(scale);
    bloomPass.separableBlurMaterials.forEach((m, i) => {
      const R = Math.max(1, ks[i] | 0);
      const c = [];
      for(let j = 0; j < R; j++) c.push(0.39894*Math.exp(-0.5*j*j/(R*R))/R);
      m.defines.KERNEL_RADIUS = R;
      m.uniforms.gaussianCoefficients.value = c;
      m.needsUpdate = true;
    });
    return ks.slice();
  }
  function setBloomOverride(o){
    bloomOverride = (o && typeof o === 'object') ? o : null;
    if(state.name !== OFF && presets[state.name]) applyBloom(presets[state.name].bloom);
    /* ⚠ 这里不能写 `return stats()` —— stats 只是下面那个返回对象的**方法**，
       不是闭包里的独立函数，裸调会 ReferenceError（而且是在启动路径上，
       整个场景会直接挂掉）。要读状态请用 __dbg.postfx.stats()。 */
    return bloomOverride;
  }
  function next(dir){
    const list = names.concat([OFF]);
    let i = list.indexOf(state.name);
    if(i < 0) i = 0;
    i = (i + (dir || 1) + list.length) % list.length;
    return set(list[i]);
  }

  function setSize(w, h){
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    composer.setSize(Math.max(2, s.x), Math.max(2, s.y));
    U.uRes.value.set(s.x, s.y);
    bloomPass.setSize(Math.max(2, s.x*bloomScale), Math.max(2, s.y*bloomScale));
  }
  setSize();
  /* kernel 缩放要在 setSize 之后：setSize 会写各级的 invSize，但不会重建
     separableBlurMaterials（它们是构造时建好的持久对象），所以设一次就够。 */
  const bloomKernelRadii = setBloomKernel(num(P.bloomKernel, 1));

  set(num(P.default, 'dream'));

  return {
    get enabled(){ return state.enabled; },
    get name(){ return state.name; },
    set,
    next,
    get labels(){ const o = {}; names.forEach(k => o[k] = presets[k].label); o[OFF] = '原片'; return o; },
    /* 短名：给 UI 按钮用（长名在胶囊里放不下，「原片」也归进来） */
    get shortLabels(){ const o = {}; names.forEach(k => o[k] = presets[k].short); o[OFF] = '原片'; return o; },
    get names(){ return names.concat([OFF]); },
    setSize,
    setBloomScale(s){ bloomScale = s; setSize(); },
    /* bloom 高斯 kernel 缩放（真正的「半径」）。传 1 复原。
       实测返回每级实际半径，无头对照直接读它。 */
    setBloomKernel,
    get bloomKernel(){ return bloomKernelRadii.slice(); },
    /* 条件性 bloom 增强（看电视时 +30%）。传 1 复原。
       立刻重算当前档，这样切时相也不会把它冲掉。 */
    setBloomGain(g){
      bloomGain = Math.max(0, num(g, 1));
      if(state.name !== OFF && presets[state.name]) applyBloom(presets[state.name].bloom);
      return bloomGain;
    },
    get bloomGain(){ return bloomGain; },
    /* 时相覆盖 bloom（见 applyBloom 的说明）。传 null 恢复「只用预设值」 */
    setBloomOverride,
    get bloomOverride(){ return bloomOverride ? Object.assign({}, bloomOverride) : null; },
    /* 无头验证用：把调色时钟钉住。
       为什么要单独钉：postfx 有自己的累加器（state.t），**不吃** __dbg.uTime ——
       而颗粒（uGrain）与扫描线（uScan）都拿 uTime 当扰动源。
       不钉住的话，「同一状态拍两张」也会差出一片噪点（实测 max 15、
       11 万像素 >2，看着像状态泄漏，其实是胶片颗粒在走）。
       pinTime(t) 之后 render() 不再累加，画面完全可复现。
       注意：默认滤镜 dream 的 grain=0.015 ⇒ 不钉住就做不了逐像素断言。 */
    pinTime(t){ pinnedT = (typeof t === 'number') ? t : 0; U.uTime.value = pinnedT; return pinnedT; },
    unpinTime(){ pinnedT = null; return null; },
    get timePinned(){ return pinnedT !== null; },
    render(dt){
      if(pinnedT !== null) state.t = pinnedT;
      else                 state.t += (dt || 0);
      U.uTime.value = state.t;
      composer.render(dt);
    },
    /* 无头验证 / 控制台核对用 */
    stats(){
      return {
        name: state.name,
        enabled: state.enabled,
        msaa: MSAA,
        rt: [rt.width, rt.height],
        bloomScale,
        bloomOverride: bloomOverride ? Object.assign({}, bloomOverride) : null,
        bloom: { strength: +bloomPass.strength.toFixed(3), radius: +bloomPass.radius.toFixed(3),
                 threshold: +bloomPass.threshold.toFixed(3), enabled: bloomPass.enabled },
        grade: { sat: U.uSat.value, contrast: U.uContrast.value, lift: U.uLift.value, gain: U.uGain.value,
                 vig: U.uVig.value, grain: U.uGrain.value, scan: U.uScan.value, ca: U.uCA.value,
                 wobble: U.uWobble.value, mix: U.uMix.value,
                 tint: [+U.uTint.value.x.toFixed(3), +U.uTint.value.y.toFixed(3), +U.uTint.value.z.toFixed(3)] },
        passes: composer.passes.map(p => p.constructor.name)
      };
    },
    dispose(){
      composer.dispose();
      gradePass.dispose && gradePass.dispose();
      bloomPass.dispose && bloomPass.dispose();
      outputPass.dispose && outputPass.dispose();
    }
  };
}

export const POSTFX_PRESET_ORDER = ORDER.concat([OFF]);
export const POSTFX_PRESET_LABELS = (()=>{
  const o = {}; ORDER.forEach(k => o[k] = PRESETS[k].label); o[OFF] = '原片'; return o;
})();
export const POSTFX_PRESET_SHORT = (()=>{
  const o = {}; ORDER.forEach(k => o[k] = PRESETS[k].short || PRESETS[k].label); o[OFF] = '原片'; return o;
})();
