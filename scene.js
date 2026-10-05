import * as THREE from 'three';

/* ============================================================
   场景：噪声 / 地形 / 天空 / 远景
   ------------------------------------------------------------
   这一层只负责「世界本身」——地面高度场、天穹、远景环山与远景云，
   以及它们共用的程序化噪声与贴图。所有函数都是**纯构建**：
   给参数，返回 Object3D，不改全局状态（除了 RT 里的地形剖面）。
   物品（草/花/床/梯子/云/蝴蝶…）在 model.js，组装与交互在 main.js。
   ============================================================ */

/* ------------------------------------------------------------
   换时相时要「整体乘一个色」的材质登记表
   ------------------------------------------------------------
   云、远云、远景环山的颜色都是**构建期烘死的**（逐 sprite 的 mat.color、
   逐顶点的渐变色），它们不吃灯光 —— 夜里把太阳调暗，它们照样是白天的粉紫色。
   所以换时相时得给它们乘一个色。这里存 (材质, 构建期原色) 对，
   每次从原色重算：来回切换不会像连续相乘那样越乘越黑。
   ------------------------------------------------------------ */
export const TINT_CLOUD = [];   // 体积云的那些 sprite 材质

export const TINT_BG    = [];   // 远景环山（吃雾）+ 天空里的大 billboard 云（不吃雾）

export function regTint(list, mat, opt){
  if(mat && mat.color && mat.userData.__tintBase === undefined){
    mat.userData.__tintBase = mat.color.clone();
    /* tint 的**结果快照**：每次 setTint 写完颜色后刷新一份。
       为什么需要它：云的「背光面压暗」必须在 tint **之后**乘上去，
       而 tint 是「朝目标色 lerp」—— 它把片与片之间的明暗差按 (1-mix)
       等比压扁（夜间 cloudMix 0.78 ⇒ 只剩 22% 的对比，
       这正是「夜里云立体感不强」的机制性原因）。
       压暗若烘在 __tintBase 里就会被这层 lerp 一起压掉，
       所以只能叠在 tint 结果之上；而要能**幂等**地反复叠
       （时相来回切、探针反复调），就必须从这份快照重算，
       而不是从「上一次压过的颜色」继续压。

       ⚠⚠ 必须把**同一个对象**也挂到 `mat.userData.__tintColor` 上。
         踩过的坑（真 bug，症状是「云的颜色完全不随时相走」）：
         shadeCloud 拿的是**材质**（`m.userData.__tintColor`），
         而快照原先只存在于登记表**条目对象**（`it.tintColor`）上 ——
         于是 `raw = m.userData.__tintColor || m.userData.__tintBase`
         永远走后半截，把 setTint 刚写好的时相色**又覆写回构建期原色**，
         只留下一个乘标量的明暗。实测：清晨（cloudShade 为 null，
         k ≡ 1）云的 360 片颜色与「下午」**逐位相同**，而配置里
         明明写着 cloudMix 0.62；夜间则是 base × 0.85 的纯灰度缩放、
         色相一点没动。远景云（不过 shadeCloud）因此成了唯一正常的那些。
         一处引用就是修的要点：让两边看同一个 THREE.Color 实例。 */
    const snap = mat.color.clone();
    mat.userData.__tintColor = snap;
    /* veil=true 的条目额外记一份原透明度：这类 sprite 是 fog:false 的，
       大雾时雾管不到它们 —— 不额外按雾浓度压透明，就会看见「一片白雾里
       浮着几块灰云」这种穿帮。 */
    list.push({ mat, base: mat.userData.__tintBase,
                tintColor: snap,
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

export function fbm2(x, y){ return noise2(x,y)*0.55 + noise2(x*2.1,y*2.1)*0.25 + noise2(x*4.3,y*4.3)*0.12 + noise2(x*8.9,y*8.9)*0.08; }

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
/* ------------------------------------------------------------
   运行时状态（RT）
   ------------------------------------------------------------
   这几个值「构建期被写、运行期被读」，原本是 main.js 的模块级 let。
   拆成三个文件后，ES module 的 import 绑定**只读不能写**，
   所以收进一个可变对象：谁要写就 RT.xxx = ...
     sun                          那盏平行光（夜间当月光）—— model.js 摆云的阴影平面要读它
     quality / cloudQ / puffN     画质档位（手机自动降档）
     mound / ranges / micro / broad   地形剖面参数（scene.json 注入）
   ------------------------------------------------------------ */
export const RT = {
  sun    : null,   // 唯一的平行光（日夜共用一盏，省一套阴影贴图）
  quality: 1,      // 植被实例数倍率
  cloudQ : 1,      // 体积云 billboard 倍率
  puffN  : 0,      // 实际生成的云 billboard 数（供调试出口读取）
  mound  : null,   // 中央谷地
  ranges : null,   // 远山
  micro  : null,   // 微观起伏
  broad  : null    // 大尺度起伏
};

export function terrainHeight(x, z){
  const d = Math.hypot(x, z);
  const n1 = fbm2(x*0.004,      z*0.004     )*30.0;
  const n2 = fbm2(x*0.016+7.3,  z*0.016+2.9 )* 6.0;
  const n3 = fbm2(x*0.06 +13.1, z*0.06 +5.7 )* 1.2;
  let h = n1 + n2 + n3;
  const flat = THREE.MathUtils.smoothstep(d, 10, 38);
  h = h*(0.06 + 0.94*flat) + (1-flat)*0.6;
  if(RT.broad){
    // 大地势：远景整体缓慢抬升（幅度/范围由 JSON 控制）
    h += THREE.MathUtils.smoothstep(d, RT.broad.start, RT.broad.full) * RT.broad.amp
       * fbm2(x*RT.broad.freq + 3.7, z*RT.broad.freq);
  }
  if(RT.mound){
    // 中央盆地：床/草地所在区域保持 top，向外缓缓下沉成谷地（把"中间凸起"改成"群山环抱的谷底"）
    const t  = THREE.MathUtils.clamp((d - RT.mound.innerRadius)/(RT.mound.outerRadius - RT.mound.innerRadius), 0, 1);
    const s  = Math.pow(t, RT.mound.power);                    // power<1：出谷底后先快后缓
    const valley = RT.mound.top - RT.mound.drop * s;              // 谷地理想剖面
    // 软封顶：近中景不允许高出谷地剖面；低于剖面的凹陷保留，观感仍自然
    const capped = h > valley ? valley + (h - valley)*RT.mound.above : h;
    const w = 1 - THREE.MathUtils.smoothstep(d, RT.mound.fadeStart, RT.mound.fadeEnd);
    h = h*(1-w) + capped*w;
    // 中景丘陵：在谷地坡面之上再叠加起伏，避免中景是一块平滑斜面
    const R = RT.mound.roll;
    if(R){
      const rw = THREE.MathUtils.smoothstep(d, R.start, R.full);   // 近景淡出，保持谷底平整
      const r1 = fbm2(x*R.freq      + 21.7, z*R.freq      +  8.3)*2 - 1;
      const r2 = fbm2(x*R.freq*2.9  +  4.1, z*R.freq*2.9  + 15.9)*2 - 1;
      h += rw * R.amp * (r1 + r2*R.detail);
    }
  }
  if(RT.micro){
    // 地表微起伏：让中景地面带一点疙瘩，不至于像一块塑料板（近景淡出，保持谷底平整）
    const mw = THREE.MathUtils.smoothstep(d, RT.micro.start, RT.micro.full);
    h += mw * RT.micro.amp * (fbm2(x*RT.micro.freq + 41.3, z*RT.micro.freq + 17.9)*2 - 1);
  }
  if(RT.ranges){
    // 远山：主山脊 + 二级小峰 + 方位角包络 + 距离分层
    //   —— 目标是"重峦叠嶂"：山峰高低错落，而不是一圈等高的墙
    const G = RT.ranges;
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

export function hexToRgba(hex, a){
  let h = hex.replace('#','');
  if(h.length===3) h = h.split('').map(c=>c+c).join('');
  const r=parseInt(h.substr(0,2),16), g=parseInt(h.substr(2,2),16), b=parseInt(h.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}

/* 取 hex 的 "r,g,b" 三元组，供 canvas 渐变使用 */
export function hexToRgb255(hex){
  let h = String(hex).replace('#','');
  if(h.length===3) h = h.split('').map(c=>c+c).join('');
  return parseInt(h.substr(0,2),16)+','+parseInt(h.substr(2,2),16)+','+parseInt(h.substr(4,2),16);
}

/* ============================================================
   0b. 渐变天空穹顶：顶部粉 → 中部紫 → 地平线蓝紫，并叠加程序化噪声
   ============================================================ */
export function buildSky(scene, S){
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
export function makeCloudTexture(size, seed, opt){
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
export function buildRidgeBand(scene, B){
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

export function buildTerrain(scene, T, maxAniso){
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
    const tSize = Math.max(64, Math.round((GT.size || 512) * (RT.quality < 1 ? 0.5 : 1)));
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

/* 远处天空的大 billboard 云：不用 fog（否则会直接消失），改用人工空气透视 */
export function buildFarClouds(scene, F){
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
