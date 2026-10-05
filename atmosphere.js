/* ============================================================
   时相：下午 / 清晨（大雾）/ 日落 / 夜间（有月亮）
   ------------------------------------------------------------
   设计原则：**「下午」= 原样**。
   启动时把 scene.json 里那套灯/雾/天空原封不动快照成 base，
   每个时相只覆盖它关心的字段，没写的就沿用 base。
   这样加了这个模块之后，默认画面和加之前逐像素一致（可回归），
   而且以后调 scene.json 的基础光和色，四个时相会一起跟着变。

   三件“不吃灯”的东西要单独处理 —— 它们的颜色是构建期烘死的：
     · 天空穹顶：自定义 shader，靠 uniform 换色（直接改 u.cTop 等）
     · 体积云 / 远云：每个 sprite 一份材质，颜色烘在 mat.color 上
     · 远景环山：MeshBasicMaterial + 顶点色，同样不吃灯
   前两类统一走「乘色登记表」：登记 (材质, 构建期原色)，
   换时相时用 `原色 × 该时相的乘色` 重算 —— 从原色重算而不是累乘，
   来回切换不会有漂移。

   月亮不是独立的光源：把那个唯一的平行光（太阳）在夜间指向月亮方向、
   换成冷色低强度，它同时负责月光和投影 —— 省一套阴影贴图，
   而且月亮和影子方向天然一致。
   ============================================================ */
import * as THREE from 'three';

const D = Math.PI / 180;

/* 星点的「缺省外观」。构建材质与 apply() 换档都读这一份 ——
   两处各写一个 2.0/0.95 迟早会不一致。 */
const STAR_DEFAULT = { size: 2.0, opacity: 0.95 };

/* 每个时相的默认值。JSON（scene.json → config.json 覆盖层）同名字段优先。 */
const DEFAULTS = {
  /* 下午 = 原样：不给 fog/sky/灯，全部沿用 scene.json（快照成 base）。
     但要给 fogDense —— 「超大雾」按钮在任何时相下都必须有反应，
     而下午这一档的常雾是 far 5200（等于没雾），不另外给一档就等于没反应。
     注意这里**不给颜色**：沿用 base 的雾色（#93aef2）才和天空地平线接得上，
     换成别的色会在远处露出一圈突兀的色带。

     也**故意不给 tint**：云/远云/环山的颜色由 setTint 负责改写，而
     「没给 tint」的语义是「抄回构建期原色」而不是「跳过」——
     所以从夜间切回下午时，薰衣草紫的云会自己变回粉云。
     别在这里补 `tint:{cloudMix:0}`：那是给「只想换色不想换 mix」的人挖坑
     （Object.assign 会让 0 盖掉默认的 0.5）。 */
  afternoon: {
    label: '下午',
    fogDense: { near: 2.6, far: 64 }
  },
  dawn: {
    label: '清晨',
    exposure: 1.22,
    /* 方位角怎么选：默认相机在 (16,9,30) 看 (1.5,11.5,-2) ⇒ 视线方位角 ≈ −114°、
       俯仰只有 +4°，竖直半视角 28° ⇒ 框里能看到的高度大致是 −24°~+32°。
       所以「想让人一进来就看见天体」就得把方位角放在 −114° 附近、
       仰角别超过 30°，还要避开云（云正好在画面正中央的 −114° 方向）。
       下面几个时相的天体都是按这个视野摆的，云绕到别处也不用改。 */
    sun:     { azimuth: -104, elevation: 17, distance: 132, color: '#f4e8d6', intensity: 0.50 },
    /* 面光压到 ~0.95/0.85：雾色是 scene.fog 的颜色（不吃灯），所以「雾很亮、
       地很暗」可以同时成立 —— 第一版给了 1.45/1.25，草地近处还是正午那种翠绿，
       和四周的白雾拼在一起像两块贴纸。 */
    hemi:    { sky: '#d3dcee', ground: '#6d7488', intensity: 0.95 },
    ambient: { color: '#d5dcef', intensity: 0.85 },
    fog:      { color: '#d8e2f0', near: 8, far: 190 },
    fogDense: { color: '#e7edf5', near: 2.5, far: 52 },
    /* 天空稍微压暗一点、往蓝里偏一点：不这样做的话雾色、天空、太阳三样都是
       接近白的颜色，太阳在雾里完全没有对比、等于看不见。 */
    sky:     { top: '#aebfdd', mid: '#ccd9ea', horizon: '#e0e8f4', glow: '#fff6e8',
               glowAmp: 0.24, glowY: 0.03, noiseAmp: 0.05 },
    /* 云的底色是烘死的粉，纯「乘色」只能变暗不能去饱和 —— 所以换时相用的是
       朝目标色 lerp（wash），mix 越大越靠近目标色。清晨把粉云洗成浅蓝白。 */
    tint:    { bg: '#ccd6e6', bgMix: 0.70, cloud: '#dfe8f6', cloudMix: 0.62 },
    /* 「云朵的几层背面颜色没有变化：早晨、傍晚、晚上，应该随着环境色做一些混合」
       —— 清晨这一档原先**完全没配 cloudShade**，而它的 cloudMix 高达 0.62
       （片间对比只剩 38%），于是云的暗面与亮面糊成同一片浅蓝白。
       这里给四档里最轻的一次压暗（0.16 / hinge 0.84），暗面再朝本档 ambient
       （#d5dcef 的冷白）混 0.45 —— 清晨的云底是「更冷的灰蓝」，
       不是「更暗的白」，所以压得少、混得多。 */
    cloudShade: { backDark: 0.20, hinge: 0.84, backMix: 0.50 },
    /* 清晨整片雾的线性亮度就有 0.7~0.95 ⇒ 阈值必须提到 0.95，否则 bloom 会把
       雾一起点亮、画面糊成白纸。强度也压到 0.55：这一档要的是「雾里一点光」，
       不是「到处在发光」。 */
    bloom:   { strength: 0.55, radius: 0.85, threshold: 0.95 },
    /* 雾让天体变淡（见 applyFog 的 veil）。清晨的雾最厚、veil 只有 ~0.45，
       所以这一档的 opacity 给满，并且把太阳从近白换成偏暖的实体色 ——
       #fff6e2 这种「白得发光」的颜色在同样发白的雾里等于隐身，
       偏暖的 #f6dda8 才叠得出一枚看得见的淡太阳。 */
    orb:     { show: true, kind: 'sun', color: '#f6dda8', size: 140, haloSize: 760,
               haloColor: '#ffeec6', opacity: 1, radius: 3000 }
  },
  sunset: {
    label: '日落',
    exposure: 1.36,
    /* 方位角 −152：必须让开云。云在默认视野的正中（方位 −114 附近），
       第一版把落日放在 −118 —— 太阳正好钻进云里，糊成一团看不出来是什么。
       挪到 −152（画面偏左 36°）才是「落日挂在左边山脊上」。 */
    sun:     { azimuth: -152, elevation: 11, distance: 128, color: '#ffb46e', intensity: 1.70 },
    hemi:    { sky: '#ffb9a0', ground: '#463a66', intensity: 0.80 },
    ambient: { color: '#ff9d84', intensity: 0.55 },
    fog:      { color: '#f6b193', near: 22, far: 2600 },
    fogDense: { color: '#f7c3a5', near: 3, far: 62 },
    sky:     { top: '#6b5cc4', mid: '#e988b6', horizon: '#ffc178', glow: '#ffd39a',
               glowAmp: 0.46, glowY: 0.02, noiseAmp: 0.11 },
    tint:    { bg: '#c98aa4', bgMix: 0.55, cloud: '#ffcbb0', cloudMix: 0.42 },
    /* 「日落和晚上的云朵，立体感不强，背光面的颜色太亮，要压暗一点点」——
       日落档：lit < hinge(0.78) 的云片才参与压暗，最背光的那面乘 (1-0.26)；
       **lit ≥ 0.78 的片一个字节都不改**，所以亮的顶面保持原样，
       对比全落在暗侧 —— 这就是「只压背光面」的精确含义。
       为什么两档要分开给而不是一个全局值：两档的 cloudMix 差很远
       （0.42 vs 0.78），tint 对片间对比的压扁程度不同（见 regTint 的 tintColor）。 */
    cloudShade: { backDark: 0.24, hinge: 0.78, backMix: 0.40 },
    /* 日落：天比下午亮、又有大片暖色积云 ⇒ 阈值比预设高一档，只让落日和
       云顶那点高光发光。 */
    bloom:   { strength: 0.72, radius: 0.85, threshold: 0.86 },
    orb:     { show: true, kind: 'sun', color: '#ffd9a0', size: 160, haloSize: 780,
               haloColor: '#ffbe82', opacity: 0.85, radius: 3000 }
  },
  night: {
    label: '夜间',
    exposure: 1.34,
    /* 月光那盏就是太阳那盏（同一盏平行光，省一套阴影）。
       第一版给 0.62/0.6/0.55 时实测草地还是白天的亮绿 —— 总面积光 ≈1.7，
       太阳别的地方都对了、就草地像没入夜。压到 0.34/0.32/0.30 + 冷色之后
       反过来又太狠了：地面 RGB 均值只剩 [0.7, 5.1, 2.2]，整块草地是黑的，
       床和梯子都找不着 —— 「梦核的夜」要能看清场景，不是关灯。
       现在取中间：总面积光 ≈1.8，但把光色从纯蓝挪到偏青的月光色
       （绿色通道多一点），草地的绿色漫反射才接得住光。 */
    /* 月亮方位从 −148 挪到 −104：−148 时它正好落在画面左上角，
       被「BGM 播放器 + 时相/滤镜面板」挡得严严实实（实测截图里根本看不见），
       而月亮是夜间这一档的主角。−104 在视野中心右侧约 10°、仰角 24°，
       避开了左上角的面板、也避开了右上角的模式按钮，还刚好在体积云之上。 */
    sun:     { azimuth: -104, elevation: 24, distance: 150, color: '#c2d6ff', intensity: 0.62 },
    /* 「夜晚的环境色有点死黑，稍微加一点 blue」——环境色（ambient）与半球光的
       两个颜色一起往蓝里挪。为什么不是直接抬 intensity：用户要的是「不死黑」
       而不是「整体变亮」，抬蓝通道就等于给暗部补一层冷光。
       ⚠ 三个颜色都必须是**蓝占绝对多数**的配方（B 远大于 G）：
         第一版给的是 #3b56a0 / #4664b0 / #1f3860，B 确实都抬了，但草地是绿色
         漫反射 —— 光一亮，绿通道被材质放大得比蓝还猛，实测红绿蓝三个通道的
         增量是 R+2 / G+9 / B+7，画面反而「更绿」而不是「更蓝」。
         所以现在把配比压成 #3a4fb0 / #415cc0 / #1c2c66（G 基本不动、B 抬 60%+），
         让蓝通道的增量能压过材质对绿的放大。 */
    hemi:    { sky: '#485fd4', ground: '#1f3078', intensity: 0.66 },
    ambient: { color: '#3f57c8', intensity: 0.60 },
    /* 夜间雾色压暗（2026-10-05「晚上雾的颜色压暗一些」）：
       #1e2a4c → #131b34，#242f52 → #161e3c。雾色就是 scene.fog 的颜色、**不吃灯**，
       夜里远景的整块基调由它决定 —— 不压就永远是那层发灰的蓝雾，把月色糊掉、
       远山也泛白。压暗之后月亮和云才有对比，夜里才像夜。（near/far 不动，只改色。） */
    /* ⚠ 2026-10-06 用户要求「晚上的雾强度提高 50%」。线性雾的浓度正比于
       1/(far−near)（near 处为 0、far 处为 1，中间线性），所以「强度 ×1.5」
       = 把跨度压到 2/3，而不是把 far 乘 0.5：
         默认雾 4200−18 = 4182 → 2788 ⇒ far = 18 + 2788 = **2806**
         超大雾 58−2.5 = 55.5 → 37.0  ⇒ far = 2.5 + 37 = **39.5**
       near 与 color 不动（near 决定「从多近开始起雾」，改了会让脚边突然发白）。 */
    fog:      { color: '#131b34', near: 18, far: 2806 },
    fogDense: { color: '#161e3c', near: 2.5, far: 39.5 },
    sky:     { top: '#080d24', mid: '#141f45', horizon: '#2b3a6b', glow: '#465b9c',
               glowAmp: 0.20, glowY: 0.03, noiseAmp: 0.06 },
    tint:    { bg: '#2f3860', bgMix: 0.80, cloud: '#46538c', cloudMix: 0.78 },
    /* 夜间档压得比日落狠一档（0.38 / hinge 0.80），原因在 cloudMix 0.78：
       tint 的 lerp 把片间明暗差压到只剩 22%，不压一把，云的暗面
       在夜里和亮面几乎同色 —— 就是用户说的「立体感不强」。
       判据是「月亮照不到」：压暗方向取**本档的平行光位置**（夜间那盏
       就是月亮），所以暗面永远背对月亮；把月亮挪到别的方位角，
       云的暗面会跟着转（实测：-104 → -40 后 lit 分布整体挪位）。 */
    cloudShade: { backDark: 0.36, hinge: 0.80, backMix: 0.46 },
    /* 夜间整体暗，能超过阈值的只有月亮和星星 ⇒ 阈值可以放宽到 0.45，
       让月亮带一圈柔光；强度也不用压。 */
    /* radius 在 three 的 UnrealBloomPass 里**不是几何半径**，而是
       `mix(factor, 1.2-factor, radius)` 的插值权重（0→1）：调大它等于把权重
       从「近处 mip」翻向「远处 mip」，并不是把光晕摊开。真正的半径由高斯
       kernel 决定（见 postfx.js setBloomKernel / scene.json 的 bloomKernel）。
       这里从 0.80 提到 **1.0**（用满，再大就过界了：radius>1 会让最近那级
       权重变成负数 ⇒ 高光被反相成黑核），strength 同步提一点补偿
       kernel 变宽带来的能量摊开。 */
    bloom:   { strength: 1.15, radius: 1.0, threshold: 0.45 },
    orb:     { show: true, kind: 'moon', color: '#eef3ff', size: 150, haloSize: 780,
               haloColor: '#b9caff', opacity: 1, radius: 2600 },    stars:   { show: true, count: 460, radius: 3300, size: 2.0, opacity: 0.95 }
  }
};

/* 月球贴图：明亮的圆盘 + 环形山 + 边缘一圈柔化。
   刻意不做「写实月球照片」，梦核里的月亮就该是一块干净的白。 */
function makeMoonTexture(size){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const R = size * 0.40, cx = size/2, cy = size/2;
  const grad = g.createRadialGradient(cx, cy, R*0.80, cx, cy, R);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.92)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI*2); g.fill();
  // 环形山：几个比底色略暗的斑，位置固定（用固定数列，别随机 —— 免得每次刷新月亮都不一样）
  const spots = [[-0.30, -0.16, 0.17], [0.22, -0.30, 0.12], [0.10, 0.26, 0.15],
                 [-0.34, 0.30, 0.10], [0.36, 0.16, 0.09], [-0.06, -0.44, 0.07]];
  g.fillStyle = 'rgba(196,206,232,0.55)';
  for(let i=0;i<spots.length;i++){
    const s = spots[i];
    g.beginPath(); g.arc(cx + s[0]*R, cy + s[1]*R, s[2]*R, 0, Math.PI*2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 光晕贴图：中心亮、外圈指数衰减。给月亮/太阳的大光斑用。 */
function makeGlowTexture(size, power){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const k = power || 3.0, h = size/2;
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      const dx = (x - h)/h, dy = (y - h)/h;
      const d = Math.min(1, Math.sqrt(dx*dx + dy*dy));
      const a = Math.pow(1 - d, k) * (d < 1 ? 1 : 0);
      const i = (y*size + x)*4;
      img.data[i] = img.data[i+1] = img.data[i+2] = 255;
      img.data[i+3] = Math.round(a*255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* 由方位角/仰角/距离算世界坐标（方位角从 +X 转向 +Z，和 scene.json 的太阳坐标同一套） */
function posFromAzEl(azDeg, elDeg, dist){
  const az = azDeg*D, el = elDeg*D;
  return new THREE.Vector3(
    Math.cos(el)*Math.cos(az)*dist,
    Math.sin(el)*dist,
    Math.cos(el)*Math.sin(az)*dist
  );
}

export function createAtmosphere(o){
  const { scene, renderer, sun, hemi, ambient, sky } = o;
  const A = (o.cfg && o.cfg.atmosphere) || {};
  const on = A.enabled !== false;
  const tintReg = { cloud: o.tintCloud || [], bg: o.tintBg || [] };
  let onPhaseCb = null;   // main.js 挂上：切时相时回调（夜间→萤火虫 / 其余→蝴蝶）

  /* ---- 1. 快照 base：scene.json 的现值就是「下午」 ---- */
  const base = {
    sunPos: sun ? sun.position.clone() : new THREE.Vector3(),
    sunColor: sun ? sun.color.clone() : new THREE.Color('#ffffff'),
    sunIntensity: sun ? sun.intensity : 1,
    hemiSky: hemi ? hemi.color.clone() : new THREE.Color('#ffffff'),
    hemiGround: hemi ? hemi.groundColor.clone() : new THREE.Color('#444444'),
    hemiIntensity: hemi ? hemi.intensity : 1,
    ambColor: ambient ? ambient.color.clone() : new THREE.Color('#ffffff'),
    ambIntensity: ambient ? ambient.intensity : 1,
    fogColor: (scene.fog ? scene.fog.color.clone() : new THREE.Color('#ffffff')),
    fogNear: scene.fog ? scene.fog.near : 1,
    fogFar:  scene.fog ? scene.fog.far  : 1000,
    exposure: renderer.toneMappingExposure,
    sky: null
  };
  if(sky && sky.material && sky.material.uniforms){
    const u = sky.material.uniforms;
    base.sky = {
      top: u.cTop.value.clone(), mid: u.cMid.value.clone(),
      hor: u.cHor.value.clone(), glow: u.cGlow.value.clone(),
      glowAmp: u.uGlowAmp.value, glowY: u.uGlowY.value, noiseAmp: u.uNoiseAmp.value
    };
  }

  /* ---- 2. 时相表：DEFAULTS ← JSON ----
     ⚠ 这里是**白名单**字段构造，不是 Object.assign({}, d, j) 全量摊平。
       所以往 DEFAULTS 的某一档里加新字段时，必须同时在这里补一行 ——
       否则那个字段会**静默消失**（不报错、不警告，只是读不到）。
       实测踩到：给 sunset / night 加了 cloudShade（云的背光面压暗），
       探针却读到 `sunset:none, night:none`，云的暗面一个像素都没变；
       症状极像「参数给得太小」，其实是配置在构造时就被丢了。
       （scene.json 的 atmosphere.states.<名> 同名覆盖走的是同一条路。） */
  const states = {};
  const names = Object.keys(DEFAULTS);
  names.forEach(k => {
    const j = (A.states && A.states[k]) || {};
    const d = DEFAULTS[k];
    states[k] = {
      label: j.label || d.label,
      exposure: (j.exposure !== undefined) ? j.exposure : d.exposure,
      sun:     j.sun     ? Object.assign({}, d.sun, j.sun)         : d.sun,
      hemi:    j.hemi    ? Object.assign({}, d.hemi, j.hemi)       : d.hemi,
      ambient: j.ambient ? Object.assign({}, d.ambient, j.ambient) : d.ambient,
      fog:      j.fog      ? Object.assign({}, d.fog, j.fog)           : d.fog,
      fogDense: j.fogDense ? Object.assign({}, d.fogDense, j.fogDense) : d.fogDense,
      sky:     j.sky     ? Object.assign({}, d.sky, j.sky)         : d.sky,
      tint:    j.tint    ? Object.assign({}, d.tint, j.tint)       : d.tint,
      cloudShade: j.cloudShade ? Object.assign({}, d.cloudShade, j.cloudShade) : d.cloudShade,
      bloom:   j.bloom   ? Object.assign({}, d.bloom, j.bloom)     : d.bloom,
      orb:     j.orb     ? Object.assign({}, d.orb, j.orb)         : d.orb,
      stars:   j.stars   ? Object.assign({}, d.stars, j.stars)     : d.stars
    };
  });

  /* ---- 3. 月亮 / 太阳 / 星空（建一次，按时相显隐） ---- */
  const moonTex = makeMoonTexture(256);
  const glowTex = makeGlowTexture(256, 3.0);
  const orbGrp = new THREE.Group();
  orbGrp.frustumCulled = false;
  /* depthTest:false —— 天体不参与深度。为什么要这样：
     第一版留着深度测试，落日那轮正好被远景环山的侧壁切了一刀，
     画面上是「一处带直边的亮块」，比不遮挡难看多了。
     关掉之后它永远画在最上层（renderOrder 也排在云之后），
     月/日像贴在天幕上的贴纸 —— 也正是这类梦核场景想要的观感。 */
  const orbDisc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: moonTex, transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: 1
  }));
  const orbHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, transparent: true, depthWrite: false, depthTest: false, fog: false,
    blending: THREE.AdditiveBlending, opacity: 0.6
  }));
  orbDisc.renderOrder = 4; orbHalo.renderOrder = 3;
  orbGrp.add(orbHalo); orbGrp.add(orbDisc);
  orbGrp.visible = false;
  scene.add(orbGrp);

  let starPts = null;
  const starCfg = states.night.stars || {};
  {
    const n = starCfg.count || 420, R = starCfg.radius || 3200;
    const pos = new Float32Array(n*3), col = new Float32Array(n*3);
    const c = new THREE.Color();
    for(let i=0;i<n;i++){
      /* 只在地平线以上撒点（y > 0.04R），否则会从草地里“漏”出星星 */
      let u, v, w, len;
      do {
        u = Math.random()*2 - 1; v = Math.random(); w = Math.random()*2 - 1;
        len = Math.sqrt(u*u + v*v + w*w);
      } while(len < 0.2 || len > 1.0 || (v/len) < 0.04);
      const k = R/len;
      pos[i*3] = u*k; pos[i*3+1] = v*k; pos[i*3+2] = w*k;
      /* 星星带一点点色温差（蓝白 → 暖白），比清一色纯白耐看 */
      c.setHSL(0.55 + Math.random()*0.12, 0.15 + Math.random()*0.25, 0.82 + Math.random()*0.18);
      col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
    starPts = new THREE.Points(g, new THREE.PointsMaterial({
      size: starCfg.size || STAR_DEFAULT.size, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: starCfg.opacity !== undefined ? starCfg.opacity : STAR_DEFAULT.opacity,
      depthWrite: false, fog: false
    }));
    starPts.frustumCulled = false;
    starPts.visible = false;
    starPts.renderOrder = 1;              // 在天空穹顶（-1）之后、云之前
    scene.add(starPts);
  }

  /* ---- 4. 应用 ---- */
  let cur = null, fogHeavy = (A.fogModeDefault === 'heavy');
  const _c = new THREE.Color();

  /* 乘色 → 改成「朝目标色 lerp」。
     为什么必须换：乘色只能把颜色压暗、不能去饱和 —— 云的底色是烘死的粉，
     乘一个浅蓝白（#dfe8f6 ≈ 0.88/0.91/0.96）几乎看不出变化，清晨那朵云
     还是白天的粉。lerp 到目标色才能真的「洗掉」原来的色相。
     mix = 0 原样、1 = 完全变成目标色（会丢掉云片之间的上下渐变，别用 1）。

     ⚠ 这个函数**必须无条件写颜色**，不能「没给 hex 就 return」。
     云/远云/环山的颜色是烘死在材质上的，只有这里会把它们改回来；
     一旦提前 return，切到「下午」（这一档刻意不给 tint）时云就停在
     上一档的颜色上 —— 实测症状：点完夜间再切回下午，云还是薰衣草紫。
     所以 hex 缺省 = mix 缺省 = 0 = 抄回构建期原色，语义是「这一档不动颜色」，
     而不是「这一档跳过颜色」。 */
  function setTint(list, hex, mix){
    if(!list.length) return;
    const has = !!hex;
    if(has) _c.set(hex);
    const k = has ? THREE.MathUtils.clamp((mix === undefined ? 0.5 : mix), 0, 1) : 0;
    for(let i=0;i<list.length;i++){
      const it = list[i];
      if(k <= 0) it.mat.color.copy(it.base);          // 回原色（构建期快照）
      else       it.mat.color.copy(it.base).lerp(_c, k);
      /* 结果快照：云朵的「背光压暗」要在这一步之后再乘，且必须能从
         「干净的本档颜色」重算（见 scene.js regTint 里 tintColor 的说明）。
         ⚠ it.tintColor 与 mat.userData.__tintColor 是**同一个对象**
           （regTint 里挂的），所以这一行同时也是「告诉 shadeCloud
           本档的 tint 结果是什么」。少了这层别名，shadeCloud 会退回
           __tintBase 把本行刚写好的颜色覆写掉 —— 详见 regTint 的注释。 */
      if(it.tintColor) it.tintColor.copy(it.mat.color);
    }
  }

  /* fog:false 的 sprite（天空里的大团远云）不会自己吃雾，
     所以按当前雾的远距把它们的透明度压下去：雾越厚，远处的云越看不见。
     阈值给得比天体那条更狠 —— 一层薄雾就该把 1500 米外的云抹掉大半。 */
  function applyCloudVeil(far){
    const list = tintReg.bg;
    const v = THREE.MathUtils.clamp((far - 40)/420, 0, 1);
    for(let i=0;i<list.length;i++){
      const it = list[i];
      if(it.veil) it.mat.opacity = it.baseOpacity * v;
    }
  }

  /* ---- 雾的过渡 ----
     为什么 near/far 必须渐变：这两个数一改，整片画面的雾量就跳一次。
     「超大雾」那一档 far 从 5200 掉到 64 —— 硬切就是「啪一下世界没了」，
     和这个场景的调子不搭。现在用 2 秒走完（smoothstep：起收都平、中段快），
     观感上更像雾从远处漫过来。
     颜色**不**跟着渐变：雾色属于「天光」，要跟着时相瞬时到位；
     慢慢变色会和同一帧里已经换完色的天空/云对不上。
     fogAnimMs 由 atmosphere.fogAnimMs / fogAnimSpeed / fogAnimExtraMs 三个键算出，
     0 = 退回硬切
     （做「改动前后逐像素一致」的回归时需要置 0：否则每次取指纹都落在过渡中间）。 */
  /* 换雾的时长由三个旋钮算出来：
       ms = 基准时长 ÷ 加速倍数 + 追加毫秒        默认 2000 / 1.5 + 1000 = 2333ms
     为什么要拆成两个旋钮而不是直接写 2333：用户的两条要求方向相反
     （一条「加速 50%」、一条「时长再增加 1 秒」），合出来的那个数在配置里
     看不出出处，下次想只留一条就得重新反算。留着两个旋钮，
     「只保留加速」= 把 extraMs 改 0，「只保留加时」= 把 speed 改 1。 */
  const fogBaseMs  = (A.fogAnimMs !== undefined) ? Math.max(0, A.fogAnimMs) : 2000;
  const fogSpeed   = (A.fogAnimSpeed !== undefined) ? Math.max(0.01, A.fogAnimSpeed) : 1.5;
  const fogExtraMs = (A.fogAnimExtraMs !== undefined) ? Math.max(0, A.fogAnimExtraMs) : 1000;
  let fogAnimMs = Math.round(fogBaseMs / fogSpeed + fogExtraMs);
  const fogAnim = {
    t: 1,                                   // 0→1；1 = 已到位（静止时不产生开销）
    fromNear: base.fogNear, fromFar: base.fogFar,
    toNear:   base.fogNear, toFar:   base.fogFar
  };

  /* 雾里的天体要挡一挡：雾越厚，月亮/星星越淡（不然「白雾 + 清清楚楚的月亮」很假）。
     用当前雾的远距反推一个系数。
     ⚠ 下限不能给太低（第一版 0.25）：清晨的雾把系数压到 0.33，太阳就是
     「0.33 的白叠在白雾上」—— 人眼完全看不见它，等于这一档少了个「天上太阳」。
     抬到 0.45 之后配一个偏暖的实体色，雾里才有一枚淡淡的太阳。
     ⚠ 每次都重算，不能只在 veil 变化时算 —— 否则「夜间 → 下午 → 夜间」时
     某个时相改了 orb.opacity 却因为 veil 没变而没生效。
     ⚠ 渐变期间必须**每帧**按当前的 far 重算（update 里调它）：天体变淡、
     远云被抹掉这些效果都是被 far 驱动的，跟着 far 一起走才对得上。 */
  function applyFogDerived(far){
    const veil = THREE.MathUtils.clamp((far - 40)/460, 0.45, 1);
    moonNote.veil = veil;
    orbDisc.material.opacity = moonNote.orbOpacity * veil;
    orbHalo.material.opacity = moonNote.haloOpacity * veil;
    if(starPts) starPts.material.opacity = moonNote.starBaseOpacity * veil;
    applyCloudVeil(far);
  }

  /* orbOpacity 等是「该时相想要的透明度」，实际写进材质的还要乘 veil，
     所以这两者要分开存，别读回来当基线（会一次比一次淡）。 */
  const moonNote = { veil: 1, orbOpacity: 1, haloOpacity: 0.6, starBaseOpacity: 0.95 };

  /* 换雾的「目标」：立即记下，但 near/far 用 2 秒走过去。
     起点取**当前值**（不是上一次的目标）—— 过渡中途再切一次也能接得上，
     不会跳回上一帧之前的数。 */
  function setFogTarget(near, far){
    if(!scene.fog) return;
    const cn = scene.fog.near, cf = scene.fog.far;
    fogAnim.fromNear = cn; fogAnim.fromFar = cf;
    fogAnim.toNear = near; fogAnim.toFar = far;
    if(fogAnimMs <= 0 || (near === cn && far === cf)){
      fogAnim.t = 1;
      scene.fog.near = near; scene.fog.far = far;
      applyFogDerived(far);
      return;
    }
    fogAnim.t = 0;
  }

  /* 每帧推进（main.js 的渲染循环调用）。到位后直接 return：
     静止状态下它既不累计也不重算 veil，等于零开销。 */
  function update(dt){
    if(fogAnim.t >= 1 || !scene.fog) return;
    fogAnim.t = Math.min(1, fogAnim.t + (dt * 1000) / fogAnimMs);
    /* 收尾：0.35 + 0.6 + 0.7 这种累加会停在 0.9999999999999999 上，
       于是「已到位」被拖到下一帧、animating 还报 true（数值其实已经等于目标）。
       差 1e-6 以内直接认作到位 —— 那点差折算到 far 只有 0.005 米。 */
    if(fogAnim.t > 1 - 1e-6) fogAnim.t = 1;
    const k = fogAnim.t * fogAnim.t * (3 - 2 * fogAnim.t);   // smoothstep
    const near = fogAnim.fromNear + (fogAnim.toNear - fogAnim.fromNear) * k;
    const far  = fogAnim.fromFar  + (fogAnim.toFar  - fogAnim.fromFar ) * k;
    /* t=1 时 k 恰好为 1，这里再显式写一次，保证落在配置的原值上、不留浮点残差 */
    scene.fog.near = (fogAnim.t >= 1) ? fogAnim.toNear : near;
    scene.fog.far  = (fogAnim.t >= 1) ? fogAnim.toFar  : far;
    applyFogDerived(scene.fog.far);
  }

  /* 立刻走到目标（无头脚本用：切完不等两秒就取状态指纹）。
     返回是否真的推进过 —— 已经到位时返回 false，方便断言。 */
  function settleFog(){
    if(!scene.fog || fogAnim.t >= 1) return false;
    fogAnim.t = 1;
    scene.fog.near = fogAnim.toNear;
    scene.fog.far  = fogAnim.toFar;
    applyFogDerived(scene.fog.far);
    return true;
  }

  function applyFog(st){
    if(!scene.fog) return;
    /* ⚠ 必须兜一个空对象：「下午」这一档刻意不给 fog（= 原样），
       少了这个兜底就是 `undefined.color`，整个场景在启动时就挂了。 */
    const dense = fogHeavy && st.fogDense;
    const f = (dense ? st.fogDense : st.fog) || {};
    const fc = f.color !== undefined ? f.color : base.fogColor;
    scene.fog.color.set(fc);                 // 颜色瞬时（见上方「雾的过渡」）
    setFogTarget(
      (f.near !== undefined) ? f.near : base.fogNear,
      (f.far  !== undefined) ? f.far  : base.fogFar
    );
  }

  function apply(name){
    const st = states[name];
    if(!on || !st) return stats();
    cur = name;

    /* 灯：太阳那个平行光在夜间就是月光（同一盏，省一套阴影贴图） */
    if(sun){
      const s = st.sun || {};
      if(s.azimuth !== undefined || s.elevation !== undefined || s.distance !== undefined){
        const az = (s.azimuth !== undefined) ? s.azimuth : 35.5;
        const el = (s.elevation !== undefined) ? s.elevation : 46.5;
        const di = (s.distance !== undefined) ? s.distance : base.sunPos.length();
        sun.position.copy(posFromAzEl(az, el, di));
      } else sun.position.copy(base.sunPos);
      sun.color.set(s.color !== undefined ? s.color : base.sunColor);
      sun.intensity = (s.intensity !== undefined) ? s.intensity : base.sunIntensity;
    }
    if(hemi){
      const h = st.hemi || {};
      hemi.color.set(h.sky !== undefined ? h.sky : base.hemiSky);
      hemi.groundColor.set(h.ground !== undefined ? h.ground : base.hemiGround);
      hemi.intensity = (h.intensity !== undefined) ? h.intensity : base.hemiIntensity;
    }
    if(ambient){
      const a = st.ambient || {};
      ambient.color.set(a.color !== undefined ? a.color : base.ambColor);
      ambient.intensity = (a.intensity !== undefined) ? a.intensity : base.ambIntensity;
    }

    /* 天空穹顶：只改颜色与两句噪声/光晕的参数 */
    if(sky && sky.material && sky.material.uniforms && base.sky){
      const u = sky.material.uniforms, k = st.sky || {};
      u.cTop.value.set(k.top     !== undefined ? k.top     : base.sky.top);
      u.cMid.value.set(k.mid     !== undefined ? k.mid     : base.sky.mid);
      u.cHor.value.set(k.horizon !== undefined ? k.horizon : base.sky.hor);
      u.cGlow.value.set(k.glow   !== undefined ? k.glow    : base.sky.glow);
      u.uGlowAmp.value = (k.glowAmp  !== undefined) ? k.glowAmp  : base.sky.glowAmp;
      u.uGlowY.value   = (k.glowY    !== undefined) ? k.glowY    : base.sky.glowY;
      u.uNoiseAmp.value= (k.noiseAmp !== undefined) ? k.noiseAmp : base.sky.noiseAmp;
    }

    renderer.toneMappingExposure = (st.exposure !== undefined) ? st.exposure : base.exposure;

    /* 烘死的颜色：从原色重算（朝目标色 lerp，见 setTint 的说明） */
    const T = st.tint || {};
    setTint(tintReg.bg,    T.bg,    T.bgMix);
    setTint(tintReg.cloud, T.cloud, T.cloudMix);

    /* 云朵的「背光面压暗 + 暗面混环境色」—— 位置必须卡在 setTint **之后**：
       tint 是朝目标色 lerp，会把片间明暗差按 (1-mix) 压掉，压暗烘在
       __tintBase 里会被一起压扁（见 scene.js regTint 的 tintColor 注释）。
       方向取**本档的平行光位置**（夜间那一盏就是月亮，见上面 sun 的注释），
       所以「背光面」永远等于「这盏光找不到的那面」——
       以后把月亮挪到别的方位角，云的暗面会自动跟着转。
       环境色取的是**本档的 ambient.color**：用户要的「随着环境色做一些混合」
       指的就是它 —— 暗面只吃到环境光，所以它该长成环境光的颜色
       （清晨是冷白、日落是暖橙、夜间是月蓝）。这样每档云一换，暗面的
       色相会自己跟着换，而不是「同一块紫灰乘一个更小的数」。
       没写 cloudShade 的时相（下午）传 null ⇒ 系数恒为 1 ⇒ 颜色一个字节都不动。 */
    if(typeof o.paintCloud === 'function'){
      o.paintCloud(sun ? sun.position : null, st, ambient ? ambient.color : null);
    }

    /* bloom 覆盖：各时相的「整体亮度」差得很远，而 bloom 是在线性空间取阈值的，
       一套阈值不可能同时合适。最典型的是清晨 —— 整片雾的线性亮度就有 0.7~0.95，
       梦境档 0.62 的阈值等于把雾一起点亮，画面直接糊成一张白纸
       （实测同一帧 mean 从 [165,187,168] 涨到 [231,229,235]，脚下草地都白了）。
       所以这里把 st.bloom 交给后处理，顶掉预设的 strength/radius/threshold；
       没写 bloom 的时相（下午）保持预设原样。 */
    if(o.bloomSet && typeof o.bloomSet.setBloomOverride === 'function'){
      o.bloomSet.setBloomOverride(st.bloom || null);
    }

    /* 天体。
       ⚠ 位置/大小/颜色/透明度**每档都写**，而不是只在 showOrb 时写 ——
       否则从夜间切回下午（这一档没有 orb）会留着月亮的方向与大小。
       虽然 visible=false 时看不出来，但它和 tint 是同一类「切换不完整」的隐患，
       而且下次「下午 → 夜间」时读到的初值就来自上一轮，很难查。
       缺省值统一走 `ob.xxx !== undefined ? ob.xxx : 默认`，一律不读旧值。 */
    const ob = st.orb || {};
    orbGrp.visible = !!ob.show;
    const s = st.sun || {};
    const az = (s.azimuth !== undefined) ? s.azimuth : 35.5;
    const el = (s.elevation !== undefined) ? s.elevation : 46.5;
    const r  = ob.radius || 2800;
    orbGrp.position.copy(posFromAzEl(az, el, r));
    orbDisc.material.color.set(ob.color !== undefined ? ob.color : '#ffffff');
    orbHalo.material.color.set(ob.haloColor !== undefined ? ob.haloColor : '#ffffff');
    const sz = ob.size || 120;
    /* 视觉大小按距离等比放大：这样调 radius（放哪）不会顺带改「月亮多大」 */
    const kk = r / 2800;
    orbDisc.scale.set(sz*kk, sz*kk, 1);
    const hs = (ob.haloSize !== undefined ? ob.haloSize : 1100)*kk;
    orbHalo.scale.set(hs, hs, 1);
    moonNote.orbOpacity  = (ob.opacity !== undefined ? ob.opacity : 1);
    moonNote.haloOpacity = (ob.haloOpacity !== undefined ? ob.haloOpacity : 0.6);
    const sb = st.stars || {};
    if(starPts){
      /* ⚠ 这两项也要「每档都写」。只在字段存在时才写的话，从一个有星星的档
         切到没有星星的档（夜间 → 下午）会留下上一档的 size/opacity，
         下次换档时就成了隐性的初值。星星此时本就 visible=false 看不出问题，
         但和 tint 是同一类陷阱，一并按「缺省 = 该字段的默认值」写全。 */
      starPts.visible = !!sb.show;
      moonNote.starBaseOpacity = (sb.opacity !== undefined) ? sb.opacity : STAR_DEFAULT.opacity;
      starPts.material.size     = (sb.size    !== undefined) ? sb.size    : STAR_DEFAULT.size;
    }

    applyFog(st);
    if(onPhaseCb) onPhaseCb(name, st);   // 钩子：切时相后通知 main.js（夜间→萤火虫）
    return stats();
  }

  /* 瞬时切换雾档（小雾 ⇄ 超大雾）—— 只改目标，
     near/far 由 update() 在 fogAnimMs 内渐变过去。 */
  function toggleFog(){
    fogHeavy = !fogHeavy;
    applyFog(states[cur] || states.afternoon);
    return fogHeavy;
  }

  function stats(){
    const st = cur ? states[cur] : null;
    return {
      enabled: on,
      state: cur,
      fogHeavy,
      exposure: renderer.toneMappingExposure,
      sun: sun ? { pos: [+sun.position.x.toFixed(2), +sun.position.y.toFixed(2), +sun.position.z.toFixed(2)],
                   color: '#' + sun.color.getHexString(), intensity: sun.intensity } : null,
      fog: scene.fog ? { color: '#' + scene.fog.color.getHexString(), near: scene.fog.near, far: scene.fog.far } : null,
      /* 雾的过渡进度。animating=true 表示还没走完（near/far 正在中间值上）；
         to* 是这一档的目标值 —— 断言「切换是否写全」要认这个，不能认中间值。 */
      fogAnim: { ms: fogAnimMs, t: +fogAnim.t.toFixed(4), animating: fogAnim.t < 1,
                 toNear: fogAnim.toNear, toFar: fogAnim.toFar },
      orb: { visible: orbGrp.visible, pos: [+orbGrp.position.x.toFixed(1), +orbGrp.position.y.toFixed(1), +orbGrp.position.z.toFixed(1)],
             opacity: +orbDisc.material.opacity.toFixed(3) },
      stars: starPts ? { visible: starPts.visible, count: starPts.geometry.attributes.position.count,
                         opacity: +starPts.material.opacity.toFixed(3) } : null,
      tintCloud: tintReg.cloud.length,
      tintBg: tintReg.bg.length
    };
  }

  if(on) apply(A.default || 'afternoon');

  return {
    apply,
    set onPhase(fn){ onPhaseCb = fn; },   // 切时相钩子（夜间→萤火虫 / 其余→蝴蝶）
    toggleFog,
    update,        // 每帧推进雾的渐变（main.js 的渲染循环必须调它）
    settleFog,     // 立刻走到目标（测试用）
    setFogAnimMs(ms){ fogAnimMs = Math.max(0, ms || 0); fogAnim.t = 1; },   // 0 = 退回硬切
    get fogAnimMs(){ return fogAnimMs; },
    get fogTarget(){ return { near: fogAnim.toNear, far: fogAnim.toFar, animating: fogAnim.t < 1 }; },
    get state(){ return cur; },
    /* 时相表本身与「本档的云背光压暗参数」。暴露 states 是为了让探针能
       直接断言「哪几档配了 cloudShade、配的是多少」，不必去猜内部结构。 */
    get states(){ return states; },
    get cloudShade(){ return (cur && states[cur] && states[cur].cloudShade) || null; },
    get fogHeavy(){ return fogHeavy; },
    get labels(){ const o = {}; names.forEach(k => o[k] = states[k].label); return o; },
    get names(){ return names.slice(); },
    stats,
    base,     // 供调试查看
    orb: orbGrp,
    stars: starPts
  };
}
