import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createAudio } from './audio.js';
import { createPostFX } from './postfx.js';
import { createAtmosphere } from './atmosphere.js';

var sun = null;

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

let QUALITY  = 1;      // 植被实例数倍率
let PR_CAP   = 2;      // 像素比上限
let CLOUD_Q  = 1;      // 体积云 billboard 倍率
let SHADOW_SZ = null;  // 阴影贴图边长（null = 用 JSON 里的值）
let PUFF_N    = 0;     // 实际生成的云 billboard 数（供调试出口读取）
let CFG_EFF   = {};    // config.json 的生效值快照（applyConfig 返回；无 config.json 时为空对象）
function qcount(n){ return Math.max(1, Math.round(n * QUALITY)); }

/* ------------------------------------------------------------
   换时相时要「整体乘一个色」的材质登记表
   ------------------------------------------------------------
   云、远云、远景环山的颜色都是**构建期烘死的**（逐 sprite 的 mat.color、
   逐顶点的渐变色），它们不吃灯光 —— 夜里把太阳调暗，它们照样是白天的粉紫色。
   所以换时相时得给它们乘一个色。这里存 (材质, 构建期原色) 对，
   每次从原色重算：来回切换不会像连续相乘那样越乘越黑。
   ------------------------------------------------------------ */
const TINT_CLOUD = [];   // 体积云的那些 sprite 材质
const TINT_BG    = [];   // 远景环山（吃雾）+ 天空里的大 billboard 云（不吃雾）
function regTint(list, mat, opt){
  if(mat && mat.color && mat.userData.__tintBase === undefined){
    mat.userData.__tintBase = mat.color.clone();
    /* veil=true 的条目额外记一份原透明度：这类 sprite 是 fog:false 的，
       大雾时雾管不到它们 —— 不额外按雾浓度压透明，就会看见「一片白雾里
       浮着几块灰云」这种穿帮。 */
    list.push({ mat, base: mat.userData.__tintBase,
                veil: !!(opt && opt.veil),
                baseOpacity: (mat.opacity !== undefined) ? mat.opacity : 1 });
  }
}


/* ============================================================
   0. 基础工具：值噪声 / fbm（heightmap 地形、山脉共用）
   ============================================================ */
function hash2(x, y){ const n = Math.sin(x*127.1 + y*311.7)*43758.5453123; return n - Math.floor(n); }
function noise2(x, y){
  const ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
  const ux=fx*fx*(3-2*fx), uy=fy*fy*(3-2*fy);
  const a=hash2(ix,iy), b=hash2(ix+1,iy), c=hash2(ix,iy+1), d=hash2(ix+1,iy+1);
  return a*(1-ux)*(1-uy) + b*ux*(1-uy) + c*(1-ux)*uy + d*ux*uy;
}
function fbm2(x, y){ return noise2(x,y)*0.55 + noise2(x*2.1,y*2.1)*0.25 + noise2(x*4.3,y*4.3)*0.12 + noise2(x*8.9,y*8.9)*0.08; }
/* 山脊噪声（ridged）：1-|2n-1| 取平方，噪声 0.5 等值线变成尖锐山脊线 */
function ridged(x, y, oct, freq){
  let v=0, a=0.5, f=freq, norm=0;
  for(let i=0;i<oct;i++){
    const n = 1 - Math.abs(noise2(x*f, y*f)*2 - 1);
    v += a*n*n; norm += a; a *= 0.5; f *= 2.07;
  }
  return v/norm;                       // ~[0,1]，山脊处接近 1
}
function hash1(n){ return (Math.sin(n)*43758.5453123)%1*0.5 + 0.5; }
function noise1(x){
  const i=Math.floor(x), f=x-i, u=f*f*(3-2*f);
  return hash1(i)*(1-u) + hash1(i+1)*u;
}
function fbm1(x){ return noise1(x)*0.6 + noise1(x*2.7)*0.3 + noise1(x*7.1)*0.1; }

/* 中央谷地配置 + 远山配置，由 scene.json 的 terrain.mound / terrain.ranges 注入（build() 里赋值） */
let MOUND = null;
let RANGES = null;
let MICRO = null;
let BROAD = null;

function terrainHeight(x, z){
  const d = Math.hypot(x, z);
  const n1 = fbm2(x*0.004,      z*0.004     )*30.0;
  const n2 = fbm2(x*0.016+7.3,  z*0.016+2.9 )* 6.0;
  const n3 = fbm2(x*0.06 +13.1, z*0.06 +5.7 )* 1.2;
  let h = n1 + n2 + n3;
  const flat = THREE.MathUtils.smoothstep(d, 10, 38);
  h = h*(0.06 + 0.94*flat) + (1-flat)*0.6;
  if(BROAD){
    // 大地势：远景整体缓慢抬升（幅度/范围由 JSON 控制）
    h += THREE.MathUtils.smoothstep(d, BROAD.start, BROAD.full) * BROAD.amp
       * fbm2(x*BROAD.freq + 3.7, z*BROAD.freq);
  }
  if(MOUND){
    // 中央盆地：床/草地所在区域保持 top，向外缓缓下沉成谷地（把"中间凸起"改成"群山环抱的谷底"）
    const t  = THREE.MathUtils.clamp((d - MOUND.innerRadius)/(MOUND.outerRadius - MOUND.innerRadius), 0, 1);
    const s  = Math.pow(t, MOUND.power);                    // power<1：出谷底后先快后缓
    const valley = MOUND.top - MOUND.drop * s;              // 谷地理想剖面
    // 软封顶：近中景不允许高出谷地剖面；低于剖面的凹陷保留，观感仍自然
    const capped = h > valley ? valley + (h - valley)*MOUND.above : h;
    const w = 1 - THREE.MathUtils.smoothstep(d, MOUND.fadeStart, MOUND.fadeEnd);
    h = h*(1-w) + capped*w;
    // 中景丘陵：在谷地坡面之上再叠加起伏，避免中景是一块平滑斜面
    const R = MOUND.roll;
    if(R){
      const rw = THREE.MathUtils.smoothstep(d, R.start, R.full);   // 近景淡出，保持谷底平整
      const r1 = fbm2(x*R.freq      + 21.7, z*R.freq      +  8.3)*2 - 1;
      const r2 = fbm2(x*R.freq*2.9  +  4.1, z*R.freq*2.9  + 15.9)*2 - 1;
      h += rw * R.amp * (r1 + r2*R.detail);
    }
  }
  if(MICRO){
    // 地表微起伏：让中景地面带一点疙瘩，不至于像一块塑料板（近景淡出，保持谷底平整）
    const mw = THREE.MathUtils.smoothstep(d, MICRO.start, MICRO.full);
    h += mw * MICRO.amp * (fbm2(x*MICRO.freq + 41.3, z*MICRO.freq + 17.9)*2 - 1);
  }
  if(RANGES){
    // 远山：主山脊 + 二级小峰 + 方位角包络 + 距离分层
    //   —— 目标是"重峦叠嶂"：山峰高低错落，而不是一圈等高的墙
    const G = RANGES;
    const mr = THREE.MathUtils.smoothstep(d, G.start, G.full);
    if(mr > 0){
      // 1) 主山脊（低频大山脉）
      let r = ridged(x, z, G.octaves || 4, G.freq);
      // 2) 二级山脊（高频小峰叠在主脊上，让轮廓同时有"大山"和"小山"两个尺度）
      if(G.freq2 && G.mix2){
        r = r*(1 - G.mix2) + ridged(x + 313.7, z - 217.3, G.octaves2 || 3, G.freq2) * G.mix2;
      }
      // 3) 方位角包络：一圈上分布若干"山系"与"垭口"
      //    用方向单位向量在噪声圆环上采样 ⇒ 360° 天然连续、无接缝
      let env = 1;
      if(G.sectorAmp){
        const a = Math.atan2(z, x), k = G.sectorFreq || 1.1;
        let e = fbm2(Math.cos(a)*k,          Math.sin(a)*k)*0.7
              + fbm2(Math.cos(a)*k*2.6 + 11.3, Math.sin(a)*k*2.6 + 4.9)*0.3;
        // fbm 取值集中在 0.5 附近，先做对比拉伸才能形成真正的"山系 ↔ 垭口"落差
        e = THREE.MathUtils.clamp((e - 0.5)*(G.sectorGain || 1) + 0.5, 0, 1);
        env = (1 - G.sectorAmp) + G.sectorAmp*2*e;
      }
      // 4) 距离分层：越远抬得越高 ⇒ 近山挡远山、远山露出山头，形成层叠
      const far = 1 + (G.farGain || 0) * THREE.MathUtils.smoothstep(d, G.full, G.farFull || 2000);
      h += mr * G.height * env * far * (G.base + (1 - G.base)*r);
    }
    // 地形外缘保底：避免山谷过低时在地形网格边界处露出"断口"
    if(G.rimMin){
      const rw = THREE.MathUtils.smoothstep(d, G.rimStart || 1700, G.rimFull || 1980);
      if(rw > 0){
        const floorH = rw * G.rimMin * (0.6 + 0.8*fbm2(x*0.0025 + 71.3, z*0.0025 + 9.1));
        if(h < floorH) h = floorH;
      }
    }
  }
  return h;
}

function hexToRgba(hex, a){
  let h = hex.replace('#','');
  if(h.length===3) h = h.split('').map(c=>c+c).join('');
  const r=parseInt(h.substr(0,2),16), g=parseInt(h.substr(2,2),16), b=parseInt(h.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}

/* 取 hex 的 "r,g,b" 三元组，供 canvas 渐变使用 */
function hexToRgb255(hex){
  let h = String(hex).replace('#','');
  if(h.length===3) h = h.split('').map(c=>c+c).join('');
  return parseInt(h.substr(0,2),16)+','+parseInt(h.substr(2,2),16)+','+parseInt(h.substr(4,2),16);
}

/* ============================================================
   0b. 渐变天空穹顶：顶部粉 → 中部紫 → 地平线蓝紫，并叠加程序化噪声
   ============================================================ */
function buildSky(scene, S){
  const G = S.gradient || {};
  const N = S.noise || {};
  const num = (v, d) => (v !== undefined ? v : d);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite:false, fog:false,
    uniforms:{
      cTop:{ value:new THREE.Color(G.top     || '#f7a9d0') },
      cMid:{ value:new THREE.Color(G.mid     || '#b79ae4') },
      cHor:{ value:new THREE.Color(G.horizon || '#9aa8ee') },
      cGlow:{ value:new THREE.Color(G.glow   || '#ffd8ef') },
      uGlowAmp:{ value:num(G.glowAmp, 0.30) },
      uGlowY:{ value:num(G.glowY, 0.06) },
      uTopRange:{ value:num(G.topRange, 0.26) },
      uHorRange:{ value:num(G.horRange, 0.32) },
      uNoiseScale:{ value:num(N.scale, 1.0) },
      uNoiseAmp:{ value:num(N.amp, 0.09) }
    },
    vertexShader:`
      varying vec3 vDir;
      void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader:`
      uniform vec3 cTop, cMid, cHor, cGlow;
      uniform float uGlowAmp, uGlowY, uTopRange, uHorRange, uNoiseScale, uNoiseAmp;
      varying vec3 vDir;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x),
                   mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y);
      }
      float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.04; a*=0.5; } return v; }
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        // 三段渐变：地平线蓝紫 → 中部紫 → 顶部粉
        vec3 col = mix(cHor, cMid, smoothstep(-0.06, uHorRange, h));
        col = mix(col, cTop, smoothstep(uTopRange, 0.95, h));
        // 天地交界处一抹暖光晕
        col = mix(col, cGlow, (1.0 - smoothstep(0.0, 0.26, abs(h - uGlowY))) * uGlowAmp);
        // 程序化噪声贴图：方向投影到天顶平面（越靠地平线拉得越长 → 条带状云纹）
        vec2 uv = d.xz / max(h + 0.30, 0.10);
        float n = fbm(uv*1.6*uNoiseScale + 3.1)*0.7 + fbm(uv*4.1*uNoiseScale - 1.7)*0.3;
        col += (n - 0.5) * uNoiseAmp * 2.0 * smoothstep(-0.05, 0.30, h);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(S.radius || 3600, 48, 32), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}

/* ============================================================
   1. 体积云纹理（移植先前 fbm 着色器到 canvas，得到 wisp 形状的云朵）
   ============================================================ */
function makeCloudTexture(size, seed, opt){
  opt = opt || {};
  const sx = (opt.sx !== undefined) ? opt.sx : 1.55;      // 横向拉伸：wisp 用更小的值 → 更扁更长
  const sy = (opt.sy !== undefined) ? opt.sy : 1.0;
  const dy = (opt.dy !== undefined) ? opt.dy : 1.45;      // 纵向椭球半径
  const bd = opt.body   || [1.18, 0.22];                  // 覆盖阈值 [外, 内]
  const dt = opt.detail || [0.86, 0.50];                  // 内部细节 [基础, 幅度]
  const edge = (opt.edge !== undefined) ? opt.edge : 0.12; // 边框羽化宽度
  const c=document.createElement('canvas'); c.width=c.height=size;
  const g=c.getContext('2d');
  const img=g.createImageData(size,size);
  const data=img.data;
  const hash=(x,y)=>{ const n=Math.sin(x*127.1+y*311.7)*43758.5453; return n-Math.floor(n); };
  const noise=(x,y)=>{
    const ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
    const ux=fx*fx*(3-2*fx), uy=fy*fy*(3-2*fy);
    const a=hash(ix,iy), b=hash(ix+1,iy), cc=hash(ix,iy+1), d=hash(ix+1,iy+1);
    return a*(1-ux)*(1-uy)+b*ux*(1-uy)+cc*(1-ux)*uy+d*ux*uy;
  };
  const fbm=(x,y)=>{ let v=0,a=0.5; for(let i=0;i<5;i++){ v+=a*noise(x,y); x*=2.05; y*=2.05; a*=0.5; } return v; };
  const ss=(e0,e1,x)=>{ let t=(x-e0)/(e1-e0); t=Math.min(Math.max(t,0),1); return t*t*(3-2*t); };
  for(let py=0;py<size;py++){
    for(let px=0;px<size;px++){
      let uvx=(px/size)*2-1, uvy=(py/size)*2-1;
      uvx*=sx; uvy*=sy;
      const n  = fbm(uvx*2.3 + seed, uvy*2.3 - seed);
      const n2 = fbm(uvx*4.6 - seed, uvy*4.6 + seed);
      const d  = Math.hypot(uvx, uvy*dy);
      const body = ss(bd[0], bd[1], d + n*0.58);   // 中心实、边缘虚
      const det  = ss(0.25, 0.78, n2);
      /* 边框羽化（别删）——贴图必须是「四周一圈 alpha=0」，
         否则 sprite 四边形的**直边**会原样出现在画面上。
         默认参数下 body 本来就到不了边框，这一步是空操作；
         但远景云那种自定义拉伸（sx .55 / dy 2.2）会把 wisp 横向铺满画布，
         左右边缘的 alpha 还剩 0.3~0.8 ⇒ 天上一块带硬边的浅色板。
         用「离边框最近的相对距离」做 smoothstep，对所有参数都成立。 */
      const bd1  = Math.max(Math.abs(uvx)/sx, Math.abs(uvy)/sy);
      const fe   = ss(1, 1 - edge, bd1);
      let alpha = Math.min(Math.max(body*(dt[0]+dt[1]*det)*fe,0),1);
      const idx=(py*size+px)*4;
      data[idx]=255; data[idx+1]=255; data[idx+2]=255; data[idx+3]=Math.round(alpha*255);
    }
  }
  g.putImageData(img,0,0);
  const tex=new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ============================================================
   2. 各物体的构建函数（全部由 scene.json 驱动）
   ============================================================ */
/* ============================================================
   1b. 远景环山：环绕相机的一圈"剪影山脊带"
   ------------------------------------------------------------
   · 山脊线用"方向单位向量在噪声圆环上采样"得到 ⇒ 360° 连续、无接缝
   · 可叠多层（半径/相位不同）⇒ 层峦叠嶂、近山挡远山
   · 山脊高度 = y + height*(base + (1-base)*n)
       base 小 ⇒ 垭口能落到地平线附近，露出天空，天际线才有起伏
   · 竖直方向用顶点色做"山脚深 → 山头亮"渐变，fog 再自动按距离染雾色
   ============================================================ */
function buildRidgeBand(scene, B){
  const seg  = B.segments  || 420;                     // 圆周分段（1.2°≈1 段）
  const rows = B.rows      || 12;                      // 竖直分段
  const H    = B.height;
  const y0   = (B.y !== undefined) ? B.y : -80;
  const R    = B.radius;
  const k    = (B.noiseRadius !== undefined) ? B.noiseRadius : 0.7;
  const seed = B.seed || 0;
  const gain = (B.gain  !== undefined) ? B.gain  : 2.2;
  const shap = (B.sharp !== undefined) ? B.sharp : 1.5;
  const df   = B.detailFreq || 0.004;
  const C    = B.colors || {};
  const cB = new THREE.Color(C.bottom || '#6f6ab8');
  const cT = new THREE.Color(C.top    || '#b2a5de');
  const tmp = new THREE.Color();

  /* 山脊高度（每个方位一个值） */
  const ridge = new Float32Array(seg + 1);
  for(let i=0;i<=seg;i++){
    const th = i/seg*Math.PI*2;
    const cx = Math.cos(th)*k + seed, cy = Math.sin(th)*k + seed*1.7;
    let n = fbm2(cx, cy)*0.68 + fbm2(cx*3.1 + 5.5, cy*3.1 + 9.9)*0.32;
    // fbm 挤在 0.5 附近 → 先做对比拉伸，再取幂让山头尖、垭口宽
    n = THREE.MathUtils.clamp((n - 0.5)*gain + 0.5, 0, 1);
    n = 1 - Math.pow(1 - n, shap);
    let h = B.base + (1 - B.base)*n;
    // 二级山脊：更高频的小峰，让天际线长出一片"峰林"而不是光溜的弧线
    if(B.detailAmp){
      const d2 = fbm2(cx*13.1 + 31.7, cy*13.1 + 12.1);
      h += (d2 - 0.5)*B.detailAmp;
    }
    ridge[i] = y0 + H*Math.max(h, 0);
  }

  const pos = [], col = [], idx = [];
  for(let i=0;i<=seg;i++){
    const th = i/seg*Math.PI*2;
    const x = Math.cos(th)*R, z = Math.sin(th)*R;
    const top = ridge[i];
    for(let j=0;j<=rows;j++){
      const t = j/rows;
      let y = y0 + (top - y0)*t;
      if(j > 0){
        // 山体表面的细微凹凸（顶部明显、山脚收敛），避免变成一块光滑平板
        y += (fbm2(x*df + seed*3.1 + 7.7, z*df + seed*2.3 + 17.9) - 0.5)*H*0.16*t*t;
      }
      pos.push(x, y, z);
      tmp.lerpColors(cB, cT, Math.pow(t, (B.gradPow !== undefined) ? B.gradPow : 0.85));
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for(let i=0;i<seg;i++){
    for(let j=0;j<rows;j++){
      const a = i*(rows+1) + j, b = a + rows + 1;
      idx.push(a, b, a+1, a+1, b, b+1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors:true, fog:true, side:THREE.DoubleSide
  }));
  regTint(TINT_BG, mesh.material);      // 不吃灯 ⇒ 换时相靠整体乘色压暗/偏色
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

/* ============================================================
   0c. 地表草地贴图（程序化 · 可无缝平铺）
   ------------------------------------------------------------
   地形是一整块 2000×2000 的平面，顶点色只画得出"大块地势色"，
   近看就是一片纯色塑料板。这里用 canvas 画一张草地贴图贴上去，
   四层叠加：
     · 草皮深浅 / 裸土斑块  —— pfbm（周期噪声，天生无接缝）
     · 草叶笔触            —— 填充的锥形叶片，深根 → 亮尖、随机倒伏
     · 细颗粒              —— 高频周期噪声，近看有"毛"的质感
     · 碎花点              —— 零星亮色小点
   无缝做法：噪声用周期格点（索引对周期取模），笔触按 3×3 环绕补画。
   亮度做法：按 meanTarget 归一（换配色不会忽明忽暗），再用材质
   color 把线性亮度补回 1.0 ⇒ 只加细节、不改整体色调。
   ============================================================ */
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* 周期值噪声：格点索引对 per 取模 ⇒ 左右/上下边界自动对齐，无接缝 */
function pnoise(x, y, per){
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy);
  const w = (a, b) => hash2(((a % per) + per) % per, ((b % per) + per) % per);
  const a = w(ix,iy), b = w(ix+1,iy), c = w(ix,iy+1), d = w(ix+1,iy+1);
  return a*(1-ux)*(1-uy) + b*ux*(1-uy) + c*(1-ux)*uy + d*ux*uy;
}
/* u,v ∈ [0,1) 上的无缝 fbm（cells = 基频格数，逐层加倍 ⇒ 格点仍对齐） */
function pfbm(u, v, cells, oct){
  let s = 0, amp = 0.5, c = cells, norm = 0;
  for(let i=0;i<oct;i++){ s += amp*pnoise(u*c, v*c, c); norm += amp; amp *= 0.5; c *= 2; }
  return s/norm;
}

const SRGB2LIN = (()=>{                       // sRGB→线性 查表（算亮度补偿用）
  const t = new Float32Array(256);
  for(let i=0;i<256;i++){ const s = i/255;
    t[i] = s <= 0.04045 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); }
  return t;
})();

function makeGrassTexture(size, opt){
  const t0 = performance.now();
  opt = opt || {};
  const P = opt.palette || {};
  const rgbOf = (hex) => hexToRgb255(hex).split(',').map(Number);
  const cBase = rgbOf(P.base  || '#54843a');
  const cDark = rgbOf(P.dark  || '#2c5522');
  const cMid  = rgbOf(P.mid   || '#6fa544');
  const cLite = rgbOf(P.light || '#a8cd63');
  const cTip  = rgbOf(P.tip   || '#dcefa0');
  const cSoil = rgbOf(P.soil  || '#6c7340');
  const cSpek = rgbOf(P.speck || '#f2f6d6');
  const rand  = mulberry32(((opt.seed !== undefined ? opt.seed : 7.7) * 9301) | 0);
  const mix3  = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
  const cl    = (v) => v < 0 ? 0 : (v > 255 ? 255 : v);
  const cl01  = (v) => v < 0 ? 0 : (v > 1 ? 1 : v);

  const cvs = document.createElement('canvas'); cvs.width = cvs.height = size;
  const g = cvs.getContext('2d');

  /* ---- 1) 逐像素层：底色 + 草皮深浅 + 裸土 + 细颗粒 ---- */
  const patchCells = opt.patchCells || 3;
  const soilCells  = opt.soilCells  || 5;
  const soilAmt    = (opt.soilAmt  !== undefined) ? opt.soilAmt  : 0.22;
  const lightAmt   = (opt.lightAmt !== undefined) ? opt.lightAmt : 0.30;
  const grain      = (opt.grain    !== undefined) ? opt.grain    : 0.12;
  /* 低频斑块在 64×64 粗网格上算一次，再按"环绕双线性"取值：
     逐像素跑 fbm 才是耗时的元凶（512² × 2 次 3 阶 fbm ≈ 500ms），
     换成查表后降到十几毫秒，画面没有肉眼差别。 */
  const M = 64;
  const mask = new Float32Array(M*M*2);
  for(let my=0;my<M;my++) for(let mx=0;mx<M;mx++){
    const u = mx/M, v = my/M;
    mask[(my*M+mx)*2  ] = pfbm(u, v, patchCells, 3);
    mask[(my*M+mx)*2+1] = pfbm(u+0.31, v+0.63, soilCells, 3);
  }
  const sampleMask = (u, v, ch) => {
    const fx = u*M, fy = v*M;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const xa = x0 % M, xb = (x0+1) % M, ya = y0 % M, yb = (y0+1) % M;
    const a = mask[(ya*M+xa)*2+ch], b = mask[(ya*M+xb)*2+ch];
    const c = mask[(yb*M+xa)*2+ch], d = mask[(yb*M+xb)*2+ch];
    return a + (b-a)*tx + (c-a)*ty + (a-b-c+d)*tx*ty;
  };
  const img = g.createImageData(size, size), dd = img.data;
  for(let y=0;y<size;y++){
    const v = y/size;
    for(let x=0;x<size;x++){
      const u = x/size;
      /* 低频：草皮明暗 —— 把底色往 暗绿 / 亮绿 两头拉 */
      const kp = Math.max(-1, Math.min(1, (sampleMask(u, v, 0) - 0.5)*2.0));
      const kt = Math.abs(kp)*lightAmt;
      const tg = kp >= 0 ? cLite : cDark;
      let r  = cBase[0] + (tg[0]-cBase[0])*kt,
          g2 = cBase[1] + (tg[1]-cBase[1])*kt,
          b  = cBase[2] + (tg[2]-cBase[2])*kt;
      /* 低频：裸土斑块（另一套相位，和草皮斑块错开） */
      const ks = cl01((sampleMask(u, v, 1) - 0.54)*3.0)*soilAmt;
      r += (cSoil[0]-r)*ks; g2 += (cSoil[1]-g2)*ks; b += (cSoil[2]-b)*ks;
      /* 高频：细颗粒 + 细纹 —— 远看是色斑、近看是绒毛 */
      const gr = 1 + ((pnoise(u*24, v*24, 24) - 0.5)*0.55
                    + (pnoise(u*52+3.5, v*52+8.5, 52) - 0.5)*0.45) * grain*2;
      const i4 = (y*size + x)*4;
      dd[i4] = cl(r*gr); dd[i4+1] = cl(g2*gr); dd[i4+2] = cl(b*gr); dd[i4+3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  /* ---- 2) 草叶层：3×3 环绕补画 ⇒ 跨边界的叶子在另一侧接回来 ----
     注意：叶子的随机量（弯曲方向等）必须在 wrapDraw 之外算好，
     否则同一片叶子的 9 份副本各不相同，接缝立刻现形。 */
  const wrapDraw = (bb, fn) => {
    for(let dx=-1; dx<=1; dx++) for(let dy=-1; dy<=1; dy++){
      const ox = dx*size, oy = dy*size;
      if(bb[2]+ox < 0 || bb[0]+ox > size || bb[3]+oy < 0 || bb[1]+oy > size) continue;
      g.save(); g.translate(ox, oy); fn(); g.restore();
    }
  };
  /* 一片叶子：根部 → 尖端的锥形填充（控制点向两侧鼓出 ⇒ 根部宽、尖端收尖） */
  const leaf = (x0, y0, len, ang, c0, c1, alpha, bulge) => {
    const tx = x0 + Math.cos(ang)*len, ty = y0 + Math.sin(ang)*len;
    const nx = Math.cos(ang + Math.PI/2), ny = Math.sin(ang + Math.PI/2);
    const mx = x0 + Math.cos(ang)*len*0.45, my = y0 + Math.sin(ang)*len*0.45;
    const grd = g.createLinearGradient(x0, y0, tx, ty);
    grd.addColorStop(0.00, 'rgba('+c0.map(Math.round).join(',')+','+(alpha*0.95).toFixed(3)+')');
    grd.addColorStop(0.55, 'rgba('+c1.map(Math.round).join(',')+','+(alpha*0.85).toFixed(3)+')');
    grd.addColorStop(1.00, 'rgba('+cTip.map(Math.round).join(',')+','+(alpha*0.55).toFixed(3)+')');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(mx + nx*bulge, my + ny*bulge, tx, ty);
    g.quadraticCurveTo(mx - nx*bulge*0.55, my - ny*bulge*0.55, x0, y0);
    g.closePath(); g.fill();
  };
  const k = size/512;                                  // 像素密度倍率（手机档 256 ⇒ 减半）
  const [lenLo, lenHi]   = opt.bladeLen   || [0.09, 0.28];
  const [widLo, widHi]   = opt.bladeWidth || [0.06, 0.15];

  /* 2a) 先铺一层暗色倒伏叶：给草皮压出层次和"厚度" */
  const nShade = Math.round((opt.shadeBlades || 420) * k);
  for(let i=0;i<nShade;i++){
    const x0 = rand()*size, y0 = rand()*size;
    const len = size*(lenLo + rand()*(lenHi-lenLo))*0.85;
    const ang = -Math.PI/2 + (rand()-0.5)*2.0;
    const bulge = len*(widLo + rand()*(widHi-widLo)) * (rand() < 0.5 ? 1 : -1);
    const ex = x0 + Math.cos(ang)*len, ey = y0 + Math.sin(ang)*len, m = len*0.45;
    const c0 = mix3(cDark, cMid, rand()*0.35);
    const al = 0.20 + rand()*0.14;
    wrapDraw([Math.min(x0,ex)-m, Math.min(y0,ey)-m, Math.max(x0,ex)+m, Math.max(y0,ey)+m],
      () => leaf(x0, y0, len, ang, c0, c0, al, bulge));
  }
  /* 2b) 主体叶片：深根亮尖，颜色/倒伏/透明度都随机 */
  const nBlade = Math.round((opt.blades || 1500) * k);
  for(let i=0;i<nBlade;i++){
    const x0 = rand()*size, y0 = rand()*size;
    const len = size*(lenLo + rand()*(lenHi-lenLo));
    const ang = -Math.PI/2 + (rand()-0.5)*1.7;
    const bulge = len*(widLo + rand()*(widHi-widLo)) * (rand() < 0.5 ? 1 : -1);
    const ex = x0 + Math.cos(ang)*len, ey = y0 + Math.sin(ang)*len, m = len*0.45;
    const c0 = mix3(cDark, cMid, 0.25 + rand()*0.55);
    const c1 = mix3(cMid, cLite, 0.30 + rand()*0.70);
    const al = 0.42 + rand()*0.42;
    wrapDraw([Math.min(x0,ex)-m, Math.min(y0,ey)-m, Math.max(x0,ex)+m, Math.max(y0,ey)+m],
      () => leaf(x0, y0, len, ang, c0, c1, al, bulge));
  }
  /* ---- 3) 碎花 / 亮点：远看是草地上的星星点点 ---- */
  const nSpek = Math.round((opt.speckles || 180) * k);
  for(let i=0;i<nSpek;i++){
    const x = rand()*size, y = rand()*size, r = size*(0.0025 + rand()*0.0045);
    const a = 0.18 + rand()*0.32;
    wrapDraw([x-r, y-r, x+r, y+r], () => {
      g.fillStyle = 'rgba('+cSpek.map(Math.round).join(',')+','+a.toFixed(3)+')';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI*2); g.fill();
    });
  }

  /* ---- 4) 亮度补偿系数 ----
     统计直方图 → 线性亮度均值 yLin；贴图的平均线性亮度不是 1.0，
     直接铺上去会让整片地面变暗/变亮。取 1/yLin 交给材质 color 抵消，
     ⇒ 净亮度不变，贴图只负责"加细节"。
     （meanTarget 可选：给数字才做亮度归一，默认 null = 保持调色板本身
       的明暗关系，避免归一带来的高光削顶。） */
  const fin = g.getImageData(0, 0, size, size);
  const fd = fin.data;
  const hist = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for(let i=0;i<fd.length;i+=4){ hist[0][fd[i]]++; hist[1][fd[i+1]]++; hist[2][fd[i+2]]++; }
  const n = size*size;
  const meanOf = (ch) => { let s = 0; for(let i=0;i<256;i++) s += i*hist[ch][i]; return s/n; };
  const lum = (0.2126*meanOf(0) + 0.7152*meanOf(1) + 0.0722*meanOf(2))/255;
  const target = (opt.meanTarget === undefined || opt.meanTarget === null) ? null : opt.meanTarget;
  const gain = (target && lum > 0.002) ? (target/lum) : 1;
  if(Math.abs(gain-1) > 0.002){
    for(let i=0;i<fd.length;i+=4){ fd[i]=cl(fd[i]*gain); fd[i+1]=cl(fd[i+1]*gain); fd[i+2]=cl(fd[i+2]*gain); }
    g.putImageData(fin, 0, 0);
  }
  /* 缩放后各通道的线性均值（直方图查表，精确且不用再扫像素） */
  const linMean = (ch) => { let s = 0;
    for(let i=0;i<256;i++) s += hist[ch][i]*SRGB2LIN[cl(Math.round(i*gain))];
    return s/n; };
  const yLin = 0.2126*linMean(0) + 0.7152*linMean(1) + 0.0722*linMean(2);
  /* 草绿的线性亮度天生很低（sRGB #54843a 的线性亮度只有 0.19），
     所以补偿系数往往要 2~3 倍才够 —— 上限给到 3.2，别在这里把亮度压回去。 */
  const compCap = (opt.compCap !== undefined) ? opt.compCap : 3.2;
  const brightComp = Math.min(compCap, Math.max(0.85, yLin > 0.01 ? 1/yLin : 1));

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.userData = { brightComp, meanLum: lum, gain, genMs: performance.now() - t0, size };
  return tex;
}

function buildTerrain(scene, T, maxAniso){
  const pk = T.peakRange || [80, 140];
  const D  = T.detail || {};
  const num = (v, d) => (v !== undefined ? v : d);
  const geo = new THREE.PlaneGeometry(T.size, T.size, T.segments, T.segments);
  geo.rotateX(-Math.PI/2);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count*3);
  const C = T.colors;
  const meadow=new THREE.Color(C.meadow), dry=new THREE.Color(C.dry),
        deepG=new THREE.Color(C.deepG), rock=new THREE.Color(C.rock),
        light=C.light ? new THREE.Color(C.light) : null,
        peak=C.peak ? new THREE.Color(C.peak) : null,
        tmp=new THREE.Color(), tmp2=new THREE.Color();
  const fMid = num(D.midFreq, 0.028), fFine = num(D.fineFreq, 0.085);
  const aMid = num(D.midAmp, 0.45),  aFine = num(D.fineAmp, 0.30);
  for(let i=0;i<p.count;i++){
    const x=p.getX(i), z=p.getZ(i);
    const h=terrainHeight(x,z);
    p.setY(i,h);
    // 低频：地势高低 → 深色坡地 / 亮色台地
    const nMix=fbm2(x*0.02+31, z*0.02+17);
    tmp.lerpColors(deepG, meadow, THREE.MathUtils.clamp(h*0.15+0.4,0,1));
    // 中频：干草色斑块
    tmp2.lerpColors(tmp, dry, THREE.MathUtils.smoothstep(nMix,0.45,0.75)*0.8);
    if(light){
      // 中/高频颗粒：草簇、苔藓的地表质感（频率压在网格可解析范围内，避免变成噪点雪花）
      const f1=fbm2(x*fMid +5.1, z*fMid +9.4);
      const f2=fbm2(x*fFine+1.7, z*fFine+27.3);
      tmp2.lerpColors(tmp2, light, THREE.MathUtils.smoothstep(f1,0.48,0.82)*aMid);
      tmp2.lerpColors(tmp2, light, THREE.MathUtils.smoothstep(f2,0.55,0.88)*aFine);
    }
    tmp2.lerpColors(tmp2, rock, THREE.MathUtils.smoothstep(h,18,45)*0.7);
    if(peak) tmp2.lerpColors(tmp2, peak, THREE.MathUtils.smoothstep(h, pk[0], pk[1]));
    col.set([tmp2.r,tmp2.g,tmp2.b], i*3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col,3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:1, metalness:0 });

  /* ---- 草地地表贴图：贴图负责"质感"，顶点色负责"宏观色调" ---- */
  const GT = T.texture;
  if(GT){
    const tSize = Math.max(64, Math.round((GT.size || 512) * (QUALITY < 1 ? 0.5 : 1)));
    const tex = makeGrassTexture(tSize, GT);
    const tile = GT.tile || 2.8;                       // 一张贴图铺多少米
    const rep  = T.size / tile;                        // 平面 UV 是 0..1 ⇒ 重复 rep 次
    tex.repeat.set(rep, rep);
    tex.anisotropy = Math.max(1, Math.min(16, (maxAniso | 0) || 1));   // 斜看的远景地面不糊
    tex.needsUpdate = true;
    mat.map = tex;
    mat.color.setScalar(tex.userData.brightComp);      // 把贴图平均亮度补回 1.0
    if(GT.debug) console.log('[grass-ground]', tSize+'px', 'tile='+tile+'m', 'rep='+rep.toFixed(0),
                             'lum='+tex.userData.meanLum.toFixed(3), 'comp='+tex.userData.brightComp.toFixed(3),
                             tex.userData.genMs.toFixed(0)+'ms');
    /* 双尺度采样：同一张贴图按更粗的尺度（并旋转 37°）再采一次混合，
       ⇒ 打破 2.8m 一个循环的"棋盘式"重复感，又不需要第二张贴图 */
    const mm = (GT.macroMix !== undefined) ? GT.macroMix : 0.4;
    if(mm > 0){
      const ms = (GT.macroScale !== undefined) ? GT.macroScale : 0.13;
      mat.onBeforeCompile = (sh)=>{
        /* 记一笔注入是否命中：three 换版本时 chunk 名可能变，
           命中失败会静默退化成"单尺度"，容易看漏 */
        mat.userData.macroInjected = sh.fragmentShader.indexOf('#include <map_fragment>') >= 0;
        sh.uniforms.uMacroScale = { value: ms };
        sh.uniforms.uMacroMix   = { value: mm };
        sh.fragmentShader = 'uniform float uMacroScale;\nuniform float uMacroMix;\n'
          + sh.fragmentShader.replace('#include <map_fragment>',
              `#ifdef USE_MAP
                 vec3 cA = texture2D( map, vMapUv ).rgb;
                 mat2 R37 = mat2( 0.799, -0.602, 0.602, 0.799 );
                 vec3 cB = texture2D( map, R37 * vMapUv * uMacroScale + vec2( 0.317, 0.723 ) ).rgb;
                 diffuseColor.rgb *= mix( cA, cB, uMacroMix );
               #endif`);
      };
      mat.customProgramCacheKey = () => 'grassGroundMacro';
    }
  }

  const terrain = new THREE.Mesh(geo, mat);
  terrain.receiveShadow = true;
  scene.add(terrain);
  return terrain;
}

/* ------------------------------------------------------------
   植被共用的两件小工具：阵风注入 + 影子通道材质
   - 主材质与影子深度材质必须注入【同一段】风动代码，
     否则草在摆、影子却钉死在原地，一眼假。
   - 影子通道用 MeshDepthMaterial(RGBADepthPacking)，
     它同样支持 map + alphaTest，所以贴图形状（草丛/薰衣草）的
     影子能正确镂空，而不是整块方形。
   ------------------------------------------------------------ */
function windSnippet(a1, a2, kz, f1, f2){
  return `
       vec4 wpi = instanceMatrix * vec4(position,1.0);
       float wind = sin(uTime*${f1} + wpi.x*0.9 + wpi.z*0.7) * ${a1}
                  + sin(uTime*${f2} + wpi.z*1.7) * ${a2};
       transformed.x += wind * position.y;
       transformed.z += wind * ${kz} * position.y;`;
}
function injectWind(mat, uTime, snip){
  mat.onBeforeCompile = (sh)=>{
    sh.uniforms.uTime = uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>' + snip);
  };
  return mat;
}
function makeShadowDepth(uTime, snip, opts){
  const d = new THREE.MeshDepthMaterial(Object.assign({ depthPacking: THREE.RGBADepthPacking }, opts || {}));
  return injectWind(d, uTime, snip);
}
/* 把 castShadow / receiveShadow 一次性配好（含 InstancedMesh 的剔除修正） */
function applyShadowFlags(mesh, cfg, depthMat){
  const cs = (cfg && cfg.castShadow   !== undefined) ? cfg.castShadow   : true;
  const rs = (cfg && cfg.receiveShadow !== undefined) ? cfg.receiveShadow : true;
  mesh.castShadow = cs;
  mesh.receiveShadow = rs;
  if(cs && depthMat) mesh.customDepthMaterial = depthMat;
  mesh.frustumCulled = false;   // 实例分布很广：包围球只按单个实例算，交给整体剔除会误裁
  return mesh;
}

/* 单株草叶：向上收分的窄平面，底暗顶亮的顶点色。
   抽成公用函数，好让「床底暗色草环」用完全一样的叶片形状（只换 tint），
   否则两处的草看起来会是两种植物。 */
function makeGrassBladeGeo(G){
  const H = G.bladeHeight;
  const geo = new THREE.PlaneGeometry(G.bladeWidth || 0.065, H, 1, 4);
  geo.translate(0, H/2, 0);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count*3);
  const cA = new THREE.Color(G.colors.a), cB = new THREE.Color(G.colors.b), tc = new THREE.Color();
  for(let i=0;i<p.count;i++){
    const y = p.getY(i), k = y/H;
    p.setX(i, p.getX(i)*(1-k*0.85));
    p.setZ(i, k*k*0.16);
    tc.lerpColors(cA, cB, k);
    col.set([tc.r, tc.g, tc.b], i*3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col,3));
  return geo;
}

/* 无草区（草坪「挖洞」）的判定函数：返回 SDF，< 0 表示落在区内。
   ------------------------------------------------------------------
   默认还是原来的「圆」（只写 radius）。但床其实是 5.7×4.4 的长方形：
   用圆覆盖四个角，半径必须 ≥ 3.61（床的对角），于是两条长边外面会各留
   近 1.9m 的秃圈 —— 床边既长不出草，手摆的白菊也只能落在空地上。
   写了 halfX / halfZ 就改用「圆角矩形」，贴着床铺一圈，草能一直长到床边。
   corner 是圆角半径（床本身也是圆角的，边界不会显得方正）。 */
/* 无草区的尺寸：由「床的标称尺寸 × 床的缩放 + margin」现推出来（幂等，
   重复调用不会越推越大）。这样调床的尺寸/缩放时草边自动跟着走，不用回来
   手改 halfX/halfZ。手写了 halfX/halfZ 就完全以手写的为准。 */
function resolveAvoid(cfg){
  const B = (cfg && cfg.bed) || {}, G = (cfg && cfg.grass) || {}, A = G.avoid;
  if(!A) return null;
  if(!(A.halfX > 0)){
    /* scene.json 的 bed 段可以只写 position/scale（size 缺省）——这里必须和
       bedHalfLocal() 用同一套标称尺寸兜底，否则 halfX 推不出来 ⇒ 无草区整个消失
       ⇒ 草会直接从床板里长出来。 */
    const sz = B.size || [4.7, 3.4];
    const s  = (B.scale !== undefined) ? B.scale : 1;
    const m  = (A.margin !== undefined) ? A.margin : 0.45;
    A.halfX = +(sz[0]*0.5*s + m).toFixed(4);
    A.halfZ = +(sz[1]*0.5*s + m).toFixed(4);
  }
  return A;
}

function makeAvoid(G){
  const A = G && G.avoid;
  if(!A) return null;
  const ax = A.x || 0, az = A.z || 0;
  if(A.halfX > 0 && A.halfZ > 0){
    const r  = Math.min((A.corner !== undefined) ? A.corner : 0.6, A.halfX, A.halfZ);
    const hx = A.halfX - r, hz = A.halfZ - r;
    return function(x, z){
      const dx = Math.abs(x - ax) - hx, dz = Math.abs(z - az) - hz;
      const ox = Math.max(dx, 0), oz = Math.max(dz, 0);
      return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0) - r;
    };
  }
  const R = A.radius || 0;
  if(!(R > 0)) return null;
  return function(x, z){ return Math.hypot(x - ax, z - az) - R; };
}

function buildGrass(G, uTime){
  const BLADE_H = G.bladeHeight;
  const bladeGeo = makeGrassBladeGeo(G);
  const grassMat = new THREE.MeshStandardMaterial({ vertexColors:true, side:THREE.DoubleSide, roughness:1 });
  const windG = windSnippet(0.14, 0.05, 0.55, 1.9, 3.7);
  injectWind(grassMat, uTime, windG);
  const GN = qcount(G.count);                          // 移动档按倍率打折
  const grass = new THREE.InstancedMesh(bladeGeo, grassMat, GN);
  applyShadowFlags(grass, G, makeShadowDepth(uTime, windG, { side:THREE.DoubleSide }));
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  let placed = 0, guard = 0;
  const inAvoid = makeAvoid(G);
  const feather = G.feather || 0.75;      // 从 radius*feather 处开始向外逐渐变稀，消除生硬的圆形边界
  while(placed < GN && guard++ < GN*40){
    const r = G.radius*Math.sqrt(Math.random()), a = Math.random()*Math.PI*2;
    const x = Math.cos(a)*r, z = Math.sin(a)*r;
    if(inAvoid && inAvoid(x, z) < 0) continue;
    if(r > G.radius*feather){
      const f = 1 - (r - G.radius*feather)/(G.radius*(1-feather));   // 外圈按概率剔除
      if(Math.random() > f) continue;
    }
    dummy.position.set(x, terrainHeight(x,z)+0.02, z);
    dummy.rotation.y = Math.random()*Math.PI;
    dummy.rotation.z = (Math.random()-0.5)*0.25;
    const s = 0.75+Math.random()*0.7;
    dummy.scale.set(s, s*(0.8+Math.random()*0.6), s);
    dummy.updateMatrix();
    grass.setMatrixAt(placed, dummy.matrix);
    /* 每株草的随机色相/饱和度/明度扰动，由 grass.tint 控制（改 JSON 即可换季） */
    const GT = G.tint || { h:[0.24,0.33], s:[0.35,0.62], l:[0.40,0.58] };
    tint.setHSL(GT.h[0]+Math.random()*(GT.h[1]-GT.h[0]),
                GT.s[0]+Math.random()*(GT.s[1]-GT.s[0]),
                GT.l[0]+Math.random()*(GT.l[1]-GT.l[0]));
    grass.setColorAt(placed, tint);
    placed++;
  }
  return grass;
}

/* 草丛 tuft 贴图：一簇草叶 + 零星小花，用于中景地表细节 */
function makeTuftTexture(size, blade){
  const bc = blade || ['#7c7fc4','#aca6e4','#e8defc'];
  const c=document.createElement('canvas'); c.width=c.height=size;
  const g=c.getContext('2d');
  for(let i=0;i<24;i++){
    const bx = size*(0.16 + Math.random()*0.68);
    const h  = size*(0.34 + Math.random()*0.60);
    const lean = (Math.random()-0.5)*0.9;
    g.lineWidth = size*(0.013 + Math.random()*0.020);
    g.lineCap = 'round';
    const grd = g.createLinearGradient(0, size, 0, size-h);
    grd.addColorStop(0.00, 'rgba('+hexToRgb255(bc[0])+',0.98)');
    grd.addColorStop(0.55, 'rgba('+hexToRgb255(bc[1])+',0.98)');
    grd.addColorStop(1.00, 'rgba('+hexToRgb255(bc[2])+',0.98)');
    g.strokeStyle = grd;
    g.beginPath();
    g.moveTo(bx, size);
    g.quadraticCurveTo(bx + lean*size*0.16, size-h*0.60, bx + lean*size*0.30, size-h);
    g.stroke();
  }
  for(let i=0;i<5;i++){                       // 零星小花，呼应截图里地面的碎点
    if(Math.random() > 0.55) continue;
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,248,253,0.95)' : 'rgba(255,214,238,0.95)';
    g.beginPath();
    g.arc(size*(0.2+Math.random()*0.6), size*(0.32+Math.random()*0.5), size*0.018, 0, Math.PI*2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildTufts(G, uTime){
  const cfg = G && G.tuft;
  if(!cfg) return null;
  const geo = new THREE.PlaneGeometry(1,1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({
    map: makeTuftTexture(cfg.textureSize || 128, cfg.blade),
    alphaTest: (cfg.alphaTest !== undefined ? cfg.alphaTest : 0.40),   // 走不透明通道：省掉排序、开销低
    side:THREE.DoubleSide, roughness:1, metalness:0
  });
  const windT = windSnippet(0.10, 0.04, 0.5, 1.9, 3.7);
  injectWind(mat, uTime, windT);                    // 与草叶共用同一阵风
  const count  = qcount(cfg.count || 1500);
  const radius = cfg.radius || 140;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  applyShadowFlags(mesh, cfg, makeShadowDepth(uTime, windT, {
    map: mat.map, alphaTest: mat.alphaTest, side: THREE.DoubleSide   // 影子按贴图镂空
  }));
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  const inAvoid = makeAvoid(G);
  const T = cfg.tint || { h:[0.62,0.78], s:[0.20,0.45], l:[0.45,0.68] };
  const [smin, smax] = cfg.size || [0.8, 2.2];
  let placed = 0, guard = 0;
  while(placed < count && guard++ < count*30){
    const r = radius*Math.sqrt(Math.random()), a = Math.random()*Math.PI*2;
    const x = Math.cos(a)*r, z = Math.sin(a)*r;
    if(inAvoid && inAvoid(x, z) < 0) continue;
    const fe = (cfg.feather !== undefined) ? cfg.feather : 0.8;
    if(r > radius*fe){                               // 外圈羽化，避免生硬圆边
      const f = 1 - (r - radius*fe)/(radius*(1-fe));
      if(Math.random() > f) continue;
    }
    dummy.position.set(x, terrainHeight(x,z)+0.01, z);
    dummy.rotation.y = Math.random()*Math.PI;
    const s = smin + Math.random()*(smax-smin);
    dummy.scale.set(s*(0.85+Math.random()*0.4), s*(0.8+Math.random()*0.5), s);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    tint.setHSL(T.h[0]+Math.random()*(T.h[1]-T.h[0]),
                T.s[0]+Math.random()*(T.s[1]-T.s[0]),
                T.l[0]+Math.random()*(T.l[1]-T.l[0]));
    mesh.setColorAt(placed, tint);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;                         // 分布很广，整体剔除意义不大
  return mesh;
}

/* ============================================================
   薰衣草：按斑块噪声分布，混进草地里的紫色花穗 billboard
   ============================================================ */
function makeLavenderTexture(size, LV){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const stems = LV.stems || 7;
  const stemC = LV.stemColor  || '#6f9c52';
  const flC   = LV.flowerColor|| '#9a7bd4';
  const flC2  = LV.flowerLight|| '#cbb2f2';
  for(let i=0;i<stems;i++){
    const bx   = size*(0.20 + (stems>1 ? i/(stems-1) : 0.5)*0.60 + (Math.random()-0.5)*0.05);
    const top  = size*(0.18 + Math.random()*0.14);
    const lean = (Math.random()-0.5)*size*0.12;
    const h    = size - top;
    g.strokeStyle = stemC;
    g.lineWidth   = Math.max(1, size*0.011);
    g.lineCap     = 'round';
    g.beginPath();
    g.moveTo(bx, size);
    g.quadraticCurveTo(bx + lean*0.5, size - h*0.5, bx + lean, top);
    g.stroke();
    // 顶端向下的花穗：一串由密到疏的小花
    const spike = h*(0.40 + Math.random()*0.18);
    const n = 9 + Math.floor(Math.random()*6);
    for(let k=0;k<n;k++){
      const t  = k/(n-1);
      const px = bx + lean*t + Math.cos(t*6.0)*size*0.012;
      const py = top + spike*t;
      const rr = size*(0.032 - 0.017*t);
      g.fillStyle = (k%3===0) ? flC2 : flC;
      g.beginPath();
      g.ellipse(px, py, rr*0.82, rr*1.28, 0, 0, Math.PI*2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildLavender(G, uTime){
  const LV = G && G.lavender;
  if(!LV) return null;
  const geo = new THREE.PlaneGeometry(1,1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({
    map: makeLavenderTexture(LV.textureSize || 128, LV),
    alphaTest: (LV.alphaTest !== undefined ? LV.alphaTest : 0.42),
    side:THREE.DoubleSide, roughness:1, metalness:0
  });
  const windL = windSnippet(0.11, 0.045, 0.5, 1.7, 3.3);
  injectWind(mat, uTime, windL);                    // 与草叶共用同一阵风
  const count  = qcount(LV.count || 2600);
  const radius = LV.radius || 45;
  const freq   = LV.patchFreq || 0.05;
  const thr    = (LV.patchThreshold !== undefined) ? LV.patchThreshold : 0.62;
  const soft   = (LV.patchSoft !== undefined) ? LV.patchSoft : 0.05;
  const [smin, smax] = LV.size || [0.5, 1.1];
  const T = LV.tint || { h:[0.70,0.80], s:[0.16,0.38], l:[0.64,0.86] };
  const inAvoid = makeAvoid(G);
  /* 花簇（LV.clusters）：在景观近景处补几块「成片薰衣草」——
     大田散布靠噪声斑块，半径 34m 里近处常常正好是空的。 */
  const CL = LV.clusters || [];
  const perCluster = CL.map(cl => qcount(cl.count || 140));
  const total = count + perCluster.reduce((a,b)=>a+b, 0);
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  applyShadowFlags(mesh, LV, makeShadowDepth(uTime, windL, {
    map: mat.map, alphaTest: mat.alphaTest, side: THREE.DoubleSide
  }));
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  let placed = 0;
  const put = (x, z, sr)=>{                                  // 统一的「落一株」
    if(placed >= total) return;
    dummy.position.set(x, terrainHeight(x,z)+0.02, z);
    dummy.rotation.y = Math.random()*Math.PI;
    const s = sr[0] + Math.random()*(sr[1]-sr[0]);
    dummy.scale.set(s*(0.80+Math.random()*0.5), s*(0.85+Math.random()*0.45), s);
    dummy.updateMatrix();
    mesh.setMatrixAt(placed, dummy.matrix);
    tint.setHSL(T.h[0]+Math.random()*(T.h[1]-T.h[0]),
                T.s[0]+Math.random()*(T.s[1]-T.s[0]),
                T.l[0]+Math.random()*(T.l[1]-T.l[0]));
    mesh.setColorAt(placed, tint);
    placed++;
  };
  let guard = 0;
  while(placed < count && guard++ < count*80){
    const r = radius*Math.sqrt(Math.random()), a = Math.random()*Math.PI*2;
    const x = Math.cos(a)*r, z = Math.sin(a)*r;
    if(inAvoid && inAvoid(x, z) < 0) continue;
    const n = fbm2(x*freq + 61.7, z*freq + 13.9);
    if(n < thr) continue;                                   // 只在斑块区域内生长
    if(Math.random() > 0.28 + 0.72*THREE.MathUtils.smoothstep(n, thr, thr+soft)) continue; // 斑块边缘稀、内部密
    put(x, z, [smin, smax]);
  }
  /* 近景花簇：椭圆铺展 + feather（中间密、边缘疏），与床边的白菊花同一套手感 */
  CL.forEach((cl, ci)=>{
    const [cx, cz] = cl.center || [0, 0];
    const rad = (cl.radius !== undefined) ? cl.radius : 1.6;
    const rx = (cl.rx !== undefined) ? cl.rx : rad;
    const rz = (cl.rz !== undefined) ? cl.rz : rad;
    const sr = cl.size || LV.clusterSize || LV.size || [0.5, 1.1];
    const fe = (cl.feather !== undefined) ? cl.feather : 0.5;
    const n = perCluster[ci];
    let done = 0, gd = 0;
    while(done < n && gd++ < n*80){
      const a = Math.random()*Math.PI*2, u = Math.sqrt(Math.random());
      const x = cx + Math.cos(a)*rx*u, z = cz + Math.sin(a)*rz*u;
      if(inAvoid && inAvoid(x, z) < 0) continue;
      if(u > fe){ const f = 1 - (u - fe)/(1 - fe); if(Math.random() > f) continue; }
      put(x, z, sr);
      done++;
    }
  });
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function buildBed(B){
  const bed = new THREE.Group();
  const woodMat    = new THREE.MeshStandardMaterial({ color:new THREE.Color(B.materials.wood),    roughness:0.85 });
  const sheetMat   = new THREE.MeshStandardMaterial({ color:new THREE.Color(B.materials.sheet),   roughness:0.95 });
  const blanketMat = new THREE.MeshStandardMaterial({ color:new THREE.Color(B.materials.blanket), roughness:0.95, side:THREE.DoubleSide });
  function addBox(g, w,h,d, mat, x,y,z, cast=true){
    const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
    m.position.set(x,y,z); m.castShadow=cast; m.receiveShadow=true; g.add(m); return m;
  }
  addBox(bed, 4.7, 0.55, 3.4, woodMat, 0, 0.55, 0);
  addBox(bed, 4.75, 0.16, 3.45, woodMat, 0, 0.9, 0);
  addBox(bed, 4.35, 0.42, 3.1, sheetMat, 0, 1.12, 0);
  addBox(bed, 4.5, 0.16, 3.25, blanketMat, 0, 1.36, 0);
  [[1.62],[-1.62]].forEach(([z])=>{
    const drape = new THREE.PlaneGeometry(4.5, 0.85, 24, 4);
    const p = drape.attributes.position;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i), y=p.getY(i);
      if(y<0.3) p.setZ(i, Math.sin(x*3.2)*0.06*(0.3-y));
    }
    drape.computeVertexNormals();
    const m = new THREE.Mesh(drape, blanketMat);
    m.position.set(0, 1.36-0.42, z); m.castShadow=true; bed.add(m);
  });
  {
    const drape = new THREE.PlaneGeometry(3.2, 1.0, 20, 4);
    const p = drape.attributes.position;
    for(let i=0;i<p.count;i++){
      const z=p.getX(i), y=p.getY(i);
      if(y<0.35) p.setZ(i, Math.sin(z*2.6)*0.07*(0.35-y));
    }
    drape.computeVertexNormals();
    const m = new THREE.Mesh(drape, sheetMat);
    m.rotation.y = Math.PI/2; m.position.set(2.26, 0.95, 0); m.castShadow=true; bed.add(m);
  }
  function pillow(color, x,y,z, rx,ry, s=1){
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 18),
      new THREE.MeshStandardMaterial({ color:new THREE.Color(color), roughness:0.95 }));
    m.scale.set(1.15*s, 0.38*s, 0.8*s);
    m.position.set(x,y,z); m.rotation.set(rx,ry,0); m.castShadow=true; bed.add(m);
  }
  B.pillows.forEach(p => pillow(p.color, p.pos[0], p.pos[1], p.pos[2], p.rot[0], p.rot[1], p.s));
  const px = B.position[0], pz = B.position[2];
  const py = (B.position[1]===null) ? terrainHeight(px,pz)+B.terrainOffset : B.position[1];
  /* 整体缩放（B.scale）：缩放原点是「床底中心」（组原点就在地形面上、水平居中），
     所以底面依旧正好落在地形上，只是向外、向上长 —— 不会往地里/草里陷。
     GLB 适配出来的模型与枕头都在这个组里，一并跟着放大；
     被面高度请用 bedSurfaceHeight() 取，别再用裸的 surfaceY。 */
  const SC = (B.scale !== undefined) ? B.scale : 1;
  if(SC !== 1) bed.scale.setScalar(SC);
  bed.position.set(px, py, pz);
  bed.rotation.y = B.rotationY;
  bed.rotation.z = B.rotationZ || 0;
  return bed;
}

/* ------------------------------------------------------------
   把 GLB 的「逐面法线」重算成按角度平滑的法线。
   下载来的低模常常是「非索引几何 + 每个三角形一组自己的顶点」，
   于是即使 material.flatShading=false，着色依旧是一格一格的 face 感。
   做法：按「顶点坐标」把所有面聚合起来（不是靠 mergeVertices ——
   它要求法线/UV 也一致，而这些模型连 UV 都没有），同一位置上
   只把夹角小于阈值的邻居面法线求平均 ⇒
   被面/床单这类缓坡变光滑，木框的 90° 硬边仍然保持锋利。
   ------------------------------------------------------------ */
function smoothGeometryNormals(srcGeo, angleDeg){
  const cosA = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const src  = srcGeo.index ? srcGeo.toNonIndexed() : srcGeo;
  const pos  = src.attributes.position;
  const n    = pos.count, tri = Math.floor(n/3);
  /* 1) 面法线（叉积本身就带面积权重，不必再归一化前的处理） */
  const fn = new Float32Array(tri*3);
  const ax=new THREE.Vector3(), bx=new THREE.Vector3(), cx=new THREE.Vector3(),
        u=new THREE.Vector3(), v=new THREE.Vector3(), w=new THREE.Vector3();
  for(let f=0; f<tri; f++){
    ax.fromBufferAttribute(pos, f*3); bx.fromBufferAttribute(pos, f*3+1); cx.fromBufferAttribute(pos, f*3+2);
    u.subVectors(bx,ax); v.subVectors(cx,ax); w.crossVectors(u,v);
    const l = w.length() || 1;
    fn[f*3] = w.x/l; fn[f*3+1] = w.y/l; fn[f*3+2] = w.z/l;
  }
  /* 2) 坐标 → 用到该位置的面号（量化到 1/4096 m） */
  const keyOf = i => ((pos.getX(i)*4096)|0)+','+((pos.getY(i)*4096)|0)+','+((pos.getZ(i)*4096)|0);
  const groups = new Map();
  for(let f=0; f<tri; f++) for(let k=0;k<3;k++){
    const kk = keyOf(f*3+k);
    let arr = groups.get(kk);
    if(!arr){ arr = []; groups.set(kk, arr); }
    arr.push(f);
  }
  /* 3) 逐角求平均 */
  const out = new Float32Array(n*3), acc = new THREE.Vector3();
  for(let f=0; f<tri; f++){
    const fx = fn[f*3], fy = fn[f*3+1], fz = fn[f*3+2];
    for(let k=0;k<3;k++){
      const i = f*3+k;
      const list = groups.get(keyOf(i));
      acc.set(0,0,0);
      for(let q=0; q<list.length; q++){
        const g = list[q], gx = fn[g*3], gy = fn[g*3+1], gz = fn[g*3+2];
        if(gx*fx + gy*fy + gz*fz >= cosA) acc.set(acc.x+gx, acc.y+gy, acc.z+gz);
      }
      if(acc.lengthSq() < 1e-10) acc.set(fx,fy,fz);
      acc.normalize();
      out[i*3] = acc.x; out[i*3+1] = acc.y; out[i*3+2] = acc.z;
    }
  }
  const g = src.clone();
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return g;
}

/* ------------------------------------------------------------
   用外部 GLB 替换程序化床的「外观」：
   碰撞 / 行走 / 爬梯仍然使用程序化床的几何数据（占地与 surfaceY 不变），
   模型加载成功后隐藏程序化网格、放入 GLB。
   模型按包围盒自动适配：长边 → 床长(局部X)，短边 → 床宽(局部Z)，
   被面(topFrac × 总高)对齐到 surfaceY，床头默认朝 -X（与枕头同侧）。
   ------------------------------------------------------------ */
function loadBedModel(B, bed){
  const M = (B && B.model) ? B.model : null;
  if(!M || !M.url) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(M.url, (gltf) => {
      try{
        const m = gltf.scene;
        m.rotation.y = (M.rotationY !== undefined) ? M.rotationY : -Math.PI/2;
        m.updateMatrixWorld(true);
        const dim = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
        const W = (B.size ? B.size[0] : 4.7);                 // 床长（局部 X）
        const D = (B.size ? B.size[1] : 3.4);                 // 床宽（局部 Z）
        const topFrac = (M.topFrac !== undefined) ? M.topFrac : 0.58;
        m.scale.set(W/dim.x, B.surfaceY/(dim.y*topFrac), D/dim.z);
        m.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(m);
        const c = box.getCenter(new THREE.Vector3());
        m.position.set(-c.x, -box.min.y, -c.z);               // 底面贴床组地面、水平居中
        bed.traverse(o => { if(o.isMesh) o.visible = false; });// 藏起程序化床
        m.traverse(o => { if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
        /* 布面光滑：GLB 多为逐面法线的低模，按角度重算法线
           （阈值越大越光滑；木框的硬边靠夹角阈值保住） */
        const smAngle = (M.smoothAngle !== undefined) ? M.smoothAngle : 0;
        if(smAngle > 0){
          let nMesh = 0;
          m.traverse(o => {
            if(!o.isMesh) return;
            o.geometry = smoothGeometryNormals(o.geometry, smAngle);
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(mm => {
              if(mm && mm.flatShading){ mm.flatShading = false; mm.needsUpdate = true; }
            });
            nMesh++;
          });
          console.log('床模型法线平滑：'+nMesh+' 个网格 / 夹角阈值 '+smAngle+'°');
        }
        bed.add(m);
        resolve(true);
      }catch(e){ reject(e); }
    }, undefined, reject);
  });
}

/* ============================================================
   白菊花：床边一小簇。billboard 贴图（白瓣 + 黄心 + 绿茎），
   与薰衣草同一套风动 / 阴影管线。
   ============================================================ */
function makeDaisyTexture(size, F){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const petal = F.petal || '#ffffff', shade = F.petalShade || '#e3e9f8',
        heart = F.heart || '#f0b43a', stem = F.stem || '#5f8f4a';
  const n = F.stems || 5;
  /* 「长高」为什么不能直接拉长 Y ——
     整株（茎 + 花头）画在同一张纹理、贴在同一片四边形上。想让花长高就必须
     把四边形拉高，那样花头会跟着被抻成竖椭圆（0.05 米的花头在屏幕上看得一清二楚）。
     所以走「先还后借」：花头在纹理里先按 1/grow 压扁，实例再按 grow 拉长，
     两次相乘=1 ⇒ 花头的大小与形状和原版逐像素等价，只有茎长出来、花头离地更高。
     压扁的那一步还得放在花头自己的坐标系里（translate → scale → translate），
     否则花瓣的旋转会被斜切。 */
  const grow = Math.max(0.2, (F && F.grow !== undefined) ? F.grow : 1);
  const sq   = 1/grow;
  for(let i=0;i<n;i++){
    const bx  = size*(0.22 + (n>1 ? i/(n-1) : 0.5)*0.56 + (Math.random()-0.5)*0.04);
    const top = size*(0.16 + Math.random()*0.20);
    const lean= (Math.random()-0.5)*size*0.10;
    g.strokeStyle = stem; g.lineWidth = Math.max(1, size*0.012); g.lineCap = 'round';
    g.beginPath(); g.moveTo(bx, size);
    g.quadraticCurveTo(bx + lean*0.5, size - (size-top)*0.5, bx + lean, top); g.stroke();
    // 花头：一圈白瓣（微偏蓝的暗瓣交替）+ 黄心 + 少许花蕊点
    const R  = size*(0.085 + Math.random()*0.045);
    const cx = bx + lean, cy = top;
    const np = 9 + Math.floor(Math.random()*3);
    g.save();
    g.translate(cx, cy); g.scale(1, sq); g.translate(-cx, -cy);   // 花头预压扁（见函数顶部说明）
    for(let k=0;k<np;k++){
      const a  = k/np*Math.PI*2 + Math.random()*0.2;
      const pr = R*(1.55 + Math.random()*0.5);
      g.fillStyle = (k%2===0) ? petal : shade;
      g.save();
      g.translate(cx + Math.cos(a)*pr*0.55, cy + Math.sin(a)*pr*0.55);
      g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, pr*0.42, R*0.38, 0, 0, Math.PI*2); g.fill();
      g.restore();
    }
    g.fillStyle = heart;
    g.beginPath(); g.arc(cx, cy, R*0.62, 0, Math.PI*2); g.fill();
    g.fillStyle = 'rgba(120,72,10,0.5)';
    for(let k=0;k<6;k++){
      const a = Math.random()*Math.PI*2, rr = Math.random()*R*0.4;
      g.beginPath(); g.arc(cx + Math.cos(a)*rr, cy + Math.sin(a)*rr, R*0.07, 0, Math.PI*2); g.fill();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildDaisies(cfg, uTime){
  const F = cfg && cfg.daisies;
  if(!F) return null;
  const geo = new THREE.PlaneGeometry(1,1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({
    map: makeDaisyTexture(F.textureSize || 128, F),
    alphaTest: (F.alphaTest !== undefined ? F.alphaTest : 0.42),
    side: THREE.DoubleSide, roughness: 1, metalness: 0
  });
  const windD = windSnippet(0.09, 0.035, 0.5, 1.8, 3.4);
  injectWind(mat, uTime, windD);
  /* 花簇：F.clusters 支持多块（如床两侧各一簇）；没写就退回单簇 F.center/radius/count。
     每簇可给 rx / rz 做椭圆铺展（沿床边拉长），feather 控制「中间密、边缘疏」。 */
  const CL = (F.clusters && F.clusters.length) ? F.clusters : [{
    center: F.center || [1.7, 1.6], radius: F.radius || 1.4,
    count: F.count || 80, size: F.size, feather: F.feather
  }];
  const pick = (cl, k, dflt)=> (cl[k] !== undefined) ? cl[k] : ((F[k] !== undefined) ? F[k] : dflt);
  /* 整株长高倍率：只放大四边形的 Y（水平尺寸一点不动），配合纹理里花头的预压扁，
     净效果 = 茎变长、花头离地更高，花头本身不多长一毫米。1 = 原样。 */
  const growY = Math.max(0.2, (F.grow !== undefined) ? F.grow : 1);
  /* 每簇的株数先各自打折、再求和 —— 必须与下面实例化时用的数一致，
     否则 mesh.count 会大于缓冲区容量，setMatrixAt 越界写出垃圾矩阵。 */
  const perCluster = CL.map(cl => qcount(pick(cl, 'count', 80)));
  const total = perCluster.reduce((a,b)=>a+b, 0);
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  applyShadowFlags(mesh, F, makeShadowDepth(uTime, windD, {
    map: mat.map, alphaTest: mat.alphaTest, side: THREE.DoubleSide
  }));
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  const T  = F.tint || { h:[0.12,0.14], s:[0.0,0.06], l:[0.9,1.0] };   // 近白，避免顶点色把花瓣染脏
  let placed = 0;
  CL.forEach((cl, ci)=>{
    const [cx, cz] = cl.center || [1.7, 1.6];
    const rad = pick(cl, 'radius', 1.4);
    const rx = (cl.rx !== undefined) ? cl.rx : rad, rz = (cl.rz !== undefined) ? cl.rz : rad;
    const n  = perCluster[ci];
    const [smin, smax] = cl.size || F.size || [0.55, 1.0];
    const fe = pick(cl, 'feather', 0.55);                             // 簇内密、边缘疏
    const yOff = (cl.yOffset !== undefined) ? cl.yOffset : 0.02;
    let done = 0, guard = 0;
    while(done < n && guard++ < n*80){
      const a = Math.random()*Math.PI*2;
      const u = Math.sqrt(Math.random());                             // 归一化半径（椭圆同理）
      const x = cx + Math.cos(a)*rx*u, z = cz + Math.sin(a)*rz*u;
      if(u > fe){
        const f = 1 - (u - fe)/(1 - fe);
        if(Math.random() > f) continue;
      }
      dummy.position.set(x, terrainHeight(x,z)+yOff, z);
      dummy.rotation.y = Math.random()*Math.PI;
      const s = smin + Math.random()*(smax - smin);
      dummy.scale.set(s*(0.85+Math.random()*0.4), s*(0.85+Math.random()*0.45)*growY, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      tint.setHSL(T.h[0]+Math.random()*(T.h[1]-T.h[0]),
                  T.s[0]+Math.random()*(T.s[1]-T.s[0]),
                  T.l[0]+Math.random()*(T.l[1]-T.l[0]));
      mesh.setColorAt(placed, tint);
      placed++;
      done++;
    }
  });
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/* ------------------------------------------------------------
   床「压住地面」的两件套：深色草环 + 接地阴影贴片
   ------------------------------------------------------------
   why：床是浮在地形上的一个外来模型。只有太阳投影时，它看起来仍然
   像「摆上去」的 —— 人眼判断「这东西在地上」靠的是接触遮蔽
   （contact occlusion）：物体根部一圈变暗，贴地处的草也缺光。

   所以两件事缺一不可：
     1) 深色草环：沿床的真实外沿种一圈草，越往外越稀、越亮。
        草缝里有草，就不会露出一圈突兀的裸土；颜色只降明度、
        不改色相，看起来才是「这块地方背光」而不是「长错草了」。
     2) 接地贴片：一张贴合地形起伏的暗色贴片，床沿处最暗、向外淡出。
        它负责草与草之间的地面 —— 那部分草盖不住，只能靠贴片压暗。
        深度测试开着 ⇒ 挡在贴片前方的草不会被涂黑（效果是"地面变暗"，
        不是"盖了一层灰雾"）。
   ------------------------------------------------------------ */

/* 床的世界外沿。优先量 GLB 的真实包围盒 —— 外来模型的尺寸不能假设，
   更不能拿程序化床的 4.7×3.4 去套。量不到（模型没加载/加载失败）才退回
   解析矩形：bed.size 是模型局部尺寸，必须先按 rotationY 转成世界 AABB。 */
function bedFootprint(cfg, bed){
  bed.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let n = 0;
  bed.traverse(o => { if(o.isMesh && o.visible){ n++; box.expandByObject(o); } });
  if(n){
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    return { cx:c.x, cz:c.z, hx:s.x/2, hz:s.z/2, bottom:box.min.y, src:'glb' };
  }
  const { bw, bd } = bedHalfLocal(cfg);
  const bs = bedScaleOf(cfg);                 // 世界坐标：要带上床的整体缩放
  const th = cfg.bed.rotationY || 0;
  return {
    cx: bed.position.x, cz: bed.position.z,
    hx: (Math.abs(bw*Math.cos(th)) + Math.abs(bd*Math.sin(th))) * bs,
    hz: (Math.abs(bw*Math.sin(th)) + Math.abs(bd*Math.cos(th))) * bs,
    bottom: bed.position.y, src:'analytic'
  };
}

/* 床的「标称」半长 / 半宽（局部 X / Z，**不含**整体缩放），以及整体缩放本身。
   局部坐标用的地方直接吃 bedHalfLocal —— 床侧高光锚点是挂在床的局部空间里的，
   组缩放会由 matrixWorld 自己乘上去，这里再乘一次就飞到床外面去了；
   世界坐标用的地方（无草圈、行走「可站立矩形」）才需要 bedScaleOf，否则人从床沿掉下去。 */
function bedHalfLocal(cfg){
  const B = (cfg && cfg.bed) ? cfg.bed : {};
  const sz = B.size || [4.7, 3.4];
  return { bw: sz[0]*0.5, bd: sz[1]*0.5 };
}
function bedScaleOf(cfg){
  const B = (cfg && cfg.bed) ? cfg.bed : {};
  return (B.scale !== undefined) ? B.scale : 1;
}

/* 被面（床顶）相对「床组原点」的高度 —— 必须带上整体缩放。
   梯脚吸附、爬床判定、蝴蝶巡航基准高度都读它；
   场景里还有几处直接写 surfaceY 的，床一放大就会按老高度算（梯子悬空/蝴蝶钻床）。 */
function bedSurfaceHeight(B){
  return (B.surfaceY || 1.44) * ((B && B.scale !== undefined) ? B.scale : 1);
}

/* 接地阴影贴图：床沿以内最暗（alpha = opacity），向外 spread 米淡出到全透。
   用普通 alpha 混合而不是 multiply —— 「暗多少」就等于 opacity，
   不必跟色调映射/色彩空间转换来回折算，调参所见即所得。 */
function makeBedAoTexture(size, o){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size), dd = img.data;
  const col = new THREE.Color(o.color);
  const rgb = [col.r*255, col.g*255, col.b*255];
  /* uv 的 0..1 对应「床心 ± (半宽 + spread)」。
     纹理是方的、贴片不是 ⇒ 必须换回「米」再算 SDF，
     否则长宽不等时暗部的形状会被拉扁。 */
  for(let j=0;j<size;j++){
    const dz = (Math.abs((j + 0.5)/size - 0.5) - o.fz*0.5) * o.d;
    for(let i=0;i<size;i++){
      const dx = (Math.abs((i + 0.5)/size - 0.5) - o.fu*0.5) * o.w;
      const sd = Math.hypot(Math.max(dx,0), Math.max(dz,0)) + Math.min(Math.max(dx,dz), 0);
      let k = 1 - Math.max(0, sd)/o.spread;      // 床沿内 = 1（最暗），到 spread 处 = 0
      if(k < 0) k = 0;
      k = k*k*(3 - 2*k);                          // smoothstep：边界更柔，不出硬圈
      const i4 = (j*size + i)*4;
      dd[i4] = rgb[0]; dd[i4+1] = rgb[1]; dd[i4+2] = rgb[2];
      dd[i4+3] = Math.round(o.opacity * k * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildBedShadow(cfg, uTime, bed){
  const S = cfg.bedShadow;
  if(!S || S.enabled === false) return null;
  const G = cfg.grass || {};
  const FP = bedFootprint(cfg, bed);
  const grp = new THREE.Group();
  grp.name = 'bedShadow';

  /* ---- 1) 深色草环 ---- */
  const GN = qcount((S.grass !== undefined) ? S.grass : 2600);
  if(GN > 0){
    const geo = makeGrassBladeGeo(G);            // 与普通草同一套叶片（形状一致）
    const mat = new THREE.MeshStandardMaterial({ vertexColors:true, side:THREE.DoubleSide, roughness:1 });
    const windG = windSnippet(0.14, 0.05, 0.55, 1.9, 3.7);   // 与普通草同参 ⇒ 同频摆动
    injectWind(mat, uTime, windG);
    const mesh = new THREE.InstancedMesh(geo, mat, GN);
    applyShadowFlags(mesh, S, makeShadowDepth(uTime, windG, { side:THREE.DoubleSide }));
    const W    = (S.ringWidth    !== undefined) ? S.ringWidth    : 0.55;
    const ins  = (S.inset        !== undefined) ? S.inset        : 0.02;
    const fall = (S.falloff      !== undefined) ? S.falloff      : 3.2;
    const hMul = (S.heightScale  !== undefined) ? S.heightScale  : 1.0;
    const SZ   = S.size   || [0.30, 0.60];      // 逐株基础大小（普通草是 0.75~1.45）⇒ 这里明显是小草
    const boost = (S.edgeBoost !== undefined) ? S.edgeBoost : 0;
    const T = S.tint || { h:[0.27,0.35], s:[0.22,0.48], l:[0.16,0.30] };
    const R = Math.hypot(FP.hx, FP.hz) + W + 0.35;
    const boxSD = (x, z)=>{                      // 矩形 SDF：<0 在床板正下方
      const qx = Math.abs(x - FP.cx) - FP.hx, qz = Math.abs(z - FP.cz) - FP.hz;
      return Math.hypot(Math.max(qx,0), Math.max(qz,0)) + Math.min(Math.max(qx,qz), 0);
    };
    const dummy = new THREE.Object3D(), tint = new THREE.Color();
    let placed = 0, guard = 0;
    while(placed < GN && guard++ < GN*80){
      const r = R*Math.sqrt(Math.random()), a = Math.random()*Math.PI*2;
      const x = FP.cx + Math.cos(a)*r, z = FP.cz + Math.sin(a)*r;
      const d = boxSD(x, z);
      if(d < ins) continue;                      // 不钻到床板底下：会从床沿穿出来
      const t = d / W;                           // 0 = 贴着床沿，1 = 环的外沿
      if(t >= 1) continue;
      /* 密度剖面：(1-t)^fall。fall 越大越贴床 —— 环外沿迅速掉到 0，不外扩 */
      if(Math.random() > Math.pow(1 - t, fall)) continue;
      dummy.position.set(x, terrainHeight(x,z)+0.02, z);
      dummy.rotation.y = Math.random()*Math.PI;
      dummy.rotation.z = (Math.random()-0.5)*0.3;
      const s = (SZ[0] + Math.random()*(SZ[1] - SZ[0])) * hMul * (1 + boost*(1-t));
      dummy.scale.set(s, s*(0.8+Math.random()*0.6), s);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      tint.setHSL(T.h[0]+Math.random()*(T.h[1]-T.h[0]),
                  T.s[0]+Math.random()*(T.s[1]-T.s[0]),
                  T.l[0]+Math.random()*(T.l[1]-T.l[0]));
      mesh.setColorAt(placed, tint);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    grp.add(mesh);
    grp.userData.ringCount = placed;
  }

  /* ---- 2) 接地阴影贴片 ---- */
  const AO = S.ao || {};
  if(AO.opacity !== undefined && AO.opacity > 0){
    const RP = (AO.spread !== undefined) ? AO.spread : 1.7;
    const pw = (FP.hx + RP)*2, pd = (FP.hz + RP)*2;
    const geo = new THREE.PlaneGeometry(pw, pd, AO.seg || 36, AO.seg || 36);
    geo.rotateX(-Math.PI/2);
    const base = terrainHeight(FP.cx, FP.cz);
    const lift = (AO.lift !== undefined) ? AO.lift : 0.035;
    const p = geo.attributes.position;
    for(let i=0;i<p.count;i++){
      /* 逐顶点贴地形：地形不是平面，平铺一张就会一角插进土里、一角浮起来 */
      p.setY(i, terrainHeight(p.getX(i)+FP.cx, p.getZ(i)+FP.cz) - base + lift);
    }
    const mat = new THREE.MeshBasicMaterial({
      map: makeBedAoTexture(AO.textureSize || 256, {
        fu: FP.hx/(FP.hx+RP), fz: FP.hz/(FP.hz+RP),
        w: pw, d: pd, spread: RP,
        opacity: AO.opacity, color: AO.color || '#2f3a26'
      }),
      transparent:true, depthWrite:false, fog:true
    });
    const patch = new THREE.Mesh(geo, mat);
    patch.position.set(FP.cx, base, FP.cz);
    patch.renderOrder = 1;
    grp.add(patch);
    grp.userData.aoSize = [ +pw.toFixed(2), +pd.toFixed(2) ];
  }

  grp.userData.footprint = {
    src: FP.src, cx: +FP.cx.toFixed(3), cz: +FP.cz.toFixed(3),
    hx: +FP.hx.toFixed(3), hz: +FP.hz.toFixed(3)
  };
  return grp;
}

/* ------------------------------------------------------------
   梯杆：圆角矩形截面沿 Y 扫掠（顶端按 taper 收分），两端封口。
   比 BoxGeometry 好得多 —— 盒子的每个面各带一份独立顶点，棱角永远是硬的
   （computeVertexNormals 也救不了）；这里同一个环上的顶点被侧面共享，
   算出来就是连续光滑的圆角杆。
   截面用超椭圆（指数 2/n）⇒ 四边平、四角圆，像一根打磨过的木杆。
   ------------------------------------------------------------ */
function makeRailGeometry(len, hw, hd, taper, seg, rings){
  const N = seg   || 14;
  const R = rings || 12;
  const P = 2/3.2;                                     // 超椭圆指数（越大越接近方）
  const pos = [], idx = [];
  for(let r=0;r<=R;r++){
    const v = r/R, y = -len/2 + len*v, k = 1 - v*taper;
    for(let i=0;i<N;i++){
      const a = i/N*Math.PI*2, ca = Math.cos(a), sa = Math.sin(a);
      pos.push(Math.sign(ca)*Math.pow(Math.abs(ca), P)*hw*k, y,
               Math.sign(sa)*Math.pow(Math.abs(sa), P)*hd*k);
    }
  }
  for(let r=0;r<R;r++) for(let i=0;i<N;i++){
    const a = r*N + i, b = r*N + (i+1)%N;
    idx.push(a, a+N, b,  b, a+N, b+N);
  }
  /* 两端封口（扇形；底面朝 -Y、顶面朝 +Y，绕序与侧面一致） */
  [[0,-1],[R,1]].forEach(([r,s])=>{
    const ci = pos.length/3;
    pos.push(0, -len/2 + len*(r/R), 0);
    for(let i=0;i<N;i++){
      const a = r*N + i, b = r*N + (i+1)%N;
      if(s < 0) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildLadder(L, bedTopY){
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color:new THREE.Color(L.color),
    roughness:(L.roughness !== undefined) ? L.roughness : 0.45,
    metalness:(L.metalness !== undefined) ? L.metalness : 0.04
  });
  const len = L.length;
  const railGeo = makeRailGeometry(len, (L.railWidth || 0.17)/2, (L.railDepth || 0.13)/2,
                                   (L.taper !== undefined) ? L.taper : 0.28,
                                   L.railSegments, L.railRings);
  [[0.44],[-0.44]].forEach(([x])=>{
    const r = new THREE.Mesh(railGeo, mat);
    r.position.x = x; r.castShadow=true; g.add(r);
  });
  const n = Math.floor(len/0.78);
  const rungGeo = new THREE.CylinderGeometry(L.rungRadius || 0.045, L.rungRadius || 0.045, 0.86, L.rungSegments || 12);
  rungGeo.rotateZ(Math.PI/2);
  for(let i=1;i<=n;i++){
    const rung = new THREE.Mesh(rungGeo, mat);
    rung.position.y = -len/2 + i*0.78; rung.castShadow = true; g.add(rung);
  }
  const rot = L.rotation || [0,0,0];
  g.rotation.order = L.rotationOrder || 'XYZ';   // YXZ：rotation[1] 控制"往哪个方向倾斜"
  g.rotation.set(rot[0], rot[1], rot[2]);

  if(L.bottom){
    // 以「梯脚」定位（更直观）：bottom = 梯子最下端在世界中的位置
    const bx = L.bottom[0];
    const bz = L.bottom[2];
    const by = (L.bottom[1]===null) ? (bedTopY || 0) + (L.bottomOffsetY || 0) : L.bottom[1];
    // 几何中心在梯子中点，故从脚点沿梯子轴向回退半个长度
    const half = new THREE.Vector3(0,1,0).applyEuler(g.rotation).multiplyScalar(L.length/2);
    g.position.set(bx + half.x, by + half.y, bz + half.z);
  }else{
    g.position.set(L.position[0], L.position[1], L.position[2]);
  }

  /* 行走 rig：角色沿梯轴逐级攀爬所需的信息（脚点 / 轴向 / 横档间距） */
  const up = new THREE.Vector3(0,1,0).applyEuler(g.rotation);
  const halfLen = L.length/2;
  const hl = Math.hypot(up.x, up.z) || 1;
  g.userData.rig = {
    foot: [g.position.x - up.x*halfLen, g.position.y - up.y*halfLen, g.position.z - up.z*halfLen],
    up:   [up.x, up.y, up.z],
    length: L.length,
    step:   L.rungStep || 0.78,
    off:    [ up.z/hl*0.42, -up.x/hl*0.42 ]     // 站在轴旁（贴梯而不穿模）
  };
  return g;
}

/* ============================================================
   蝴蝶：床边绕飞。
   一只蝴蝶 = 一个 billboard 平面。纹理画成「近白」（只留深色翅脉/描边），
   实例色 tint 出白 / 淡紫 / 暖黄；扇翅 = 横向量按 |cos| 收缩——
   正面看过去就是两只翅膀在开合，不需要骨骼或骨骼动画。
   轨道是椭圆 + 两套慢噪声扰动（半径抖动、高度起伏），避免机械的圆周运动。
   ============================================================ */
function makeButterflyTexture(size, B){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const S = size/128;                                   // 以 128 为设计基准
  const WING = B.wing || '#ffffff', TIP = B.wingTip || '#eee9ff';
  const VEIN = B.vein || 'rgba(70,60,105,0.55)', BS = B.wingShade || '#4a4166';
  const BD = B.body || '#413a5c';

  /* 一片翅膀：先在右半边用绝对坐标画，再镜像出左边（g.scale(-1,1)） */
  const wing = (side, fore) => {
    g.save();
    g.translate(64*S, 0); g.scale(side, 1); g.translate(-64*S, 0);
    g.beginPath();
    if(fore){                                           // 前翅：向上外方展开
      g.moveTo(52*S, 60*S);
      g.bezierCurveTo(66*S, 40*S, 92*S, 22*S, 112*S, 30*S);
      g.bezierCurveTo(126*S, 37*S, 108*S, 58*S, 54*S, 64*S);
    }else{                                              // 后翅：向下外方的圆瓣
      g.moveTo(52*S, 66*S);
      g.bezierCurveTo(78*S, 68*S, 108*S, 74*S, 106*S, 92*S);
      g.bezierCurveTo(104*S, 108*S, 74*S, 104*S, 52*S, 82*S);
    }
    g.closePath();
    const gr = g.createLinearGradient(60*S, 56*S, 118*S, 34*S);
    gr.addColorStop(0, WING); gr.addColorStop(1, TIP);
    g.fillStyle = gr; g.fill();
    g.strokeStyle = BS; g.lineWidth = 1.5*S; g.stroke();
    g.restore();
  };
  wing(1, true); wing(-1, true); wing(1, false); wing(-1, false);

  /* 翅脉：从翅根向翅缘散开的细线（镜像时自动跟着走） */
  const veins = (side, list) => {
    g.save();
    g.translate(64*S, 0); g.scale(side, 1); g.translate(-64*S, 0);
    g.strokeStyle = VEIN; g.lineWidth = 1.0*S; g.lineCap = 'round';
    list.forEach(([tx,ty,cx2,cy2])=>{
      g.beginPath(); g.moveTo(56*S, 56*S);
      g.quadraticCurveTo(cx2*S, cy2*S, tx*S, ty*S); g.stroke();
    });
    g.fillStyle = VEIN;
    list.forEach(([tx,ty])=>{
      g.beginPath(); g.arc((tx-10)*S, (ty+8)*S, 3.0*S, 0, Math.PI*2); g.fill();
    });
    g.restore();
  };
  const FORE_V = [[108,34, 88,48],[116,44, 92,52],[100,56, 84,56]];
  const HIND_V = [[104,88, 84,76],[96,102, 78,88]];
  veins(1, FORE_V); veins(-1, FORE_V);
  veins(1, HIND_V); veins(-1, HIND_V);

  /* 身体 + 头 + 触角 */
  g.fillStyle = BD;
  g.beginPath(); g.ellipse(64*S, 68*S, 3.8*S, 21*S, 0, 0, Math.PI*2); g.fill();
  g.beginPath(); g.arc(64*S, 40*S, 5.4*S, 0, Math.PI*2); g.fill();
  g.strokeStyle = BD; g.lineWidth = 1.3*S; g.lineCap = 'round';
  [-1, 1].forEach(s => {
    g.beginPath(); g.moveTo(64*S, 37*S);
    g.quadraticCurveTo((64+s*9)*S, 23*S, (64+s*19)*S, 15*S); g.stroke();
    g.beginPath(); g.arc((64+s*19)*S, 15*S, 2.3*S, 0, Math.PI*2); g.fill();
  });

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildButterflies(cfg, bed, camera){
  const B = (cfg && cfg.butterflies) ? cfg.butterflies : null;
  if(!B || !B.count) return null;
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({
    map: makeButterflyTexture(B.textureSize || 128, B),
    alphaTest: (B.alphaTest !== undefined) ? B.alphaTest : 0.34,
    side: THREE.DoubleSide, roughness: 1, metalness: 0
  });
  if(B.glow){                                    // 梦核：翅面自带的柔光
    mat.emissiveMap = mat.map;
    mat.emissive = new THREE.Color(B.glowColor || '#fff2e0');
    mat.emissiveIntensity = B.glow;
  }
  const n = Math.max(1, B.count|0);
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;

  const [rxLo, rxHi] = B.radiusX || [1.9, 3.0];
  const [rzLo, rzHi] = B.radiusZ || [2.7, 3.9];
  const [hLo,  hHi ] = B.height  || [0.45, 1.9];
  const [sLo,  sHi ] = B.size    || [0.30, 0.55];
  const [spLo, spHi] = B.speed   || [0.20, 0.46];
  const [flLo, flHi] = B.flap    || [7.5, 13];
  const R = Math.random;
  const cx = (B.center ? B.center[0] : bed.position.x);
  const cz = (B.center ? B.center[1] : bed.position.z);
  const y0 = bed.position.y + bedSurfaceHeight(cfg.bed);

  /* ---- 巡航轨道：默认「绕白菊飞」，不再绕床 ----
     【为什么不绕床】床是个 4.7×3.4 的大矩形，绕它转的轨道半径得给到 2~4 米，
     飞起来像四只虫子沿着一条看不见的跑道巡逻；而且旧的高度基准是**床被面**
     （离地 2.3 米），终点是「在半空绕着床飞」，完全读不出「被花吸引」。
     白菊一簇才一米出头，把轨道缩到这簇花的尺度里、高度基准换成**花簇脚下的地面**，
     再让每只蝴蝶认领一簇（簇数不够就轮着来），才像蝴蝶该在的地方。
     每只再带一点自己的中心偏移，四只不会叠在同一条轨道上。
     配置：butterflies.flight = "flowers"（默认）| "bed"（旧行为）；
     显式写了 butterflies.center 也退回旧行为，方便做对照。 */
  const DC = (cfg.daisies && Array.isArray(cfg.daisies.clusters) && cfg.daisies.clusters.length)
             ? cfg.daisies.clusters : null;
  const flowerMode = (B.flight !== 'bed') && !B.center && !!DC;
  const orbits = flowerMode ? DC.map(cc => {
    const ox = cc.center[0], oz = cc.center[1];
    const orx = (cc.rx !== undefined) ? cc.rx : ((cc.radius !== undefined) ? cc.radius : 1.4);
    const orz = (cc.rz !== undefined) ? cc.rz : ((cc.radius !== undefined) ? cc.radius : 1.4);
    return {
      ox, oz, orx, orz,
      /* 高度基准取花簇脚下那块地形 —— 花是种在起伏地面上的，用床面高度会飘。 */
      gy: terrainHeight(ox, oz) + ((cc.yOffset !== undefined) ? cc.yOffset : 0.02)
    };
  }) : null;
  const [fLo, fHi] = B.flowerRadius || [0.40, 0.80];    // 轨道占花簇椭圆的半径比例
  const [gLo, gHi] = B.flowerHeight || [0.32, 0.74];    // 相对花簇地面的高度（米）
  const fDrift     = (B.flowerDrift !== undefined) ? B.flowerDrift : 0.32;  // 各只的轨道中心偏移
  const [pfLo, pfHi] = B.speedFlower || [0.30, 0.64];   // 绕小轨道要提速，否则像悬停
  const T  = B.tint || { h:[0.70,0.78], s:[0.02,0.42], l:[0.86,0.99] };   // 默认淡紫→白
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  const roll = new THREE.Quaternion(), ZAX = new THREE.Vector3(0,0,1);
  const bs = [];
  for(let i=0;i<n;i++){
    const orb = orbits ? orbits[i % orbits.length] : null;
    const b = {
      a:  R()*Math.PI*2,                          // 轨道起始角
      hs: 0.30 + R()*0.45,                        // 高度起伏频率
      fl: flLo + R()*(flHi - flLo),               // 扇翅频率 Hz
      fp: R()*Math.PI*2,
      s:  sLo + R()*(sHi - sLo),
      tilt: (B.tilt !== undefined ? B.tilt : 0.42),
      p: [R()*6.283, R()*6.283, R()*6.283]
    };
    if(orb){
      /* 花簇模式：轨道中心 = 花簇中心 + 每只自己的小偏移；半径 = 花簇椭圆按比例收缩。
         收缩后的轨道落在花丛**内部**，蝴蝶是在花里穿、在花上点的，不是绕整片花丛转圈。 */
      const k = fLo + R()*(fHi - fLo);
      b.rx  = orb.orx * k;
      b.rz  = orb.orz * k;
      b.ox  = orb.ox + (R()*2 - 1) * orb.orx * fDrift;
      b.oz  = orb.oz + (R()*2 - 1) * orb.orz * fDrift;
      b.y0  = orb.gy;
      b.h   = gLo + R()*(gHi - gLo);
      b.spd = pfLo + R()*(pfHi - pfLo);
    }else{
      b.rx  = rxLo + R()*(rxHi - rxLo);
      b.rz  = rzLo + R()*(rzHi - rzLo);
      b.ox  = cx; b.oz = cz;
      b.y0  = y0;
      b.h   = hLo + R()*(hHi - hLo);
      b.spd = spLo + R()*(spHi - spLo);
    }
    bs.push(b);
    col.setHSL(T.h[0]+R()*(T.h[1]-T.h[0]), T.s[0]+R()*(T.s[1]-T.s[0]), T.l[0]+R()*(T.l[1]-T.l[0]));
    mesh.setColorAt(i, col);
  }
  if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  mesh.userData.update = (t)=>{
    for(let i=0;i<n;i++){
      const b = bs[i];
      const a  = b.a + t*b.spd;
      const x  = b.ox + Math.cos(a)*b.rx*(1 + 0.10*Math.sin(t*0.53 + b.p[0]));
      const z  = b.oz + Math.sin(a)*b.rz*(1 + 0.08*Math.sin(t*0.41 + b.p[1]));
      const u  = 0.5 + 0.5*Math.sin(t*b.hs + b.p[2]);          // 高度起伏
      const fp = t*b.fl*Math.PI*2 + b.fp;                      // 扇翅相位
      const f  = Math.pow(Math.abs(Math.cos(fp)), 0.75);       // 1 = 全展，0 = 收拢
      const y  = b.y0 + b.h*(0.85 + 0.30*u) + 0.05*Math.sin(fp);  // b.h = 距基准面的高度
      dummy.position.set(x, y, z);
      dummy.quaternion.copy(camera.quaternion);                // 正面朝向相机
      roll.setFromAxisAngle(ZAX, b.tilt*Math.sin(a + b.p[0])); // 绕视线轴侧倾（转向感）
      dummy.quaternion.multiply(roll);
      const sc = b.s*(0.88 + 0.12*f);
      dummy.scale.set(sc*(0.30 + 0.70*f), sc, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  return mesh;
}

/* ============================================================
   闪烁高光（glint）：床板侧面 / 梯杆上的星芒点。
   - 一块加法混合的 billboard，纹理是「光晕 + 十字星芒 + 硬核」
   - 亮度不靠 opacity（每实例各不同），而是把亮度乘进实例色：
     加法混合下 color→0 就等于消失，于是每个点可以独立闪烁
   - 位置挂在床 / 梯子的局部坐标上，父级带旋转也能贴住（父级矩阵每帧取）
   ============================================================ */
function makeGlintTexture(size, G){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const h = size/2, S = size/128;
  const halo = g.createRadialGradient(h,h,0, h,h,h);
  halo.addColorStop(0.00, 'rgba(255,255,255,1)');
  halo.addColorStop(0.10, 'rgba(255,255,255,0.80)');
  halo.addColorStop(0.30, 'rgba(255,255,255,0.22)');
  halo.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = halo; g.fillRect(0, 0, size, size);
  const streak = (ang, len, wid, a) => {          // 一条两端渐隐的细亮线
    g.save(); g.translate(h, h); g.rotate(ang);
    const gr = g.createLinearGradient(-len, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,'+a+')');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-len, -wid/2, len*2, wid);
    g.restore();
  };
  streak(0,            h*0.96, 2.2*S, 0.95);
  streak(Math.PI/2,    h*0.96, 2.2*S, 0.95);
  streak(Math.PI/4,    h*0.58, 1.4*S, 0.50);
  streak(-Math.PI/4,   h*0.58, 1.4*S, 0.50);
  const core = g.createRadialGradient(h,h,0, h,h,h*0.17);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.5, 'rgba(255,255,255,0.72)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core; g.beginPath(); g.arc(h, h, h*0.17, 0, Math.PI*2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildGlints(cfg, bed, ladder, camera){
  const G = (cfg && cfg.glints) ? cfg.glints : null;
  if(!G) return null;
  const V = THREE.Vector3;
  /* ---- 1) 收集锚点：局部坐标 + 可滑动的方向轴 ---- */
  const list = [];
  const { bw, bd } = bedHalfLocal(cfg);   // 局部空间，组缩放由 matrixWorld 负责
  const BG = G.bed || {};
  if(BG.count){
    const yLo = (BG.yFrom !== undefined) ? BG.yFrom : 0.34;
    const yHi = (BG.yTo   !== undefined) ? BG.yTo   : 0.94;
    const out = (BG.outset !== undefined) ? BG.outset : 0.03;
    const faces = [                                   // 四块床板侧面：n=法线, t=沿板面的切向
      { n:[ 1,0,0], t:[0,0,1], e:bw, w:bd },
      { n:[-1,0,0], t:[0,0,1], e:bw, w:bd },
      { n:[0,0, 1], t:[1,0,0], e:bd, w:bw },
      { n:[0,0,-1], t:[1,0,0], e:bd, w:bw }
    ];
    for(let i=0;i<BG.count;i++){
      const f = faces[i % faces.length];
      const s = (Math.random()*2 - 1) * f.w * ((BG.spread !== undefined) ? BG.spread : 0.74);
      const y = yLo + Math.random()*(yHi - yLo);
      const nrm = new V(f.n[0], 0, f.n[2]);
      list.push({
        parent: bed, drift: (BG.drift !== undefined) ? BG.drift : 0.09,
        local: new V(f.n[0]*(f.e + out) + f.t[0]*s, y, f.n[2]*(f.e + out) + f.t[2]*s),
        axis:  new V(f.t[0], 0, f.t[2]).normalize(),
        nrm,                                              // 外法线（吸附用）
        probe: new V(f.n[0]*(f.e + 1.6) + f.t[0]*s, y, f.n[2]*(f.e + 1.6) + f.t[2]*s)
      });
    }
  }
  const LG = G.ladder || {};
  if(LG.count){
    const len = cfg.ladder.length || 10;
    const yFrom = (LG.yFrom !== undefined) ? LG.yFrom : (-len/2 + 0.5);
    const yTo   = (LG.yTo   !== undefined) ? LG.yTo   : (-len/2 + (LG.span || 7.5));
    const out = (LG.outset !== undefined) ? LG.outset : 0.025;
    const per = Math.max(1, Math.ceil(LG.count/2));
    for(let i=0;i<LG.count;i++){
      const sx = (i % 2 === 0) ? 1 : -1;              // 两根梯杆交替
      const sz = (i % 4 < 2) ? 1 : -1;                // 杆的前 / 后两面交替（总有一面朝着相机）
      const j = i >> 1;
      const k = j / Math.max(1, per - 1);
      const y = yFrom + (yTo - yFrom)*(k + (Math.random() - 0.5)*0.35/Math.max(1, per));
      const taper = 1 - ((y/len) + 0.5)*0.28;         // 与 buildLadder 的收分一致
      list.push({
        parent: ladder, drift: (LG.drift !== undefined) ? LG.drift : 0.16,
        local: new V(sx*0.44 + (Math.random()-0.5)*0.05, y, sz*(0.065*taper + out)),
        axis:  new V(0, 1, 0),                        // 沿梯杆上下滑动 → 流光感
        ph0:   -j*(LG.chase !== undefined ? LG.chase : 0)   // 相位逐级错开 = 光点顺杆往上跑
      });
    }
  }
  if(!list.length) return null;

  /* ---- 2) 网格与逐点参数 ---- */
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: makeGlintTexture(G.textureSize || 128, G),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide
  });
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  const [sLo, sHi] = G.size || [0.13, 0.28];
  const [spLo, spHi] = G.speed || [1.6, 4.6];
  const PAL = (G.palette && G.palette.length) ? G.palette : ['#ffe6a8','#ffd6a8','#dcd0ff','#cfeaff'];
  const R = Math.random;
  const gs = list.map((A,i)=>{
    const c = new THREE.Color(PAL[i % PAL.length]);
    return {
      A,
      spd: spLo + R()*(spHi - spLo),
      ph:  R()*Math.PI*2 + (A.ph0 || 0),
      sharp: (G.sharp !== undefined) ? G.sharp : 4.5,   // 越大 → 尖闪（亮的时间越短）
      base: (G.base  !== undefined) ? G.base  : 0.10,   // 常亮底（不会完全消失）
      gain: (G.gain  !== undefined) ? G.gain  : 1.55,   // 峰值亮度（>1 = HDR 感）
      size: sLo + R()*(sHi - sLo),
      ds:   0.25 + R()*0.45,
      dp:   R()*Math.PI*2,
      r: c.r, g: c.g, b: c.b
    };
  });
  const dummy = new THREE.Object3D(), col = new THREE.Color(), v = new V();
  const paint = (t)=>{
    for(let i=0;i<gs.length;i++){
      const q = gs[i], A = q.A;
      v.copy(A.local).addScaledVector(A.axis, Math.sin(t*q.ds + q.dp)*A.drift);
      v.applyMatrix4(A.parent.matrixWorld);              // 父级（床 / 梯）带旋转也贴得住
      const k = Math.pow(Math.max(0, Math.sin(t*q.spd + q.ph)), q.sharp);
      const br = A.dead ? 0 : (q.base + k*q.gain);
      dummy.position.copy(v);
      dummy.quaternion.copy(camera.quaternion);          // 高光永远正对相机
      const s = A.dead ? 0 : q.size*(0.55 + 0.85*k);
      dummy.scale.set(s, s, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, col.setRGB(q.r*br, q.g*br, q.b*br));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  paint(0);
  mesh.userData.update = paint;
  mesh.userData.count = gs.length;
  mesh.userData.anchors = list;
  return mesh;
}

/* GLB 床的内部形状是未知的：把「床侧」的高光用一条水平射线贴到真实表面上，
   否则高光会漂在空气里或者埋进床垫。射线只打被子/床板这类可见网格。 */
function snapGlintsToBed(glints, bed, cfg){
  const G = (cfg && cfg.glints) ? cfg.glints : null;
  if(!glints || !G || !G.bed || G.bed.snap === false) return 0;
  const list = glints.userData.anchors;
  if(!list) return 0;
  /* 关键：GLB 刚 add 进床组时，它的 matrixWorld 还是「没乘父级」的旧值
     （Raycaster 不会自己刷新矩阵），必须先整体刷一遍，否则整张床的射线全打偏。 */
  bed.updateMatrixWorld(true);
  const V = THREE.Vector3;
  const rc = new THREE.Raycaster(); rc.far = 8;
  const inv = new THREE.Matrix4().copy(bed.matrixWorld).invert();
  const o = new V(), d = new V(), nrm = new V(), nm = new THREE.Matrix3();
  const vis = (ob)=>{ let p = ob; while(p){ if(p.visible === false) return false; p = p.parent; } return true; };
  const outset = (G.bed.snapOutset !== undefined) ? G.bed.snapOutset : 0.035;
  let hit = 0;
  list.forEach(a => {
    if(a.parent !== bed || !a.nrm) return;
    o.copy(a.probe).applyMatrix4(bed.matrixWorld);            // 床外 1.6m 的水平起点
    nm.getNormalMatrix(bed.matrixWorld);
    nrm.copy(a.nrm).applyMatrix3(nm).normalize();
    d.copy(nrm).negate();
    rc.set(o, d);
    const hits = rc.intersectObject(bed, true).filter(h => vis(h.object) && h.distance < 3.0);
    if(!hits.length){ a.dead = true; return; }                // 打空：这块板不在这里 → 干脆不显示，别漂在空气里
    a.local.copy(hits[0].point).applyMatrix4(inv)             // 命中点 → 回到床局部坐标
      .addScaledVector(a.nrm, outset);
    hit++;
  });
  if(hit) glints.userData.update(0);
  return hit;
}

function buildCloud(scene, C, SUN_DIR){
  const texes = (C.textureSeeds || [0]).map(s => makeCloudTexture(C.textureSize || 256, s, C.texture));
  const center = new THREE.Vector3(...C.center);
  const [CRX, CRY, CRZ] = C.radii;

  /* ---- 风：让云「活」起来（原地微动方案）--------------------------------------
     硬约束（用户明确提的两条）：**整朵云不产生可见的整体变化**、
     **每一片 billboard 的位移不超过它自己的尺寸**。
     所以这里不做任何「穿云而过」的搬运 —— 那属于整朵云的宏观变化，
     而且云片本身极大（宽 s*1.8，s ∈ 2.8~5.6 ⇒ 单片宽 5~10 米，
     而整朵云半径才 10.5 米），一搬运就等于整朵云在变形。

     现在每一片只做三件事，全都围绕它自己的「家」位置（home）：
       ① 游移：沿「风向 / 水平垂直 / 竖直」三个方向各叠一个慢正弦，
          总幅度 ≤ drift × 自身尺寸（drift=0.45 ⇒ 来回总行程 ≈ 一个自身大小），
          所以云芯不动、云边也不会跑出椭球，剪影基本恒定。
       ② 自转：billboard 贴图自身小幅来回摆（±rot 弧度）。
       ③ 呼吸：尺寸做 ±breathe 的缓慢缩放，补上「边缘在翻涌」的观感，
          不产生任何位移。
     ⚠ ①②③ 都必须是「来回摆」而不是「一直转 / 一直漂」：
       云片是横向拉长的长方形（puffScale 1.8:0.85），累积自转迟早把它转到竖着，
       整朵云会散成一团松散的棉絮（实测过：每片随机初相位就是这个后果）。

     ★ 关键一条：**只有内芯动，外圈几乎不动**（wind.inner 窗口）。
       云片是又大又软的 1.8:0.85 长方形（宽 5~10 米），整朵云的半径才 10.5 米 ——
       外圈那几十片直接撑起云的外轮廓，它们只要挪一点点、转几度，整个剪影就胖一圈。
       实测（旋转单独作用、drift/breathe 都为 0）：仅仅 ±7° 的自转就让画面里的
       粉色覆盖面积 +12%、形心漂 11 px；位移 +10%。两者叠加 +22%，云明显发虚变大。
       归一化椭球半径 rN（0 = 云心，1 = 云面）算出每片的「内芯权重」wk，
       外圈的 wk → 0（完全静止，与旧版逐像素一致），内芯 wk → 1 全速搅动。
       于是「里面的云在慢慢转动」看得见，而整朵云的轮廓一个像素都不变。 */
  const W = C.wind || {};
  const W_DIR = new THREE.Vector3(
      Array.isArray(W.dir) ? W.dir[0] : 1, 0,
      Array.isArray(W.dir) ? W.dir[1] : 0.55).normalize();
  const W_H  = new THREE.Vector3().crossVectors(W_DIR, new THREE.Vector3(0,1,0)).normalize();
  const W_Y  = new THREE.Vector3(0,1,0);
  const drift   = (W.drift   !== undefined) ? W.drift   : 0.30;
  const rate    = (W.rate    !== undefined) ? W.rate    : 0.30;
  const rotAmp  = (W.rot     !== undefined) ? W.rot     : 0.25;
  const rotRate = (W.rotRate !== undefined) ? W.rotRate : 0.15;
  const breathe = (W.breathe !== undefined) ? W.breathe : 0.03;
  /* 内芯窗口（归一化椭球半径）：≤ LO 全速动，≥ HI 完全不动，中间平滑过渡；
     第三个元素是幂次（把过渡做得更陡：外圈权重掉得更快，剪影更稳）。
     实测 rN 分布：p25 0.38 / p50 0.54 / p75 0.69 / p90 0.83 / p97 0.94 / max 1.12，
     所以 [0.55, 0.95, 2] 大致是「内芯 55% 的云片全速、外圈 10% 几乎不动」。 */
  const IN_LO = (Array.isArray(W.inner) && W.inner.length >= 2) ? W.inner[0] : 0.55;
  const IN_HI = (Array.isArray(W.inner) && W.inner.length >= 2) ? W.inner[1] : 0.95;
  const IN_P  = (Array.isArray(W.inner) && W.inner.length >= 3) ? W.inner[2] : 2;
  /* 总增益：把游移/自转/呼吸一起缩放。1 = 按上面各值；0 = 完全静止（等于旧版静态云）。
     它是在渲染循环里实时读的（见 updateCloudFlow），所以能不改配置就随时改 ——
     验证时可以在同一次页面加载、同一张「无云基线」下扫一串幅度做严格对照。 */
  const gain = (W.gain !== undefined) ? W.gain : 1;
  /* ---- 碰云（poke）：玩家碰到/戳到云时，局部云片被推一下再弹回来 ----------
     和「风」是两套独立的东西，互不干扰：
       · 风是**每片自己围着自己家位置**的慢速振荡，永远不累积、幅度 ≤ drift×自身尺寸；
       · 碰云是**以接触点为中心的一记冲量**，只有半径 R 内的云片吃到，
         每片再走一个「弹簧 + 阻尼」把偏移拉回 0。
     所以碰到云是「局部鼓一下 / 陷一下，然后自己恢复」，整朵云的位置与轮廓
     不会被推走 —— 这正是用户要的「局部动一下下然后回弹」。
     三个硬性约束（前两条沿用风机那套）：
       ① 单片的位移上限 = min(自身宽度 × maxRel, absMax)，谁都不能移出自己的尺度；
       ② 回弹要真的回到 0（下面是显式弹簧积分 + 死区归零），
          静止之后与「没有碰云」逐像素一致；
       ③ 内芯权重 wk 不参与 —— 碰到的是云面，云面必须能动，
          但因为幅度小且迅速回弹，不会把整朵云撑胖。 */
  const PK = C.poke || {};
  const POKE_ON   = (PK.enabled !== undefined) ? PK.enabled : true;
  const pSpring   = (PK.spring  !== undefined) ? PK.spring  : 7.0;  // 回弹刚度（ω ≈ 2.65 rad/s：慢慢鼓回来）
  const pDamp     = (PK.damp    !== undefined) ? PK.damp    : 3.5;  // 阻尼（ζ ≈ 0.66：过冲一下就稳住）
  const pMaxRel   = (PK.maxRel  !== undefined) ? PK.maxRel  : 1.0;  // 单片位移上限（相对自身宽度）
  const pAbsMax   = (PK.absMax  !== undefined) ? PK.absMax  : 3.8;  // 单片位移硬上限（米）
  /* 「削薄」：被推开的云片同时变透，位移越大越透。
     ⚠ 实测下来这一路**默认要关**（thin = 0）。原因：位移把云片从接触点推开之后，
     视觉上唯一明显的变化是「四周边缘被推得更厚、更亮」；而这一路会把这些被推开的片
     一起变透，正好把那份变亮抵消掉 —— 同一机位、同一相位下差异像素从 14707 掉到 8991。
     它是留给调参用的旋钮（想让洞显得「薄、透」时可以给 0.2~0.3），不是默认手感。 */
  const pThin     = (PK.thin    !== undefined) ? PK.thin    : 0;
  /* 不占用 Math.random() 序列：否则新增的随机数会把后面每一片的贴图/大小/颜色
     全部错位，改前改后的图就没法逐像素对比了。 */
  const hash = i => { const x = Math.sin(i*127.1 + 311.7)*43758.5453; return x - Math.floor(x); };

  // 软投影：云团正下方地面的淡阴影
  if(0 && C.shadow){
    const sc=document.createElement('canvas'); sc.width=sc.height=128;
    const sg=sc.getContext('2d');
    const fa = (C.shadow.falloff !== undefined) ? C.shadow.falloff : 0.45;
    const sgr=sg.createRadialGradient(64,64,4,64,64,64);
    sgr.addColorStop(0, hexToRgba(C.shadow.color, C.shadow.opacity));
    sgr.addColorStop(fa, hexToRgba(C.shadow.color, C.shadow.opacity*(C.shadow.midAlpha||0.42)));
    sgr.addColorStop(1, hexToRgba(C.shadow.color, 0));
    sg.fillStyle=sgr; sg.fillRect(0,0,128,128);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(C.shadow.size, C.shadow.size),
      new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(sc), transparent:true, depthWrite:false, fog:true })
    );
    shadow.rotation.x = -Math.PI/2;
    shadow.position.set(center.x, terrainHeight(center.x, center.z)+0.05, center.z);
    shadow.renderOrder = 1;
    scene.add(shadow);
  }

  // 由大量小 billboard 累加出厚重云团
  const cloudGroup = new THREE.Group();
  scene.add(cloudGroup);
  const puffs = [];                       // 供「相机进云时让开」使用（见 updateCloudFade）
  PUFF_N = Math.max(1, Math.round(C.puffCount * CLOUD_Q));
  /* 每个 puff 自带材质、还各配一块投影 Plane ⇒ draw call 约 2×puff 数。
     移动档砍数量时要把单片的 alpha 提上去补偿，否则云会整体变透。
     （alpha 叠乘，故用 1/sqrt(k) 而非 1/k） */
  const OP_BOOST = (CLOUD_Q < 1) ? Math.min(1.6, 1/Math.sqrt(CLOUD_Q)) : 1;
  const [smin, smax] = C.puffSize;
  const [pw, ph] = C.puffScale;
  const [opMin, opMax] = C.opacity;
  const topC = new THREE.Color(C.colors.top),
        botC = new THREE.Color(C.colors.bottom),
        midC = C.colors.mid ? new THREE.Color(C.colors.mid) : null,
        backC = new THREE.Color(C.colors.backlit);
  for(let i=0;i<PUFF_N;i++){
    let ax=0, ay=0, az=0; const K=3;
    for(let k=0;k<K;k++){ ax+=Math.random()*2-1; ay+=Math.random()*2-1; az+=Math.random()*2-1; }
    ax/=K; ay/=K; az/=K;
    const pos = new THREE.Vector3(center.x+ax*CRX, center.y+ay*CRY, center.z+az*CRZ);
    /* 采样是三个均匀数的均值（Irwin-Hall），偶尔会落在椭球外一点点。
       微动方案不重建位置，所以这里不需要再夹轴向坐标。 */
    const off  = pos.clone().sub(center);
    const dir  = off.clone().normalize();
    /* 归一化椭球半径：0 = 云心，1 = 云面。
       它决定这一片「能动多少」—— 外圈云片撑起整朵云的剪影，必须基本不动，
       否则整朵云会随云片一起胖一圈（见函数头 ★ 段）。 */
    const rN  = Math.hypot(off.x/CRX, off.y/CRY, off.z/CRZ);
    const wIn = Math.pow(1 - THREE.MathUtils.smoothstep(rN, IN_LO, IN_HI), IN_P);
    const lit = THREE.MathUtils.clamp(dir.dot(SUN_DIR)*0.5+0.5, 0, 1);            // 0背光 1向阳
    const yN  = THREE.MathUtils.clamp((pos.y-(center.y-CRY))/(2*CRY), 0, 1);     // 0底 1顶
    // 三段配色：底部深粉 → 中部糖果粉 → 顶部白
    const col = midC
      ? (yN > 0.5 ? midC.clone().lerp(topC, (yN-0.5)*2)
                  : botC.clone().lerp(midC, yN*2))
      : topC.clone().lerp(botC, (1-yN)*0.8);
    col.lerp(backC, (1-lit)*0.30);                                              // 背光偏冷暗紫
    const bright = THREE.MathUtils.clamp(0.55 + 0.35*lit + 0.20*yN, 0.5, 1.05);
    col.multiplyScalar(bright);
    const mat = new THREE.SpriteMaterial({ map: texes[(Math.random()*texes.length)|0], transparent:true,  fog:true, });
    mat.color.copy(col);
    /* 同样先定 opacity 再 regTint（regTint 会把当时的 opacity 记成基线）。
       体积云目前没起用 veil，所以顺序反了也不出错 —— 但留着这个坑迟早要踩。 */
    mat.opacity = Math.min(1, (opMin + (opMax-opMin)*yN) * OP_BOOST);
    regTint(TINT_CLOUD, mat);           // 云色烘在材质上 ⇒ 夜间整体压成冷蓝
    const sp = new THREE.Sprite(mat);
    const s = smin + Math.random()*(smax-smin);
    sp.scale.set(s*pw, s*ph, 1);   // 长方形：横向拉长
    /* 每片云装进一个「节点」：Sprite 与它那块投影圆盘都挂在节点下，
       节点位置 = 这一片云的位置。随风流动时靠移动节点，
       两者不会脱节（那块圆盘本身在画面里看不见，它负责在草地上投出云影）。 */
    const node = new THREE.Group();
    node.position.copy(pos);
    node.add(sp);


// --- 2. 创建不可见的投影平面 (Shadow Caster) ---
    // 这个 Plane 将跟随 Sprite 的位置和大小，并负责投射阴影
    const shadowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
 map: texes[(Math.random()*texes.length)|0],
        side: THREE.BackSide,
        depthWrite: false,
transparent:true,
opacity:0.5
 
    });

    shadowMat.color.copy(col);

     // const shadowPlaneGeometry = new THREE.PlaneGeometry(1, 1); // 专门用于投影的平面

const radius = 0.3;
const segments = 10;
const shadowPlaneGeometry = new THREE.CircleGeometry(radius, segments);

    const shadowPlane = new THREE.Mesh(shadowPlaneGeometry, shadowMat);
    
    // 调整阴影平面的大小，通常比云稍大或相同，取决于你想要的阴影范围
    // 这里假设阴影与云同大小，你可以根据需要放大，例如 * 1.2
    shadowPlane.scale.set(s*pw, s*ph, 1); 
    
    // 关键：启用阴影投射
    shadowPlane.castShadow = true;
    shadowPlane.receiveShadow = false; // 不需要接收阴影
    
    // 让阴影平面也朝向相机（如果需要它始终覆盖云的背后）或者朝向灯光方向（如果是硬阴影）
    // 对于软阴影/投影到地面，通常 Plane 应该水平放置 (rotation.x = -Math.PI/2) 如果它是地面阴影
    // 但既然你说“作为投影的透明体”，且跟随 Sprite，这里我们让它保持与 Sprite 一致的 Billboard 朝向
    // 注意：Mesh 不会自动 Billboard，需要手动更新 lookAt
    
    // 为了让阴影正确投射到地面，通常阴影平面应该是一个接收光照的实体。
    // 但如果只是想要一个“不可见的投射源”，我们可以简单地让它朝向灯光方向，或者朝向相机。
    // 这里选择朝向相机，与 Sprite 同步，确保阴影源位置准确。
    shadowPlane.lookAt( sun.position ); 
    
    // 标记以便在动画循环中更新朝向
    shadowPlane.userData.isBillboard = true;
    shadowPlane.userData.syncWithSprite = sp; // 可选：如果需要严格同步位置
    shadowPlane.renderOrder = 10;
    node.add(shadowPlane);
    cloudGroup.add(node);
    /* 朝向太阳要在「挂进节点之后」算：lookAt 取的是世界位置，
       节点还没接进 cloudGroup 时它算出的是从原点看太阳，方向会全错。
       节点只会平移、不会旋转，所以这份朝向一直有效。 */
    shadowPlane.lookAt( sun.position );

    /* 这一片「怎么动」——全都相对它自己的家位置，永不累积：
       home  家位置（世界坐标，云团整体永不位移）；
       amp   位移幅度（米）= drift × 自身尺寸 × 内芯权重 ⇒
             位移既被自己的大小封顶，外圈还被权重压到 0；
       wk    内芯权重（0 = 完全静止，1 = 全速搅动）；
       rateK / rotK 每片不同的频率倍率 + 相位，免得 360 片整齐划一。 */
    puffs.push({
      node, sp, plate: shadowPlane, baseOp: mat.opacity, plateOp: shadowMat.opacity,
      home: pos.clone(),
      rN, wk: wIn,
      amp: s * drift * wIn,
      rateK: 0.7 + hash(i*2.17)*0.6,
      rotK:  0.7 + hash(i*3.91)*0.6,
      ph:  hash(i*5.37)*Math.PI*2,
      ph2: hash(i*7.13)*Math.PI*2,
      ph3: hash(i*9.71)*Math.PI*2,
      w0: s*pw, h0: s*ph,                // 原始尺寸，供「呼吸」缩放
      /* 碰云：off = 相对家位置的弹性偏移，vel = 它的速度。
         平时恒为 0（pokeLive = false），只有被戳到才动，回弹到位后自动归零。 */
      off: new THREE.Vector3(), vel: new THREE.Vector3(),
      pokeLive: false, peak: 0, thin: 0,
      pokeCap: Math.min(s*pw*pMaxRel, pAbsMax)
    });

  }
  /* 涟漪：碰云的可见反馈（接触点泛开一圈光晕）。
     池化 8 个 sprite 循环复用，不动态建对象 —— 一次碰云最多 1 圈，
     连点也不会超过 8 个同时存在。 */
  const rippleTex = POKE_ON ? makeRippleTexture(160) : null;
  const ripples = [];
  if(rippleTex){
    for(let i=0;i<8;i++){
      const m = new THREE.SpriteMaterial({ map: rippleTex, transparent: true, depthWrite: false,
                                           depthTest: false, blending: THREE.AdditiveBlending,
                                           color: 0xffd9f2, opacity: 0 });
      const sp = new THREE.Sprite(m);
      sp.visible = false; sp.renderOrder = 40;
      cloudGroup.add(sp);
      ripples.push({ sp, life: -1, max: 0.95, size: 1 });
    }
  }
  cloudGroup.userData.ripples = ripples;
  cloudGroup.userData.puffs = puffs;
  cloudGroup.userData.flow  = { W_DIR, W_H, W_Y,
                                drift, rate, rotAmp, rotRate, breathe,
                                IN_LO, IN_HI, IN_P, gain,
                                poke: { on: POKE_ON, spring: pSpring, damp: pDamp, thin: pThin } };
  return cloudGroup;
}

/* 涟漪贴图：一圈「中间透、边缘亮、最外圈再淡掉」的软环。
   加法混合叠在云上，像碰一下水面泛开的光。
   峰值 alpha 刻意压得很低（0.30）：加法混合在云这种已经接近白的粉色上
   会迅速饱和，环一亮就变成一只硬边白圈，比云本身还抢眼。 */
function makeRippleTexture(size){
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const c = size/2;
  const grd = g.createRadialGradient(c, c, size*0.02, c, c, c);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.00)');
  grd.addColorStop(0.22, 'rgba(255,240,252,0.04)');
  grd.addColorStop(0.44, 'rgba(255,252,255,0.15)');
  grd.addColorStop(0.60, 'rgba(255,255,255,0.30)');
  grd.addColorStop(0.76, 'rgba(255,232,248,0.17)');
  grd.addColorStop(0.89, 'rgba(255,214,240,0.05)');
  grd.addColorStop(1.00, 'rgba(255,200,235,0.00)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------
   碰云：把一记冲量打进「接触点周围的一小撮云片」
   ------------------------------------------------------------
   point  ：接触点（世界坐标）
   opt.radius  ：影响半径（米）—— 真正决定「局部」有多小
   opt.amount  ：目标峰值位移（米，权重为 1 的那片）
   opt.dir     ：所有云片同向推（点击 = 顺着视线戳进去，压出一个小坑）
   opt.radial  ：每片沿「接触点 → 自己」的方向散开（人钻进云里，云往两边让）
   返回被影响到（权重 > 0）的云片数。
   速度冲量 = 目标位移 × ω（ω = √k）：欠阻尼弹簧的峰值位移 ≈ v/ω，
   所以「想推多远」可以直接写在配置里，不用反推速度。 */
function puffPoke(grp, point, opt){
  const list = grp && grp.userData && grp.userData.puffs;
  const f    = grp && grp.userData && grp.userData.flow;
  if(!list || !f || !f.poke || !f.poke.on) return 0;
  const P = grp.userData.pokeCfg || {};
  const o = opt || {};
  const R  = (o.radius !== undefined) ? o.radius : (P.radius !== undefined ? P.radius : 3.1);
  const am = (o.amount !== undefined) ? o.amount : (P.amount !== undefined ? P.amount : 1.3);
  const omega = Math.sqrt(f.poke.spring);
  const dir = o.dir || null;
  const radial = !!o.radial;
  const hx = point.x, hy = point.y, hz = point.z;
  /* —— 先定「这一记到底管多大范围」——
     云片是随机撒在椭球里的，接触点落在云面上时附近本来就稀（实测同一个
     半径下，运气差的位置只有 2~3 片够得着 —— 那几片吃到的权重还很小，
     位移 2 厘米，等于没碰）。所以这里不直接用配置半径：
     先找「第 NEAR_N 近的那片」有多远，最终半径取 max(R, 它 × 1.1)。
     于是结果只有两种：位置够密 ⇒ 按 R 收口（局部）；位置太稀 ⇒ 至少动到
     最近的 NEAR_N 片（保证戳下去一定看得见）。 */
  const NEAR_N = (o.minCount !== undefined) ? o.minCount
               : (P.minCount !== undefined ? P.minCount : 40);
  let Rn = R;
  if(NEAR_N > 0 && list.length > NEAR_N){
    const best = [];
    for(let i=0;i<list.length;i++){
      const h = list[i].home;
      const dx = h.x-hx, dy = h.y-hy, dz = h.z-hz;
      const d2 = dx*dx + dy*dy + dz*dz;
      if(best.length < NEAR_N){ best.push(d2); best.sort((a,b)=>a-b); }
      else if(d2 < best[NEAR_N-1]){ best[NEAR_N-1] = d2; best.sort((a,b)=>a-b); }
    }
    if(best.length === NEAR_N) Rn = Math.max(R, Math.sqrt(best[NEAR_N-1]) * 1.1);
  }
  const R2 = Rn*Rn;
  /* 权重窗口（0~1 的归一化距离）：内圈满幅、往外平滑收口。
     窗口从 [0.05, 0.75] 放宽到 [0.2, 1.0] —— 目的是「一个球范围内整片都动」，
     而不是只有最中间几片动、外面拖一条几乎看不见的尾巴。 */
  const inner = o.inner || P.inner || [0.2, 1.0];
  /* 竖直方向收一点：云的形变以横向为主，纯径向扩散会让云「长高」而不「变宽」。 */
  const ys = (o.yScale !== undefined) ? o.yScale
           : (P.yScale  !== undefined ? P.yScale  : 0.85);
  let n = 0;
  for(let i=0;i<list.length;i++){
    const it = list[i], h = it.home;
    const dx = h.x-hx, dy = h.y-hy, dz = h.z-hz;
    const d2 = dx*dx + dy*dy + dz*dz;
    if(d2 > R2) continue;
    const d = Math.sqrt(d2) || 1e-4;
    /* 权重：核心全速 + 外圈拖尾。窗口偏「内紧外松」—— 看得见的那几片必须
       拿满幅，否则 0.5 米的位移在 17 米宽的云上根本看不出来。 */
    const w = 1 - THREE.MathUtils.smoothstep(d/Rn, inner[0], inner[1]);
    if(w <= 0) continue;
    /* 径向单位向量（从接触点指向这一片）：球范围内的片都按这个方向散开，
       于是接触点被「挖空」、四周鼓起来 —— 这就是「搓了个洞」的成因。 */
    const inv = 1/d;
    const rx = dx*inv, ry = dy*inv, rz = dz*inv;
    let ux, uy, uz;
    if(radial){
      ux = rx; uy = ry; uz = rz;
      if(dir){
        /* 混一路「往 dir 推」的前分量。dir 由调用方给：点击时指的是**镜头方向**
           （往前、往玩家身上），所以洞口是朝观察者张开的 —— 往外扩散负责「挖洞」，
           朝镜头推负责「让玩家看见自己把云推动过」。
           不要把它做成纯深度位移：那样子弹从屏幕里飞出去，玩家什么都看不到。 */
        const b = (o.dirBias !== undefined) ? o.dirBias
                : (P.dirBias !== undefined ? P.dirBias : 0.55);
        ux += dir.x*b; uy += dir.y*b; uz += dir.z*b;
      }
    }else if(dir){
      ux = dir.x; uy = dir.y; uz = dir.z;
    }else{
      ux = rx; uy = ry; uz = rz;
    }
    const ul = Math.hypot(ux, uy, uz) || 1;
    const v = am * w * omega;
    it.vel.x += ux/ul * v;
    it.vel.y += uy/ul * v * ys;
    it.vel.z += uz/ul * v;
    it.pokeLive = true;
    n++;
  }
  return n;
}

/* 碰云的可见反馈：在接触点放一圈正在扩散的光晕 */
function rippleAt(grp, point, size){
  const list = grp && grp.userData && grp.userData.ripples;
  if(!list || !list.length) return false;
  let slot = null;
  for(let i=0;i<list.length;i++){ if(list[i].life < 0){ slot = list[i]; break; } }
  if(!slot) slot = list[0];                       // 都在播就抢最老的那个
  slot.life = 0; slot.size = size || 4;
  slot.sp.position.copy(point);
  slot.sp.visible = true;
  slot.sp.material.opacity = 0.30;
  return true;
}

/* 涟漪推进：0.95 秒内从 0.8× 扩散到 1.6×，同时淡出 */
function updateRipples(grp, dt){
  const list = grp && grp.userData && grp.userData.ripples;
  if(!list || !list.length) return;
  for(let i=0;i<list.length;i++){
    const r = list[i];
    if(r.life < 0) continue;
    r.life += dt;
    const k = r.life / r.max;
    if(k >= 1){ r.life = -1; r.sp.visible = false; r.sp.material.opacity = 0; continue; }
    const s = r.size * (0.8 + k*0.8);
    r.sp.scale.set(s, s, 1);
    r.sp.material.opacity = 0.30 * Math.pow(1-k, 1.7);
  }
}

/* 让云「活」起来（t = 场景开始以来的秒数）。
   每片云都围着自己的家位置（home）做三个**互不累积**的慢速振荡：
     ① 位移：沿「风向 / 水平垂直 / 竖直」三个方向的正弦叠加，
        总幅度 ≤ amp（= drift × 自身尺寸）—— 位移被它自己的大小封顶；
     ② 自转：贴图自身 ±rotAmp 来回摆；
     ③ 呼吸：尺寸做 ±breathe 的缓慢缩放。
   三者都绕 home 做正弦，所以位置与姿态永远不漂走：整朵云的剪影、密度、
   体积感恒定不变，只有内部在缓慢翻涌。
   （早先那版「沿风向穿过整朵云」会让单片位移达到云体半径量级 ——
     云片宽 5~10 米、整朵云半径才 10.5 米，那等于整朵云在变形，已废弃。） */
function updateCloudFlow(grp, t, dt){
  const f = grp && grp.userData && grp.userData.flow;
  const list = grp && grp.userData && grp.userData.puffs;
  if(!f || !list) return;
  const { W_DIR, W_H, W_Y, drift, rate, rotAmp, rotRate, breathe, gain } = f;
  /* 总增益在每帧读取（不是建云时定死），所以运行中可以直接改 __dbg.cloud.userData.flow.gain
     来扫幅度、做同基线的严格对照。gain = 0 ⇒ 每片都回到 build 时的原值 = 旧版静态云。 */
  const G = (gain !== undefined) ? gain : 1;
  const still = (!(G > 0) || (!(drift > 0) && !(rotAmp > 0) && !(breathe > 0)));
  /* —— 碰云的弹簧积分 ——
     显式半隐式欧拉（先更新速度再更新位置）在 dt ≤ 0.02s 时无条件稳定；
     无头浏览器一帧可能只有 0.1s，所以要拆子步，否则回弹会「炸开」。
     回弹到位后（位移与速度都进了死区）把两个量硬写成 0：
     这样「没在碰」的云片与静止档逐像素一致。 */
  const K = (f.poke && f.poke.spring) || 26;
  const D = (f.poke && f.poke.damp)   || 4.6;
  const THIN = (f.poke && f.poke.thin !== undefined) ? f.poke.thin : 0;
  const step = (dt > 0) ? Math.min(dt, 0.1) : 0;
  const sub  = Math.max(1, Math.min(8, Math.ceil(step/0.02)));
  const h    = step / sub;
  for(let i=0;i<list.length;i++){
    const it = list[i], home = it.home;
    /* 外圈云片（wk = 0）在风里完全静止：位置/角度/尺寸一律写回原值，
       保证整朵云的剪影与「静止档」逐像素一致。
       （碰云的偏移是另一条线，下面照样叠加 —— 它不是「风」。） */
    const wind = !still && it.wk >= 0.002;
    let px = home.x, py = home.y, pz = home.z;
    if(wind){
      /* —— ① 位移：三个轴各一个慢正弦，频率与相位按片错开 —— */
      const amp = it.amp * G;
      if(amp > 0){
        const r = rate * it.rateK;
        const a1 = Math.sin(r*t      + it.ph ) * amp;         // 沿风向
        const a2 = Math.sin(r*t*0.83 + it.ph2) * amp*0.45;    // 水平垂直
        const a3 = Math.sin(r*t*0.67 + it.ph3) * amp*0.35;    // 竖直
        px += W_DIR.x*a1 + W_H.x*a2 + W_Y.x*a3;
        py += W_DIR.y*a1 + W_H.y*a2 + W_Y.y*a3;
        pz += W_DIR.z*a1 + W_H.z*a2 + W_Y.z*a3;
      }
      /* —— ② 自转：±rotAmp×wk×gain 来回摆，绝不累积 —— */
      it.sp.material.rotation = rotAmp*it.wk*G * Math.sin(rotRate*it.rotK*t + it.ph2);
      /* —— ③ 呼吸：只改尺寸、不动位置（投影圆盘同步，免得地面云影脱节） —— */
      const k = 1 + breathe*it.wk*G * Math.sin(rotRate*1.37*it.rateK*t + it.ph3);
      it.sp.scale.set(it.w0*k, it.h0*k, 1);
      it.plate.scale.set(it.w0*k, it.h0*k, 1);
    }else{
      it.sp.material.rotation = 0;
      it.sp.scale.set(it.w0, it.h0, 1);
      it.plate.scale.set(it.w0, it.h0, 1);
    }
    /* —— ④ 碰云回弹：把冲量积分成偏移，再叠到风的位置上 —— */
    if(it.pokeLive && h > 0){
      for(let s2 = 0; s2 < sub; s2++){
        const o = it.off, v = it.vel;
        v.x += (-K*o.x - D*v.x) * h;
        v.y += (-K*o.y - D*v.y) * h;
        v.z += (-K*o.z - D*v.z) * h;
        o.x += v.x * h; o.y += v.y * h; o.z += v.z * h;
        const d = o.length();
        if(d > it.pokeCap){                      // 自家尺度就是硬上限
          o.multiplyScalar(it.pokeCap / d);
          const ux = o.x/it.pokeCap, uy = o.y/it.pokeCap, uz = o.z/it.pokeCap;
          const vr = v.x*ux + v.y*uy + v.z*uz;   // o 是长度 = cap 的向量 ⇒ o/cap 就是单位径向
          if(vr > 0){ v.x -= ux*vr; v.y -= uy*vr; v.z -= uz*vr; }   // 抹掉继续往外推的那部分速度
        }
      }
      if(it.off.lengthSq() < 6e-6 && it.vel.lengthSq() < 2.5e-3){
        /* 死区：位移还不到 2.5 毫米、速度也不到 5 厘米/秒 ⇒ 直接归零。
           这一步必须「真的写回 0」，否则「碰过之后」的云和「从没碰过」的云
           永远差着一点点像素，做 A/B 对照时会被当成真实差异。 */
        it.off.set(0, 0, 0); it.vel.set(0, 0, 0); it.pokeLive = false; it.thin = 0;
      }
      const dl = it.off.length();
      if(dl > it.peak) it.peak = dl;          // 峰值位移：验证「这一记推了多远」
      /* 削薄：位移到「自家上限的一半」就削满，否则只有最中心那几片才有洞感。
         和位移同源，所以回弹到 0 时它也是精确的 0 ⇒ 不留残留。 */
      it.thin = Math.min(1, dl / Math.max(it.pokeCap*0.5, 1e-3)) * THIN;
      px += it.off.x; py += it.off.y; pz += it.off.z;
    }
    it.node.position.set(px, py, pz);
  }
}

/* 相机钻进云里时让云让开 —— 两种情况都得管：
   ---------------------------------------------------------------
   ① 贴着镜头的那几片：云是几百张 billboard 叠透明度堆出来的，就算只站在
      云团边缘，眼前一片半透明也是糊满屏。以相机为中心、半径 near 米内的片按
      距离淡出（越近越透），等于在云里挖个小球。
   ② 整个人在云团内部时：只挖小球不够 —— 往外看还是穿过十几米厚的云。这时
      按「相机在云团椭球里的深度」把整朵云一起变透：e = 椭球归一化距离，
      乘上 min(1, e³)。e ≥ 1（在云外）时系数恒为 1 ⇒ 从地面/远处看云一个像素
      都不变，只有真的钻进去才透。
   梯子顶端正好整段在云团内部，爬到顶那一下如果什么都不做，屏幕就是一片粉白。 */
function updateCloudFade(grp, cam, near, inside, C){
  const list = grp && grp.userData && grp.userData.puffs;
  if(!list) return;
  const cp = cam.position;
  let g = 1;
  if(inside && C && C.center && C.radii){
    const e = Math.hypot((cp.x-C.center[0])/C.radii[0],
                         (cp.y-C.center[1])/C.radii[1],
                         (cp.z-C.center[2])/C.radii[2]);
    /* 曲线必须够陡：360 片云片沿视线叠几十层，透明度叠乘会饱和 ——
       减到 25% 依旧是一片粉白，要压到几个百分点才真的看得见外面。
       e ≤ 0.5（云心附近）⇒ 基本透明；e → 1（云团边缘）⇒ 恢复原样。 */
    if(e < 1){ const t = Math.min(1, Math.max(0, (e-0.5)/0.5)); g = Math.max(0.03, t*t*t); }
  }
  const R2 = (near > 0) ? near*near : 0;
  for(let i=0;i<list.length;i++){
    const it = list[i];
    /* it.node.position 就是这一片的世界位置（cloudGroup 自身不带变换）。
       随风流动之后位置每帧都在变，所以这里必须每帧重算，不能缓存。 */
    const p = it.node.position;
    let k = g;
    if(R2){
      const dx = p.x-cp.x, dy = p.y-cp.y, dz = p.z-cp.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      if(d2 < R2){ const t = Math.sqrt(d2)/near; k *= t*t; }
    }
    /* 最终不透明度 = 基础值 × 让位系数（镜头在云里）。
       （微动方案不再改透明度：云片只在原地游移，没有「生出来/消失掉」，
       所以这里没有随风渐变项。） */
    const op = it.baseOp * k * (1 - (it.thin || 0));
    if(Math.abs(it.sp.material.opacity - op) > 0.003) it.sp.material.opacity = op;
    if(it.plate){
      const po = it.plateOp * k;
      if(Math.abs(it.plate.material.opacity - po) > 0.003) it.plate.material.opacity = po;
    }
  }
}

/* ------------------------------------------------------------
   碰云控制器：两种「碰」
   ------------------------------------------------------------
   ① 接触（contact）：镜头/玩家进到云团椭球内部 ⇒ 云在自己身前让开一下。
      云团中心离地 12.87 米、半径 8.5×4.6×6.4，地面上够不到 ——
      所以这个只有两种触发方式：漫游爬到梯顶，或者自由视角把镜头推进云里。
      每次触发都有间隔（默认 0.55s），且要求「真的移动了 0.6 米以上」，
      站着不动时退化成 2.2 秒一次的轻微呼吸式推挤，不会嗡嗡抖。
   ② 点击（tap）：射线打到云团椭球面上，顺着视线方向戳进去压一个小坑。
      点在屏幕上「按下→抬起」位移 < 7px 且 < 420ms 才算数，
      否则会把「拖拽转视角」误判成戳云。
   ============================================================ */
function setupCloudPoke(scene, grp, camera, dom, cfg, AUD){
  const C  = cfg.cloud || {};
  const CP = C.poke || {};
  const dflt = (v, d) => (v !== undefined ? v : d);
  const P = {
    radius:        dflt(CP.radius,        6.2),   // 点击戳：影响球半径（米）
    amount:        dflt(CP.amount,        4.2),   // 点击戳：速度系数 ⇒ 峰值位移 ≈ 0.63×它
    tapRadius:     dflt(CP.tapRadius,     6.2),
    tapAmount:     dflt(CP.tapAmount,     4.2),
    /* 影响球里「至少动几片」。云片是随机撒的，运气差的位置半径内只有寥寥几片，
       那就不是「一个球范围内的片都动」，所以给一个保底片数。 */
    minCount:      dflt(CP.minCount,      40),
    /* 径向散开 + 往镜头推的配比。0 = 纯径向扩散（挖洞但缺少「推动感」），
       1 = 纯顺视线推（只改深度，玩家看不出来）。0.5~0.6 两头都占。 */
    dirBias:       dflt(CP.dirBias,       0.55),
    /* 权重窗口的归一化距离 [起, 止]：里面满幅、外面收到 0 */
    inner:         CP.inner || [0.2, 1.0],
    yScale:        dflt(CP.yScale,        0.85),  // 竖直分量的缩放（云的形变以横向为主）
    contact:       dflt(CP.contact,       true),
    contactRadius: dflt(CP.contactRadius, 5.4),
    /* 接触的幅度要比点击小得多：回弹变慢之后（ω 2.65 而不是 5.5），
       走路时每隔 0.8 秒来一记，位移来不及回落就会一层层叠上去。 */
    contactAmount: dflt(CP.contactAmount, 1.0),
    inside:        dflt(CP.inside,        0.94),  // 归一化椭球距离 < 此值 = 人在云里
    interval:      dflt(CP.interval,      0.8),   // 两次接触推挤的最小间隔（秒）
    idleInterval:  dflt(CP.idleInterval,  2.2),   // 没怎么动时的间隔
    travel:        dflt(CP.travel,        0.6),   // 「真的动了」的位移阈值（米）
    tap:           dflt(CP.tap,           true),
    ripple:        dflt(CP.ripple,        true),
    chime:         dflt(CP.chime,         true),
    chimeTap:      dflt(CP.chimeTap,      0.85),
    chimeContact:  dflt(CP.chimeContact,  0.3)
  };
  grp.userData.pokeCfg = P;                 // puffPoke 从这里读默认半径/幅度

  /* 云团椭球的「不可见拾取体」：只用它算点与法向，不参与渲染 */
  const pick = new THREE.Mesh(
    new THREE.SphereGeometry(1, 28, 18),
    new THREE.MeshBasicMaterial({ visible: false }));
  pick.position.set(C.center[0], C.center[1], C.center[2]);
  pick.scale.set(C.radii[0], C.radii[1], C.radii[2]);
  pick.matrixAutoUpdate = false;
  pick.updateMatrix(); pick.updateMatrixWorld(true);
  scene.add(pick);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const right = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const stat = { pokes: 0, taps: 0, contacts: 0, lastN: 0, lastAt: -1, trace: [] };
  /* 最近 12 条「碰云手势」的流水账：点击没生效时用它一眼看出卡在哪一步
     （__dbg.cloudStat().trace，或 __dbg.pokeTrace）。 */
  function trace(s){ stat.trace.push(s); if(stat.trace.length > 12) stat.trace.shift(); }

  function hitAt(cx, cy){
    const r = dom.getBoundingClientRect();
    if(!r.width || !r.height) return null;
    ndc.set(((cx - r.left)/r.width)*2 - 1, -((cy - r.top)/r.height)*2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(pick, false);
    return hits.length ? hits[0] : null;
  }

  /* 真正戳一下：把冲量打进接触点周围的云片，再给一圈涟漪 + 一声星铃。
     铃声按接触点相对镜头的左右做声像，云在右边响在右边。 */
  function doPoke(point, opt){
    const o = opt || {};
    const n = puffPoke(grp, point, o);
    if(n <= 0) return 0;
    stat.pokes++; stat.lastN = n; stat.lastAt = (typeof performance !== 'undefined') ? performance.now()/1000 : 0;
    const rad = (o.radius !== undefined) ? o.radius : P.radius;
    if(P.ripple && !o.noRipple) rippleAt(grp, point, rad * 0.9);
    if(P.chime && AUD && AUD.chime){
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      tmp2.copy(point).sub(camera.position);
      const pan = THREE.MathUtils.clamp(tmp2.dot(right) / 14, -1, 1);
      AUD.chime({ strength: dflt(o.chime, P.chimeTap), pan });
    }
    return n;
  }

  let hinted = false;
  function firstTouchHint(){
    if(hinted) return;
    hinted = true;
    if(window.__hintFlash) window.__hintFlash('碰到云了 · 云会漾开一下再回弹', 2400);
  }

  /* ---- 点击 / 轻触 ---- */
  let down = null;
  dom.addEventListener('pointerdown', e => {
    if(!P.tap) return;
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, q: camera.quaternion.clone() };
    trace('down id=' + e.pointerId + ' ' + e.pointerType + ' b' + e.button);
  });
  dom.addEventListener('pointerup', e => {
    if(!P.tap || !down || down.id !== e.pointerId){
      trace('up 忽略 id=' + e.pointerId + ' have=' + !!down + ' tap=' + P.tap);
      return;
    }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    /* 区分「轻点」和「拖拽转视角」：只看屏幕位移是不够的 ——
       绕一圈又回到原点的拖拽位移也是 0；所以再比一下镜头朝向有没有转过
       （> 0.7° 就算在转视角）。
       ⚠ 不要用「按下到抬起的时间」来判断：低帧率设备（含无头浏览器）上
       pointerdown / pointerup 会被主线程排在一起处理，两者的事件时间戳
       能差一两秒，轻点会被误判成长按，点击戳云直接失效。 */
    const turned = camera.quaternion.angleTo(down.q);
    down = null;
    if(moved > 7 || turned > 0.012){
      trace('up 拖拽/转视角 moved=' + moved.toFixed(1) + ' turned=' + turned.toFixed(4));
      return;
    }
    const hit = hitAt(e.clientX, e.clientY);
    if(!hit){ trace('up 未命中云 (' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ')'); return; }
    /* dir 是「从接触点指向镜头」的方向（把 ray 的方向反过来）——
       也就是玩家视角的「往前」。puffPoke 会拿它和径向散开做混合：
       径向负责把接触点那一片挖空，往前负责让洞口朝玩家张开。 */
    const dir = ray.ray.direction.clone().normalize().negate();
    /* 点击用「径向散开 + 往镜头推」，而不是纯顺视线推：
       纯顺视线推 = 云片沿着视线方向前后挪，等于只改了深度 ——
       从点击者自己的角度看几乎什么都看不出来（第一版就是这样，
       截图对照里几乎找不到差异）。径向散开是「在接触点把云面拨开」，
       垂直于视线的那一部分位移在屏幕上直接可见。 */
    const n = doPoke(hit.point, { dir, radial: true, radius: P.tapRadius, amount: P.tapAmount, chime: P.chimeTap });
    trace('up 命中 n=' + n + ' (' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ')');
    if(n > 0){
      stat.taps++;
      firstTouchHint();
      if(window.__hintFlash && stat.taps === 1) window.__hintFlash('戳了一下云', 1500);
    }
  });
  dom.addEventListener('pointercancel', () => { down = null; });

  /* ---- 接触：镜头钻进云里 ---- */
  const lastP = new THREE.Vector3();
  let lastAt = -99, haveLast = false;
  function update(dt, t){
    updateRipples(grp, dt);
    if(!P.contact || !C.center || !C.radii) return;
    const cp = camera.position;
    const e = Math.hypot((cp.x - C.center[0])/C.radii[0],
                         (cp.y - C.center[1])/C.radii[1],
                         (cp.z - C.center[2])/C.radii[2]);
    if(e > P.inside){ haveLast = false; return; }
    const moved = haveLast ? cp.distanceTo(lastP) : 1e9;
    const gap = t - lastAt;
    if(gap < P.interval) return;
    if(moved < P.travel && gap < P.idleInterval) return;
    const n = doPoke(cp, { radial: true, noRipple: true,
                           radius: P.contactRadius, amount: P.contactAmount,
                           chime: P.chimeContact });
    lastP.copy(cp); haveLast = true; lastAt = t;
    if(n > 0){ stat.contacts++; firstTouchHint(); }
  }
  update.stats = stat;
  update.doPoke = doPoke;
  update.hitAt = hitAt;
  update.cfg = P;
  update.pick = pick;
  return update;
}

/* 远处天空的大 billboard 云：不用 fog（否则会直接消失），改用人工空气透视 */
function buildFarClouds(scene, F){
  const grp = new THREE.Group();
  const seeds = F.seeds || [0.0, 1.7, 3.3];
  const texes = seeds.map(s => makeCloudTexture(F.textureSize || 512, s, F.texture));
  const baseCol = new THREE.Color(F.color || '#ffffff');
  const hazeCol = new THREE.Color(F.haze  || '#bdaeea');
  const [rmin, rmax] = F.radius;
  const [ymin, ymax] = F.y;
  const [smin, smax] = F.size;
  const [omin, omax] = F.opacity;
  const aspect = F.aspect || 2.2;
  const count  = F.count || 12;
  const hazeBase = (F.hazeMix !== undefined) ? F.hazeMix : 0.25;
  /* ⚠ 尺寸护栏（重要，别删）——
     Sprite 永远是「正对相机」的四边形：它不是在世界里摆一块板，
     而是把贴图按 scale 直接在视空间里撑开。所以半宽一旦逼近它到相机的
     距离，四边形就会横跨半个屏幕，贴图被极端拉伸后四边形的**直边**原样
     露出来 —— 画面上是一大块带硬边的浅色板，把天空渐变整个洗掉。
     实测：远景云第二组（aspect 4.2 / size 760 / radius 950）就是这个病，
     隐藏它画面差异高达 35%（bbox 覆盖整片天空）。
     下面按「半宽 ≤ (到相机的最小可能距离) × maxHalfRatio」反推尺寸上限；
     CAM_PAD 是留给步行/漫游模式里相机离开原点的那点余量。 */
  const SAFE    = (F.maxHalfRatio !== undefined) ? F.maxHalfRatio : 0.5;
  const CAM_PAD = (F.camPad       !== undefined) ? F.camPad       : 100;
  let clamped = 0;
  for(let i=0;i<count;i++){
    const a = (i/count)*Math.PI*2 + (Math.random()-0.5)*0.6;
    const r = rmin + Math.random()*(rmax - rmin);
    const k = THREE.MathUtils.clamp((r - rmin)/Math.max(rmax - rmin, 1e-3), 0, 1);   // 0 近 1 远
    const mat = new THREE.SpriteMaterial({ map: texes[i % texes.length], transparent:true, depthWrite:false, fog:false });
    mat.color.copy(baseCol).lerp(hazeCol, hazeBase + 0.5*k).multiplyScalar(1 - 0.22*k);
    /* ⚠ 顺序有讲究：必须**先**把 opacity 定下来，再 regTint。
       regTint 会把当时的 mat.opacity 记成 baseOpacity（往后的乘雾淡出都从它算），
       而 SpriteMaterial 的 opacity 默认是 1 —— 先注册就相当于把基线记成 1，
       applyCloudVeil 每次都会把透明度写回 1，远云从「0.1~0.5 的半透明纱」
       变成一块块实心板。 */
    mat.opacity = (omin + Math.random()*(omax-omin)) * (1 - 0.45*k);
    regTint(TINT_BG, mat, { veil: true });   // 远云 fog:false ⇒ 夜里要自己染色、起雾时还要自己淡出
    mat.rotation = (Math.random()-0.5) * (F.rotationJitter !== undefined ? F.rotationJitter : 0.35);
    const sp = new THREE.Sprite(mat);
    sp.position.set(Math.cos(a)*r, ymin + Math.random()*(ymax-ymin), Math.sin(a)*r);
    let sz = smin + Math.random()*(smax-smin);
    /* 半宽 = sz*aspect/2，要求 ≤ SAFE*(r - CAM_PAD) ⇒ sz ≤ 2*SAFE*(r-CAM_PAD)/aspect */
    const szMax = 2*SAFE*Math.max(r - CAM_PAD, 1) / aspect;
    if(sz > szMax){ sz = szMax; clamped++; }
    sp.scale.set(sz*aspect, sz, 1);
    grp.add(sp);
  }
  if(clamped) console.warn('[farClouds] ' + clamped + '/' + count + ' 片因尺寸护栏被夹小（maxHalfRatio=' + SAFE + '）');
  scene.add(grp);
  return grp;
}

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
  const lookAt = new THREE.Vector3().copy(controls.target);
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
    lookAt.copy(camera.position).add(tmp.multiplyScalar(12));
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
  /* 漫游提示条：默认文字由模式决定；落到带 hint 的步骤时换成那句话并保持常亮 */
  function baseHint(){
    return mode === 'walk' ? '左半屏拖动走动 · 右半屏拖动转视角 · 走到床/梯子会自动攀爬 · 跳跃＝右下按钮或空格 · 碰到云会漾开'
         : mode === 'roam' ? '自动巡游：原地转向梯子 → 飞过去 → 沿梯爬升 → 停在顶端'
         : '点击云朵可以戳一下 · 拖动旋转 · 滚轮缩放';
  }
  function refreshHint(){
    hint.textContent = baseHint();
    hint.classList.remove('hold');
    hint.style.opacity = (mode === 'free') ? 0.9 : 1;
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
    if(st.hold)             return false;              // 停住：这一步永远不完成
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
    }else if(st.fly){
      flyStep(dt, st);                                 // 自己写位置，下面不再走 movePlayer
    }

    if(!st.fly) movePlayer(dt, wx, wz, jump, climbDir, false);

    const eyeY = P.foot + eye;
    if(tgt) aimCamera(dt, tgt);
    else if(Math.hypot(wx, wz) > 0.01) aimCamera(dt, aimT.set(P.x + wx*16, eyeY - 1.0, P.z + wz*16));

    /* 超时保护：hold 步骤不吃这套（它就该一直停着） */
    const mx = (st.max !== undefined) ? st.max : (st.hold ? Infinity : 18);
    if(routeDone(st) || run.t > mx){
      run.i = (run.i + 1) % route.length; run.t = 0;
      stepHint(route[run.i]);
    }
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
      controls.target.copy(lookAt);
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

  /* 调试出口：控制台里可以直接看角色状态（无头脚本也靠它判断进度） */
  window.__rig = {
    P, get mode(){ return mode; }, setMode, rig,
    get step(){ return run.i; }
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
    lookAt.copy(controls.target);
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
   三行胶囊按钮，挂在左上角（BGM 播放器下面）：
     时相  1-4   下午 / 清晨 / 日落 / 夜间      → atmos.apply(name)
     滤镜  5-9   四档梦核 + 原片               → postfx.set(name)
     雾    F     在「小雾 / 超大雾」之间硬切    → atmos.toggleFog()

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

  /* ---- 雾档（瞬时硬切，没有过渡动画；按钮闪一下只是给个触觉反馈） ---- */
  const fogBtn = mkBtn('雾', () => {
    const heavy = atmos.toggleFog();
    syncFog();
    hint(heavy ? '雾档 · 超大雾（世界没了）' : '雾档 · 小雾', 1100);
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
      hint(heavy ? '雾档 · 超大雾（世界没了）' : '雾档 · 小雾', 900); e.preventDefault();
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
  MOUND  = (cfg.terrain && cfg.terrain.mound ) ? cfg.terrain.mound  : null;
  RANGES = (cfg.terrain && cfg.terrain.ranges) ? cfg.terrain.ranges : null;
  MICRO  = (cfg.terrain && cfg.terrain.micro ) ? cfg.terrain.micro  : null;
  BROAD  = (cfg.terrain && cfg.terrain.broad ) ? cfg.terrain.broad  : null;

  /* 渲染器 */
  const RM = cfg.renderer || {};
  const MB = RM.mobile || {};
  const useMobile = AUTO_MOBILE && MB.enabled !== false;
  if(useMobile){
    if(MB.quality      !== undefined) QUALITY   = MB.quality;
    if(MB.pixelRatioMax!== undefined) PR_CAP    = MB.pixelRatioMax;
    if(MB.cloudPuffs   !== undefined) CLOUD_Q   = MB.cloudPuffs;
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

  /* 控制器 */
  const controls = new OrbitControls(camera, renderer.domElement);
  const ct = cfg.controls.target; controls.target.set(ct[0], ct[1], ct[2]);
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
    sun = new THREE.DirectionalLight(new THREE.Color(L.sun.color), L.sun.intensity);
  sun.position.set(L.sun.position[0], L.sun.position[1], L.sun.position[2]);
  if(L.sun.shadow){
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_SZ || L.sun.shadow.mapSize, SHADOW_SZ || L.sun.shadow.mapSize);
    const sc = L.sun.shadow.camera;
    sun.shadow.camera.left=sc.left; sun.shadow.camera.right=sc.right;
    sun.shadow.camera.top=sc.top; sun.shadow.camera.bottom=sc.bottom;
 
    sun.shadow.camera.near = (sc.near !== undefined) ? sc.near : 0.5;
    sun.shadow.camera.far  = sc.far;
    if(L.sun.shadow.bias !== undefined) sun.shadow.bias = L.sun.shadow.bias;
    if(L.sun.shadow.normalBias !== undefined) sun.shadow.normalBias = L.sun.shadow.normalBias;
    sun.shadow.camera.updateProjectionMatrix();
  }
  scene.add(sun);
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
      scene, renderer, sun, hemi, ambient, sky: skyMesh,
      tintCloud: TINT_CLOUD, tintBg: TINT_BG, cfg,
      bloomSet: postfx          // ← 时相改 bloom 阈值的出口
    });
  } catch(e){ console.error('ATMOS-FAIL ' + (e && e.stack ? e.stack : e)); throw e; }

  /* 时相 / 滤镜 / 雾档 面板。放在最后：它要读 atmos.names、postfx.names。
     flashHint 是 setupModes 里的提示条，这里借来给按钮点按一点文字反馈。 */
  const sceneUI = createSceneUI(atmos, postfx, window.__hintFlash);

  /* 调试出口：场景 / 渲染器 / 太阳（核对阴影开关与绘制统计；无头脚本也用它） */
  window.__dbg = { THREE, scene, renderer, camera, sun, controls, terrain, grass, tufts, lavender, bed, ladder,
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
    get quality(){ return { mobile: AUTO_MOBILE, plantQ: QUALITY, cloudQ: CLOUD_Q, pr: renderer.getPixelRatio(),
                            puffs: PUFF_N, shadowMap: sun ? sun.shadow.mapSize.x : 0 }; },
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
