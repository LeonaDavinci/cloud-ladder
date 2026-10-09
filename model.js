import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  RT, RO, terrainHeight, fbm2, hexToRgba, hexToRgb255, makeCloudTexture,
  regTint, TINT_CLOUD
} from './scene.js';

/* ============================================================
   物品建模：草 / 花 / 薰衣草 / 白菊 / 床 / 梯子 / 蝴蝶 / 云
   ------------------------------------------------------------
   每个 buildXxx(cfg, …) 收一份配置、返回一个 Object3D，
   内部管线一致：贴图（程序化画在 canvas 上）→ 几何 → 材质 → 实例化。
   地面高度一律用 scene.js 的 terrainHeight() 采样，所以只要地形剖面
   变了（RT.mound/…），物件会自动跟着起伏。
   ------------------------------------------------------------ */

function qcount(n){ return Math.max(1, Math.round(n * RT.quality)); }

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
export function resolveAvoid(cfg){
  const B = (cfg && cfg.bed) || {}, G = (cfg && cfg.grass) || {}, A = G.avoid;
  if(!A) return null;
  if(!(A.halfX > 0)){
    /* scene.json 的 bed 段可以只写 position/scale（size 缺省）——这里必须和
       bedHalfLocal() 用同一套标称尺寸兜底，否则 halfX 推不出来 ⇒ 无草区整个消失
       ⇒ 草会直接从床板里长出来。 */
    const sz = B.size || [4.7, 3.4];
    const [fsx, , fsz] = bedScaleTriple(B);     // 逐轴：床被拉长时无草区要跟着变长
    const m  = (A.margin !== undefined) ? A.margin : 0.45;
    A.halfX = +(sz[0]*0.5*fsx + m).toFixed(4);
    A.halfZ = +(sz[1]*0.5*fsz + m).toFixed(4);
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

export function buildGrass(G, uTime){
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

export function buildTufts(G, uTime){
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

export function buildLavender(G, uTime){
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

export function buildBed(B){
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
  /* 整体缩放（B.scale，标量或逐轴 [x,y,z]）：缩放原点是「床底中心」（组原点就在
     地形面上、水平居中），所以底面依旧正好落在地形上，只是向外、向上长 ——
     不会往地里/草里陷。
     GLB 适配出来的模型与枕头都在这个组里，一并跟着放大；
     被面高度请用 bedSurfaceHeight() 取，别再用裸的 surfaceY（它只带 y 分量）。 */
  const [sx, sy, sz] = bedScaleTriple(B);
  if(sx !== 1 || sy !== 1 || sz !== 1) bed.scale.set(sx, sy, sz);
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
/* ============================================================
   床贴图预烘焙应用：用构建期烘焙好的像素（window.BED_TEX）生成 DataTexture，
   直接上传 GPU，完全不经过 Image / data: URI 解码 —— 小红书等禁图片解码的
   容器里床也能正常着色，不会退化成纯白。normal 贴图是 JPEG（构建期无法纯
   stdlib 解码），这里优先沿用 GLTF 已解码的；拿不到就尝试 createImageBitmap /
   blob: 兜底，再不行就放弃（只丢法线细节，不影响床有颜色）。
   ============================================================ */
async function applyBedTextures(root){
  const T = window.BED_TEX;
  if(!T) return;
  const mkData = (b64, srgb) => {
    if(!b64) return null;
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const tex = new THREE.DataTexture(bytes, T.w, T.h, THREE.RGBAFormat);
    tex.flipY = false;                       // 与 GLTF 内嵌贴图一致（GLTFLoader 对 GLB 贴图设 flipY=false）
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };
  const albedo = mkData(T.albedo, true);
  const rough  = mkData(T.rough, false);
  // 法线：优先沿用 GLTF 已解码且图像已就绪的；否则用内嵌 raw 字节 createImageBitmap / blob: 兜底
  let normal = null;
  root.traverse(o => { if(o.isMesh && o.material && o.material.normalMap && o.material.normalMap.image) normal = o.material.normalMap; });
  if(!normal && T.normal){
    const bin = Uint8Array.from(atob(T.normal), c => c.charCodeAt(0));
    try{
      if(typeof createImageBitmap === 'function'){
        const bmp = await createImageBitmap(new Blob([bin], { type: T.normalMime || 'image/jpeg' }));
        normal = new THREE.CanvasTexture(bmp);
      } else {
        const url = URL.createObjectURL(new Blob([bin], { type: T.normalMime || 'image/jpeg' }));
        normal = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => { const t = new THREE.CanvasTexture(im); t.flipY = false; res(t); };
          im.onerror = rej; im.src = url;
        });
      }
      normal.flipY = false; normal.colorSpace = THREE.NoColorSpace; normal.needsUpdate = true;
    }catch(e){ console.warn('床法线贴图解码失败，跳过：', e && e.message); normal = null; }
  }
  const apply = (mm) => {
    if(!mm) return;
    if(albedo) mm.map = albedo;
    if(rough){ mm.roughnessMap = rough; mm.metalnessMap = rough; }
    if(normal) mm.normalMap = normal;
    mm.needsUpdate = true;
  };
  root.traverse(o => { if(!o.isMesh) return; const arr = Array.isArray(o.material) ? o.material : [o.material]; arr.forEach(apply); });
}

export function loadBedModel(B, bed){
  const M = (B && B.model) ? B.model : null;
  if(!M || !M.url) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(M.url, async (gltf) => {
      try{
        const m = gltf.scene;
        /* ---- 三层嵌套：轴修正 → 水平朝向 → 缩放/居中 --------------------------
           glTF 规范要求 Y-up，但**从 Blender 这类 Z-up 工具链导出的文件会原样
           带着 Z-up 出来**（three 的 GLTFExporter 不做轴转换），所以要留一个
           rotationX 的「轴修正」旋钮。
           三个变换**必须分成三层**，不能挤在同一个 object 的 rotation/scale 上：
             root.scale    外层：等比/非等比缩放 + 居中（量的就是它要乘的 AABB）
             yaw.rotation.y 中层：水平朝向（世界语义）
             fix.rotation.x 内层：轴修正（模型局部语义）
           `Object3D` 的矩阵是 T·R·S，**缩放比旋转先作用**。所以只要把 scale 和
           rotation 写在同一个物体上，「按旋转后的 AABB 算出来的缩放比」就会乘到
           旋转**前**的轴上 —— 旋转 90° 时 X/Z 刚好互换，两轴的缩放比就配错了。
           （实测老模型 rotationY=-90° 时：本想摆成 4.7×3.4，实际是 5.1×3.13；
             而 bedFootprint() 量的是 GLB 真实包围盒、bedHalfLocal() 用的是
             4.7/3.4 —— 两者一直对不上，走路可站立矩形比床小了一圈。）
           分成三层之后，scale 在最外层、旋转在里层，`dim` 与 `scale` 就同轴了。 */
        const fix = new THREE.Group();                        // 内层：轴修正
        fix.add(m);
        const rx = (M.rotationX !== undefined) ? M.rotationX : 0;
        if(rx !== 0) fix.rotation.x = rx;
        const yaw = new THREE.Group();                        // 中层：水平朝向
        yaw.add(fix);
        yaw.rotation.y = (M.rotationY !== undefined) ? M.rotationY : -Math.PI/2;
        const root = new THREE.Group();                       // 外层：缩放 + 居中
        root.add(yaw);
        root.updateMatrixWorld(true);
        const dim = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
        const W = (B.size ? B.size[0] : 4.7);                 // 床长（局部 X）
        const D = (B.size ? B.size[1] : 3.4);                 // 床宽（局部 Z）
        const topFrac = (M.topFrac !== undefined) ? M.topFrac : 0.58;
        /* topFrac = 「被面在包围盒高度上的分位」：旋完轴之后先把「被面平面」
           校准到 surfaceY。真实模型的床头板比被面高一截、被面还可能是皱的，
           这个分位必须实测，不能沿用上一个模型的 0.58（否则床面整体抬高/压低，
           人踩上去会悬空或陷进去）。实测两条路：
             · tools/glb-axis-probe.py —— 离线量「朝上的面」的高度分布峰值；
             · tools/bed-surface-probe.json —— 在真场景里向下打射线，取众数高度
               （被面是皱的，射线比面积统计更接近「人会踩在哪一层」）。 */
        root.scale.set(W/dim.x, B.surfaceY/(dim.y*topFrac), D/dim.z);
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const c = box.getCenter(new THREE.Vector3());
        root.position.set(-c.x, -box.min.y, -c.z);            // 底面贴床组地面、水平居中
        bed.traverse(o => { if(o.isMesh) o.visible = false; });// 藏起程序化床
        root.traverse(o => { if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
        /* 布面光滑：GLB 多为逐面法线的低模，按角度重算法线
           （阈值越大越光滑；木框的硬边靠夹角阈值保住）
           已经是「索引 + 共享顶点」的模型自带正确法线（甚至带法线贴图），
           再平滑一遍会把刻意的折痕抹掉 ⇒ 这种模型把 smoothAngle 配 0 关掉。 */
        const smAngle = (M.smoothAngle !== undefined) ? M.smoothAngle : 0;
        if(smAngle > 0){
          let nMesh = 0;
          root.traverse(o => {
            if(!o.isMesh) return;
            o.geometry = smoothGeometryNormals(o.geometry, smAngle);
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(mm => {
              if(mm && mm.flatShading){ mm.flatShading = false; mm.needsUpdate = true; }
            });
            nMesh++;
          });
          console.log('床模型法线平滑：'+nMesh+' 个网格 / 夹角阈值 '+smAngle+'°');
        }
        bed.add(root);
        /* 用构建期烘焙好的像素（window.BED_TEX）覆盖床材质贴图：生成 DataTexture
           直接上传 GPU，不经过 Image / data: URI 解码。小红书等禁图片解码的容器里
           床也能正常着色，不会再退化成纯白。 */
        await applyBedTextures(root);
        /* 把「这次到底怎么摆的」记在床组上：下载来的模型尺寸/朝向千奇百怪，
           出问题时第一句话就是「它被缩成了多大、转了多少度」。探针与文档都读这里。
           worldSize 是**局部**尺寸（未乘 bed.scale），拿来和 bed.size / 床长床宽对账。 */
        bed.userData.bedModel = {
          url: M.url,
          rotationX: rx, rotationY: yaw.rotation.y, topFrac: topFrac, smoothAngle: smAngle,
          rawDim: [+dim.x.toFixed(4), +dim.y.toFixed(4), +dim.z.toFixed(4)],
          scale: [+root.scale.x.toFixed(4), +root.scale.y.toFixed(4), +root.scale.z.toFixed(4)],
          worldSize: [+(box.getSize(new THREE.Vector3()).x).toFixed(4),
                      +(box.getSize(new THREE.Vector3()).y).toFixed(4),
                      +(box.getSize(new THREE.Vector3()).z).toFixed(4)]
        };
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

export function buildDaisies(cfg, uTime){
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
  const [fsx, , fsz] = bedScaleTriple(cfg.bed);   // 世界坐标：逐轴带上床的整体缩放
  const th = cfg.bed.rotationY || 0;
  return {
    cx: bed.position.x, cz: bed.position.z,
    hx: Math.abs(bw*fsx*Math.cos(th)) + Math.abs(bd*fsz*Math.sin(th)),
    hz: Math.abs(bw*fsx*Math.sin(th)) + Math.abs(bd*fsz*Math.cos(th)),
    bottom: bed.position.y, src:'analytic'
  };
}

/* 床的「标称」半长 / 半宽（局部 X / Z，**不含**整体缩放）。
   局部坐标用的地方直接吃 bedHalfLocal —— 床侧高光锚点是挂在床的局部空间里的，
   组缩放会由 matrixWorld 自己乘上去，这里再乘一次就飞到床外面去了；
   世界坐标用的地方（无草圈、行走「可站立矩形」）才需要 bedScaleTriple，否则人从床沿掉下去。 */
export function bedHalfLocal(cfg){
  const B = (cfg && cfg.bed) ? cfg.bed : {};
  const sz = B.size || [4.7, 3.4];
  return { bw: sz[0]*0.5, bd: sz[1]*0.5 };
}

/* 床的整体缩放，统一成 [x, y, z] 三元组。两种写法都收：
     scale: 1.2                三轴等比（老配置，等价 [1.2,1.2,1.2]）
     scale: [1.8, 1.44, 1.8]   逐轴 ——「床拉长一点 / 拍扁一点」只有逐轴能表达
   ⚠ 不要退回「一个标量代表整体缩放」：X/Z 与 Y 的消费者完全不同 ——
     X/Z → 无草区、行走可站立矩形、床影外沿、床边花簇与蝴蝶航线的外推；
     Y   → 被面高度（梯脚吸附、爬床判定、蝴蝶巡航基准）。
     混用一个数时「把床拉长」会顺手把被面也抬高，而画面上没人看得出来。 */
export function bedScaleTriple(B){
  const s = (B && B.scale !== undefined) ? B.scale : 1;
  return Array.isArray(s) ? [ +s[0], +s[1], +s[2] ] : [ +s, +s, +s ];
}

/* 被面（床顶）相对「床组原点」的高度 —— 必须带上整体缩放的 **y** 分量。
   梯脚吸附、爬床判定、蝴蝶巡航基准高度都读它；
   场景里还有几处直接写 surfaceY 的，床一放大就会按老高度算（梯子悬空/蝴蝶钻床）。 */
export function bedSurfaceHeight(B){
  return (B.surfaceY || 1.44) * bedScaleTriple(B)[1];
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

export function buildBedShadow(cfg, uTime, bed){
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
    patch.renderOrder = RO.GROUND;
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

export function buildLadder(L, bedTopY){
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

export function buildButterflies(cfg, bed, camera){
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
  mesh.renderOrder = RO.VEG;

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
   萤火虫：夜间替代蝴蝶，在床周围成群忽明忽暗地飘。
   - 每只 = 一个加法混合的 billboard 光点（柔光圆斑 + 亮核）
   - 亮度不靠 opacity，而是把亮度乘进实例色（加法混合下 color→0 = 熄灭）
   - 轨道 = 床周围的椭圆 + 慢噪声扰动 + 上下浮动 bob；整群绕床缓缓漂移
   - flicker：每只独立的正弦脉冲，sharp 越大闪得越「急」越「尖」
   - 默认隐藏，切到夜间时由 main.js 通过 atmos.onPhase 打开、同时把蝴蝶收起
   ============================================================ */
function makeFireflyTexture(size){
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const h = size/2;
  const halo = g.createRadialGradient(h, h, 0, h, h, h);
  halo.addColorStop(0.00, 'rgba(255,255,255,1)');
  halo.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  halo.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  halo.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = halo; g.fillRect(0, 0, size, size);
  const core = g.createRadialGradient(h, h, 0, h, h, h*0.22);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.5, 'rgba(255,255,255,0.7)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core; g.beginPath(); g.arc(h, h, h*0.22, 0, Math.PI*2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildFireflies(cfg, bed, camera){
  const F = (cfg && cfg.fireflies) ? cfg.fireflies : null;
  if(!F || !F.count) return null;
  const n = Math.max(1, F.count|0);
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: makeFireflyTexture(F.textureSize || 128),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.frustumCulled = false;
  mesh.renderOrder = RO.NIGHTFX;
  mesh.visible = false;                 // 白天不显示，切夜间由 main.js 打开

  const [rxLo, rxHi] = F.radiusX || [2.4, 3.8];
  const [rzLo, rzHi] = F.radiusZ || [2.6, 4.2];
  const [hLo,  hHi ] = F.height  || [0.35, 2.4];
  const [sLo,  sHi ] = F.size    || [0.10, 0.20];
  const [spLo, spHi] = F.speed   || [0.12, 0.34];
  const [bLo,  bHi ] = F.bob     || [0.6, 1.4];
  const drift = (F.drift !== undefined) ? F.drift : 0.5;
  const PAL = (F.palette && F.palette.length) ? F.palette : ['#d8ff7a','#b6ff5a','#eaffb0','#9bff66'];
  const FL  = F.flicker || { sharp: 5.5, base: 0.12, gain: 1.9 };
  const R = Math.random;
  const cx = bed.position.x, cz = bed.position.z;
  const gy = bed.position.y;            // 床组原点（地面基准）
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  const bs = [];
  for(let i=0;i<n;i++){
    const c = new THREE.Color(PAL[i % PAL.length]);
    bs.push({
      a:   R()*Math.PI*2,
      rx:  rxLo + R()*(rxHi - rxLo),
      rz:  rzLo + R()*(rzHi - rzLo),
      ox:  cx + (R()*2 - 1) * drift,
      oz:  cz + (R()*2 - 1) * drift,
      b0:  gy + (hLo + R()*(hHi - hLo)),
      bobA:(bLo + R()*(bHi - bLo)),
      s:   sLo + R()*(sHi - sLo),
      sp:  spLo + R()*(spHi - spLo),
      b:   bLo + R()*(bHi - bLo),
      fp:  R()*Math.PI*2,
      p:   [R()*6.283, R()*6.283, R()*6.283],
      r: c.r, g: c.g, b: c.b
    });
  }
  mesh.userData.update = (t)=>{
    for(let i=0;i<n;i++){
      const b = bs[i];
      const a  = b.a + t*b.sp;
      const x  = b.ox + Math.cos(a)*b.rx*(1 + 0.12*Math.sin(t*0.37 + b.p[0]));
      const z  = b.oz + Math.sin(a)*b.rz*(1 + 0.10*Math.sin(t*0.29 + b.p[1]));
      const y  = b.b0 + b.bobA*(0.5 + 0.5*Math.sin(t*b.b + b.p[2]));
      const fl = Math.pow(Math.max(0, Math.sin(t*(2.0 + b.sp) + b.fp)), FL.sharp);
      const br = FL.base + fl*FL.gain;
      dummy.position.set(x, y, z);
      dummy.quaternion.copy(camera.quaternion);     // 永远正对相机
      const s = b.s*(0.7 + 0.5*fl);
      dummy.scale.set(s, s, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, col.setRGB(b.r*br, b.g*br, b.b*br));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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

export function buildGlints(cfg, bed, ladder, camera){
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
        ph0:   -j*(LG.chase !== undefined ? LG.chase : 0),  // 相位逐级错开 = 光点顺杆往上跑
        scale: (LG.scale !== undefined) ? LG.scale : 1,     // 梯杆闪光尺寸倍数
        bright:(LG.bright !== undefined) ? LG.bright : 1    // 梯杆闪光亮度倍数
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
  mesh.renderOrder = RO.FOLIAGE;
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
      scale: (A.scale !== undefined) ? A.scale : 1,
      bright:(A.bright !== undefined) ? A.bright : 1,
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
      const br = A.dead ? 0 : (q.base + k*q.gain)*q.bright;
      dummy.position.copy(v);
      dummy.quaternion.copy(camera.quaternion);          // 高光永远正对相机
      const s = A.dead ? 0 : q.size*(0.55 + 0.85*k)*q.scale;
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
  mesh.userData.scales = gs.map(q=>({ scale: q.scale, bright: q.bright }));
  return mesh;
}

/* GLB 床的内部形状是未知的：把「床侧」的高光用一条水平射线贴到真实表面上，
   否则高光会漂在空气里或者埋进床垫。射线只打被子/床板这类可见网格。 */
export function snapGlintsToBed(glints, bed, cfg){
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

/* ============================================================
   云的背光面压暗（时相驱动，可在运行中重算）
   ------------------------------------------------------------
   云片的颜色是**构建期烘死的**：每片按「云心→片」方向与默认时相的太阳
   做了一次「背光偏冷暗紫 + 亮度系数」的调制（见 buildCloud 里的 lit / bright），
   之后只剩一个整体的 tint。于是有两件事必须能事后重算：

   ① **哪一面算背光，要跟着本档的光源走。** 夜间那一盏平行光就是月亮
      （同一盏，省一套阴影），日落那盏方位角比下午偏 48° —— 拿构建期的
      下午太阳去判定暗面，暗面就是错的。用户要的判据是「晚上以月亮
      照不到的为准」，所以方向按帧/按档从光源位置取。
   ② **暗面有多暗，要能按档调。** tint 是朝目标色 lerp，会把片与片之间的
      明暗差按 (1-cloudMix) 等比压扁 —— 夜间 cloudMix 0.78 ⇒ 只剩 22% 的对比，
      这正是「夜里云立体感不强」的机制性原因。所以压暗只能叠在 **tint 之后**，
      并且必须从 tint 结果的快照（mat.userData.__tintColor）重算才幂等：
      时相来回切、探针反复调都不会「越叠越黑」。

   S = { backDark, hinge, backMix, backTint }（背光压暗，推荐）
   或 { backDark, curve }（老形式）：
     backDark  暗面最深处，在本档 tint 之后的颜色上再乘 (1-backDark)；
     hinge     0 < hinge ≤ 1：**lit ≥ hinge 的云片一个字节都不改**（k 恒为 1），
               从 hinge 往暗侧用 smoothstep 加重到 (1-backDark)。
               这是「只压背光面」的精确实现 —— 用户要的就是这个：
               亮面不动、暗面降下来，于是对比全落在暗侧，立体感出来而整体不塌。
               （curve 那个形式会把亮面也一起压 4~8%，因为它是按 lit 幂次摊的。
                实测：sunset 用 curve 时 front 档 −4.4%、整体 −12.3%；
                hinge 形式下 front 档 0、只有 lit < hinge 的片参与。）
     backMix   0..1：暗面再朝**环境色** lerp 的比例（乘同一个权重 w）。
               「云朵的暗面应该随环境色混合」就是指这一路：暗面只吃到环境光，
               所以它的色相该是环境光的色相，而不是「同一块紫灰乘个小数」。
               envColor 参数 = atmosphere 传来的本档 ambient.color；
               S.backTint 可以显式顶掉它（要给一个不跟随 ambient 的色时用）。
     curve     备选形式：lit^curve 的幂次映射（curve=1 等价于不启用）。
   S 为空 / backDark = 0 且 backMix = 0 ⇒ 权重恒为 0，颜色是逐位复制（改前改后 0 差异）。
   ============================================================ */
let _cloudPuffs = null;
const _shadeDir = new THREE.Vector3();
const _shadeEnv = new THREE.Color();
let _cloudShadeStats = null;

export function shadeCloud(dirWorld, S, envColor){
  const list = _cloudPuffs;
  if(!list || !list.length || !dirWorld) return 0;
  _shadeDir.copy(dirWorld);
  if(_shadeDir.lengthSq() < 1e-12) return 0;      // 光源在原点：没有方向可言，别去归一化
  _shadeDir.normalize();
  const curve = (S && S.curve    !== undefined) ? Math.max(0.05, S.curve) : 1;
  const dark  = (S && S.backDark !== undefined) ? THREE.MathUtils.clamp(S.backDark, 0, 1) : 0;
  const hinge = (S && S.hinge    !== undefined) ? THREE.MathUtils.clamp(S.hinge, 1e-6, 1) : 0;
  /* 「暗面混环境色」的强度。环境色优先取 S.backTint（时相表里显式写死的那种），
     否则用 atmosphere 传进来的本档 ambient.color，都没有就不混。
     为什么要混：纯乘一个标量只会让暗面「同色变暗」，而现实中背光面只吃到
     环境光 —— 它的**色相**应该就是环境光的色相（清晨冷白、日落暖橙、
     月亮蓝）。用户的原话是「应该随着环境色做一些混合，这样看上去更自然」。 */
  const mix   = (S && S.backMix  !== undefined) ? THREE.MathUtils.clamp(S.backMix, 0, 1) : 0;
  let hasEnv = false;
  if(mix > 0){
    if(S && S.backTint) { _shadeEnv.set(S.backTint); hasEnv = true; }
    else if(envColor)   { _shadeEnv.copy(envColor);  hasEnv = true; }
  }
  let litLo = 1, litHi = 0, kLo = 1, kFlat = 0;
  for(let i=0;i<list.length;i++){
    const it = list[i], m = it.sp.material;
    /* 沿用的是构建期那一套映射（dot*0.5+0.5），所以参数一旦等于默认值，
       结果与烘死的那版在同一条基线上，不会被「换了套算法」混进来。 */
    const lit = THREE.MathUtils.clamp(it.dirV.dot(_shadeDir)*0.5 + 0.5, 0, 1);
    /* w = 「这一片有多背光」0..1，是唯一的作用权重：压暗与混色都乘它，
       所以 w = 0 的片（lit ≥ hinge）颜色**逐位不动**。 */
    let w;
    if(hinge > 0){
      /* hinge 形式：lit ≥ hinge ⇒ t = 0 ⇒ w = 0。
         t 走 smoothstep（t²(3-2t)），暗面端点没有折角 ——
         线性的话「云心到云面」会看出一圈突兀的明暗分界线。 */
      const t = THREE.MathUtils.clamp((hinge - lit)/hinge, 0, 1);
      w = t*t*(3 - 2*t);
    } else {
      const litE = (curve === 1) ? lit : Math.pow(lit, curve);
      w = 1 - litE;
    }
    const k = 1 - dark * w;
    /* ⚠ raw 必须是 __tintColor（本档 tint 的结果），不能是 __tintBase ——
       用后者会把 setTint 刚写上的时相色覆写掉，云就再也不随时相变色了。
       这个别名由 scene.js 的 regTint 建立（详见那里的注释）。 */
    const raw = m.userData.__tintColor || m.userData.__tintBase;
    if(raw){
      m.color.copy(raw).multiplyScalar(k);
      /* 先压暗、再朝环境色混：这样暗面不会变成「更黑的紫」，而是
         「暗下来的、带环境光色相」的一片 —— 立体感与环境感同时拿到。 */
      if(hasEnv) m.color.lerp(_shadeEnv, mix * w);
    }
    it.lit = lit; it.shadeK = k;
    if(lit < litLo) litLo = lit;
    if(lit > litHi) litHi = lit;
    if(k   < kLo  ) kLo   = k;
    /* untouched 的语义必须是「**颜色逐位不变**」，不能是「w = 0」：
       下午那档整档没配（dark = 0 ⇒ k ≡ 1、也不混环境色），它的 360 片
       同样应当算 untouched —— 这正是「新通路没配就一个字节都不写」的判据。 */
    if(k === 1 && !(hasEnv && mix*w > 0)) kFlat++;
  }
  _cloudShadeStats = {
    n: list.length, curve, hinge, backDark: dark,
    backMix: hasEnv ? mix : 0,
    env: hasEnv ? ('#' + _shadeEnv.getHexString()) : null,
    litMin: +litLo.toFixed(4), litMax: +litHi.toFixed(4), kMin: +kLo.toFixed(4),
    untouched: kFlat,     // **颜色逐位不变**的片数（w = 0，或整档没配压暗/混色）
    dir: [+_shadeDir.x.toFixed(4), +_shadeDir.y.toFixed(4), +_shadeDir.z.toFixed(4)]
  };
  return list.length;
}

export function cloudShadeStats(){ return _cloudShadeStats; }

export function buildCloud(scene, C, SUN_DIR){
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
 
  // 由大量小 billboard 累加出厚重云团
  const cloudGroup = new THREE.Group();
  scene.add(cloudGroup);
  const puffs = [];                       // 供「相机进云时让开」使用（见 updateCloudFade）
  /* 顺手登记给 shadeCloud：时相切换时要能遍历到每一片。
     存的是同一个数组引用，所以后续 push 进来的片自动在里面。 */
  _cloudPuffs = puffs;
  RT.puffN = Math.max(1, Math.round(C.puffCount * RT.cloudQ));
  /* 每个 puff 自带材质、还各配一块投影 Plane ⇒ draw call 约 2×puff 数。
     移动档砍数量时要把单片的 alpha 提上去补偿，否则云会整体变透。
     （alpha 叠乘，故用 1/sqrt(k) 而非 1/k） */
  const OP_BOOST = (RT.cloudQ < 1) ? Math.min(1.6, 1/Math.sqrt(RT.cloudQ)) : 1;
  const [smin, smax] = C.puffSize;
  const [pw, ph] = C.puffScale;
  const [opMin, opMax] = C.opacity;
  const topC = new THREE.Color(C.colors.top),
        botC = new THREE.Color(C.colors.bottom),
        midC = C.colors.mid ? new THREE.Color(C.colors.mid) : null,
        backC = new THREE.Color(C.colors.backlit);
  for(let i=0;i<RT.puffN;i++){
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
    var yN  = THREE.MathUtils.clamp((pos.y-(center.y-CRY))/(2*CRY), 0, 1);     // 0底 1顶
    yN = Math.pow(yN,0.5);
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
    /* ★ 必须是 RO.CLOUD 而不是默认 0（2026-10-06 用户要求「云的渲染次序要比电视
       后面」）。透明 pass 里 renderOrder 压过深度，而云 + 电视辉光都是
       depthWrite:false 的加色/半透明层 —— 排错了谁后画谁盖谁。 */
    sp.renderOrder = RO.CLOUD;
    const s = smin + Math.random()*(smax-smin);
    sp.scale.set(s*pw, s*ph, 1);   // 长方形：横向拉长
    /* 每片云装进一个「节点」：Sprite 与它那块投影圆盘都挂在节点下，
       节点位置 = 这一片云的位置。随风流动时靠移动节点，
       两者不会脱节（那块圆盘本身在画面里看不见，它负责在草地上投出云影）。 */
    const node = new THREE.Group();
    node.position.copy(pos);
    node.add(sp);


    /* --- 2. 投影板（Shadow Caster）---
       这块板只负责在草地上投出云影，**在画面里必须一个像素都不写**。
       它原来叫「不可见的投影平面」，但只是取名不可见 —— 它是个正常的
       MeshBasicMaterial + CircleGeometry，朝向太阳、BackSide、renderOrder 10，
       相机绕到云的另半边就会看到它的背面，360 块板一起画在云片之上。

       ⚠ 为什么不能用两种「显而易见」的隐藏写法 —— 它们会把阴影一起弄没：
         · plate.visible = false
              → WebGLShadowMap.renderObject 第一行就是 `if (object.visible === false) return;`
                （vendor/three/three.module.js:22583），整个对象被跳过，阴影也没了。
         · plate.material.visible = false
              → 同文件 22619 行 `} else if (material.visible) {` 判完才去 getDepthMaterial，
                同样跳过。
         即：**在这套渲染器里「可见性」同时是阴影投射的开关**，不能拿它当
         「只在主画面里隐藏」用。而且 layers 也不行 —— 22619 行用的是
         `object.layers.test(camera.layers)`，那个 camera 是**主相机**，
         挪到别的 layer 上会连阴影一起丢。
       colorWrite: false 则是主画面那趟被 gl.colorMask 关掉写色、深度照写，
       阴影那趟不受影响。前提是：深度材质由 getDepthMaterial 克隆，
       它只拷 visible / wireframe / side / map / alphaMap / alphaTest / clipping /
       displacement，**不拷 colorWrite** ⇒ 阴影那趟的 colorMask 仍是开的。
       （vendor:22492 `result = ... _depthMaterial;` → 22530 `result.clone()`，
         而 _depthMaterial 是 new MeshDepthMaterial()，colorWrite 默认 true。）

       ⚠ 为什么非修不可（实测，相机绕云水平轨道 r=34、夜间、postfx 关）：
         · 可见区间是「方位角 45°~210° ⇒ 360/360 全可见」，30°/225° 是过渡带
           （108/8），其余方位 0 —— 也就是**绕到云的背面就整朵云糊上一层板**。
         · 默认首屏（reset 位姿）就已经中招：141/141。
         · 颜色是构建期烘死的白天粉且**没登记进时相染色表**（inTintReg=false）：
           夜间实测板 #ae6595（lum 0.855）vs 云片 #69578e（lum 0.508），
           亮 1.68 倍；截图里就是云上一道道浅粉细长亮条，还会被
           夜间放宽到 threshold 0.45 的 bloom 放大。
           白天两者同色（#ae6595 == #ae6595）所以不易察觉，但 360 块板同样叠着。

       ⚠ 代价（已知、已量）：主画面里这 360 次 draw call 变成纯空转
         （renderer.info.render.calls 仍是 771）。要省掉得把 360 块板并成
         一个合批 Mesh，但那样它们就没法跟着风逐片改缩放/位置了 —— 属于另一件事。 */
    const shadowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: texes[(Math.random()*texes.length)|0],
        side: THREE.BackSide,
        depthWrite: false,
        /* ★ 这一行才是「不可见」的真正实现。理由见下面那段注释。 */
        colorWrite: false,
        transparent: true,
        opacity: 0.5
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
    shadowPlane.lookAt( RT.sun.position ); 
    
    // 标记以便在动画循环中更新朝向
    shadowPlane.userData.isBillboard = true;
    shadowPlane.userData.syncWithSprite = sp; // 可选：如果需要严格同步位置
    shadowPlane.renderOrder = RO.CLOUD_SHADOW;
    node.add(shadowPlane);
    cloudGroup.add(node);
    /* 朝向太阳要在「挂进节点之后」算：lookAt 取的是世界位置，
       节点还没接进 cloudGroup 时它算出的是从原点看太阳，方向会全错。
       节点只会平移、不会旋转，所以这份朝向一直有效。 */
    shadowPlane.lookAt( RT.sun.position );

    /* 这一片「怎么动」——全都相对它自己的家位置，永不累积：
       home  家位置（世界坐标，云团整体永不位移）；
       amp   位移幅度（米）= drift × 自身尺寸 × 内芯权重 ⇒
             位移既被自己的大小封顶，外圈还被权重压到 0；
       wk    内芯权重（0 = 完全静止，1 = 全速搅动）；
       rateK / rotK 每片不同的频率倍率 + 相位，免得 360 片整齐划一。 */
    puffs.push({
      node, sp, plate: shadowPlane, baseOp: mat.opacity, plateOp: shadowMat.opacity,
      home: pos.clone(),
      /* 供 shadeCloud 事后重算：这一片的朝向（云心→片，单位向量）。
         dirV 与 home 一样永不改变 —— 风只挪位置、不改朝向 ——
         所以「暗面在哪边」随时可以按新方向重算，不需要重建云。 */
      dirV: dir.clone(), yN, lit, shadeK: 1,
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
      sp.visible = false; sp.renderOrder = RO.SPARK;
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
export function updateCloudFlow(grp, t, dt){
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
export function updateCloudFade(grp, cam, near, inside, C){
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
export function setupCloudPoke(scene, grp, camera, dom, cfg, AUD){
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

  function hitAt(cx, cy, alreadyStage){
    const r = dom.getBoundingClientRect();
    if(!r.width || !r.height) return null;
    /* ⚠⚠ 2026-10-09 用户指出「强制横屏后左右两个漫游操作没适配」时一起查出来的：
       强制横屏的兜底方案是把 body 旋转 90°，此时 `getBoundingClientRect()` 返回的
       是**物理视口**的包围盒，而相机渲染的是**舞台**（宽高已交换）——
       拿前者算 NDC 得到的是「屏幕 NDC」，射线在 3D 空间里的方向整个错掉，
       「点击云朵戳一下」必然点不中。
       ⇒ 先把屏幕坐标转成舞台坐标，再用**舞台尺寸**算 NDC。
       两者由 main.js 在模块顶层挂上（window.__screenToStage / __stageSize）；
       未旋转时前者是恒等映射、后者等于 rect ⇒ **桌面端行为完全不变**。 */
    /* ⚠ e.clientX/clientY 在进入本回调前，已被 main.js 的 fixEventCoords（canvas 捕获
       阶段监听）改写成**舞台坐标**；这里若再 screenToStage 一次就是二次变换，
       点云必然点不中。故直接用传进来的 (cx, cy) 当舞台坐标（未旋转时它等于物理坐标，
       与原来恒等映射的结果一致）。唯一调用方是 model.js 的 pointerup：传的就是 e.clientX。 */
    /* cx,cy 在「自由模式」下是原始物理坐标（fixEventCoords 被跳过），
       在 walk/tv 下则是已被转成舞台坐标的（e.__stageFixed）。
       alreadyStage 为真时直接当舞台用；否则先 screenToStage 转回舞台坐标再算 NDC。 */
    const toStage = (typeof window !== 'undefined') ? window.__screenToStage : null;
    const sp = (alreadyStage || !toStage) ? { x: cx, y: cy } : toStage(cx, cy);
    const SS = (typeof window !== 'undefined') ? window.__stageSize : null;
    const vw = SS ? SS.w : r.width;
    const vh = SS ? SS.h : r.height;
    if(!vw || !vh) return null;
    ndc.set((sp.x / vw)*2 - 1, -(sp.y / vh)*2 + 1);
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
    const hit = hitAt(e.clientX, e.clientY, e.__stageFixed);
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

/* ============================================================
   夜间投影幕布 + 点光源
   ------------------------------------------------------------
   只在 night 时相显示。幕布是一张带自发光纹理的 Plane，纹理来源：
     · 若 scene.json projector.video.src 写了真实视频地址，直接用 VideoTexture；
     · 否则回退到程序化 CanvasTexture，每帧画「老电影/梦境」动画。
   点光源放在幕布前方，模拟投影仪/电视机的辉光，照亮床面。
   ============================================================ */
export function buildProjectorScreen(cfg){
  const P = cfg.projector;
  if(!P || P.enabled === false) return null;

  const S = P.screen || {};
  const L = P.light  || {};
  const V = P.video  || {};

  const group = new THREE.Group();
  group.name = 'projector';

  const w = +(S.width  !== undefined ? S.width  : 3.5);
  const h = +(S.height !== undefined ? S.height : 1.97);
  const geo = new THREE.PlaneGeometry(w, h);

  const cvs = document.createElement('canvas');
  cvs.width  = +(V.canvasWidth  !== undefined ? V.canvasWidth  : 512);
  cvs.height = +(V.canvasHeight !== undefined ? V.canvasHeight : 288);
  const ctx = cvs.getContext('2d');

  let videoEl = null;
  let texture;
  let useVideo = false;
  const src = (V.src || '').trim();

  function makeCanvasTexture(){
    const tex = new THREE.CanvasTexture(cvs);
    if(tex.colorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  texture = makeCanvasTexture();

  if(src){
    const ve = document.createElement('video');
    ve.crossOrigin = 'anonymous';
    ve.loop = true;
    ve.muted = true;
    ve.playsInline = true;
    ve.preload = 'auto';
    /* ⚠ 用 <source> 而不是只设 ve.src —— 资源是**假扩展名**（night.video.json），
       静态服务器按扩展名会把它报成 application/json（实测平台就是这样：
       audio/*.mp3.json 和 models/bed2.glb.json 都拿到 application/json），
       而 media element 的 canPlayType 要靠 MIME 决定能否走硬件解码。
       HTML 标准做法是由文档显式声明真实类型：<source src="…" type="video/mp4">，
       这样服务器给什么 MIME 都不影响，对真 .mp4 也同样无害。
       ⚠ <source> 一旦 appendChild 就会**覆盖** ve.src 属性（规范如此），
         所以下面仍保留 ve.src 赋值 —— 它在 source 之后，被覆盖也无妨。 */
    ve.appendChild(Object.assign(document.createElement('source'), { src:src, type:'video/mp4' }));
    ve.src = src;
    videoEl = ve;
    useVideo = true;

    const swapToCanvas = ()=>{
      texture = makeCanvasTexture();
      screen.material.map = texture;
      screen.material.emissiveMap = texture;
      screen.material.needsUpdate = true;
      drawFilm(0);
      texture.needsUpdate = true;
    };

    /* why: 'error' / 'no-source' / 'timeout' / 异常 message
       soft=true 表示「可能只是慢，别判死刑」——
       换画面兜底但**保留 videoEl 继续加载**，canplay 一到就 swapToVideo 切回。
       2026-10-06 之前这里是 videoEl = null 一击毙命：移动网络慢一点就永远
       停在程序化画布上，用户看到的「还是默认画面」再也回不来。 */
    const failToCanvas = (why, soft)=>{
      console.warn('投影仪视频加载失败，回退到程序化画布：', why || src);
      /* 把原因抛给 UI，让它显示在提示条上 —— 定位这个问题时最有价值的一行信息。 */
      try{ if(group.userData.onVideoFallback) group.userData.onVideoFallback(String(why || 'error')); }catch(_){}
      if(soft){
        swapToCanvas();
        if(!ve.__retryBound){ ve.__retryBound = true; ve.addEventListener('canplay', swapToVideo); }
        return;
      }
      useVideo = false;
      videoEl = null;
      swapToCanvas();
    };

    ve.addEventListener('error', ()=> failToCanvas('error'), { once: true });
    ve.addEventListener('stalled', ()=>{
      if(ve.networkState === ve.NETWORK_NO_SOURCE) failToCanvas('no-source');
    }, { once: true });

    /* 如果浏览器能立即解码，就换 VideoTexture；否则等 canplay 再换 */
    const swapToVideo = ()=>{
      try{
        const tex = new THREE.VideoTexture(ve);
        if(tex.colorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        texture = tex;
        screen.material.map = texture;
        screen.material.emissiveMap = texture;
        screen.material.needsUpdate = true;
      } catch(e){ failToCanvas(e.message); }
    };
    /* ⚠ 这里**不能**立刻 swap：swapToVideo 要写 screen.material，而 `screen`
       在这段代码之后才声明 —— 视频若命中缓存、readyState 已经是 2，这一句会同步执行，
       直接撞进 `Cannot access 'screen' before initialization`（TDZ）把整个构建掀掉。
       统一交给 canplay 事件；「已经能播」的这种情况由函数末尾那次补判覆盖。 */
    ve.load();                                  // 显式起一次加载，别等浏览器自己挑时机
    ve.addEventListener('canplay', swapToVideo, { once: true });

    /* 有些浏览器不会触发 error，直接 canplay 也没到：超时后还解不出画面就回退。
       ⚠ 这里只看 readyState，不要再掺入 ve.paused —— 自动播放被策略拦下时
       paused 恒为 true，拿它当判据会把「已经能播、只是还没被点开」的视频
       误判成加载失败而退回画布（实测 night.mp4 就这样被踢回去了）。
       ⚠ 2026-10-06 从 5.2s 放宽到 8s：线上是 python http.server，**对 Range 请求
       直接返回 200 全量、不给 206**，所以慢网下必须把整个文件抓完才谈得上解码，
       5.2s 在移动端很容易误判成「加载失败」⇒ 用户看到的是回退的默认画面。 */
    setTimeout(()=>{ if(useVideo && ve.readyState < 2) failToCanvas('timeout', true); }, 20000);
  }

  /* ---- 视频声音：放大 1.5 倍（screen.volumeGain） ----
     2026-10-05 用户要求「直接放视频的声音 + 声音放大 50%」。<video>.volume 上限就是 1，
     想真的放大只能过一路 WebAudio 增益节点。
     ⚠ 一旦 createMediaElementSource 接上，这段音频就**只**走这条图 —— 上下文要是
     suspended，整段就静音了。所以这条链只在「点看电视」那个用户手势里现建 / resume，
     并且留兜底：resume 后仍未 running 就拆掉链路退回元素直出（少赚那 50%，但不哑）。 */
  let vaCtx = null, vaSrc = null, vaGain = null, vaBuilt = false;
  const VA_GAIN = +(S.volumeGain !== undefined ? S.volumeGain : 1.5);
  function tvAudioOn(on){
    if(!videoEl) return false;
    try{
      if(on){
        videoEl.volume = 1;
        /* ---- ① **先直出**：这一步是「视频能不能动」的分水岭 ----
           iOS Safari 的规则：媒体元素取消静音后，必须有**有效的音频输出路径**，
           否则它会把视频**暂停在第一帧**（用户 2026-10-06 原话「不播放，停在第一帧」）。
           而「有效路径」不能建在一张还没 running 的 Web Audio 图上 ——
           旧代码正是反着做的：先 unmute、再 createMediaElementSource、然后因为
           `resume()` 是异步的（同步读必然还是 'suspended'）把刚建的链 disconnect 掉。
           灾难在于 `createMediaElementSource` 是**不可逆**的：调用那一刻，媒体元素的
           音频就永久改道到那张图上，disconnect 救不回「元素直出」这条路（规范没有 undo）。
           ⇒ 结果既没声音，视频也被掐住。
           现在先 unmute 走**元素原生输出**（这条路径一定有效），视频先动起来。 */
        videoEl.muted = false;
        /* ---- ② 音量放大只是**增强**，等 Web Audio 真的 running 了再接 ----
           接图的前提是 `AudioContext` 确实 running（异步 resume 完成）；
           没 running 就不接，这一轮放弃 1.5 倍增益，但视频照播。
           下次点「看电视」（又是一次用户手势）会再试一次。 */
        if(!vaBuilt){
          const AC = window.AudioContext || window.webkitAudioContext;
          if(AC){
            try{ if(!vaCtx) vaCtx = new AC(); }catch(_){ vaCtx = null; }
            if(vaCtx){
              const ready = (vaCtx.state === 'running') ? Promise.resolve()
                           : (vaCtx.resume ? vaCtx.resume() : Promise.reject());
              ready.then(()=>{
                if(vaBuilt || !videoEl) return;
                try{
                  /* ⚠ 同一 media element 只能接一张 source node，第二次会抛
                     InvalidStateError。所以建过就记账，绝不重来。 */
                  vaSrc = vaCtx.createMediaElementSource(videoEl);
                  vaGain = vaCtx.createGain();
                  vaGain.gain.value = VA_GAIN;
                  vaSrc.connect(vaGain);
                  vaGain.connect(vaCtx.destination);
                  vaBuilt = true;
                }catch(_){ /* 接不上就保持直出，不影响播放 */ }
              }).catch(()=>{});
            }
          }
        }
        return true;
      }
      /* 关：先摘增益再静音（元素静音后，WebAudio 那条路不一定跟着停）。
         ⚠ 只摘下游，**不要把 vaBuilt 置回 false / vaCtx 置 null** ——
         同一个 media element 不能再接第二张 source node，重建会抛。 */
      try{ if(vaGain) vaGain.disconnect(); }catch(_){}
      try{ if(vaSrc)  vaSrc.disconnect();  }catch(_){}
      vaGain = vaSrc = null;
      videoEl.muted = true;
    }catch(e){ /* 建不出来也别掀构建：元素保持未静音，浏览器自己直出 */ }
    return false;
  }
  group.userData.tvAudio = tvAudioOn;
  /* 无头探针用：图有没有真的建起来（= 有没有拿到那 1.5 倍增益） */
  Object.defineProperty(group.userData, 'vaBuilt', { get(){ return vaBuilt; } });
  Object.defineProperty(group.userData, 'audioCtxState', { get(){ return vaCtx ? vaCtx.state : null; } });

  /* 屏幕总亮度 = 视频亮度 × (brightness + emissive) + 点光源打上来的那点漫反射。
     ⚠ 三个量会互相叠加，调的时候要一起看：
       · brightness —— 材质 color 对 map 的乘子，等于「把视频本身压暗」，
         换任何视频都不会过曝，是首选旋钮；
       · emissive   —— 自发光，让屏幕在夜里「会亮」，但它吃的是线性亮度，
         一旦过 0.5 就会连画面结构一起糊掉；
       · light.intensity —— 点光源离幕布越近，衰减 1/d^decay 涨得越猛
         （实测 0.55m 处辐照度 ≈ 3.0，高光像素直接打满成白墙），
         所以光源要离幕布 1 米以上，别贴着布走。
     用户 2026-10-05 反馈「电视屏幕曝光过度、看不清」就是这个叠加爆的。 */
  const brightness = +(S.brightness !== undefined ? S.brightness : 0.75);
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    color: new THREE.Color(brightness, brightness, brightness),
    emissive: new THREE.Color(S.lightColor || '#ffffff'),
    emissiveMap: texture,
    emissiveIntensity: +(S.emissive !== undefined ? S.emissive : 0.35),
    roughness: 0.78,
    metalness: 0.0,
    side: THREE.DoubleSide,
    /* 淡入淡出要用（用户 2026-10-05「电视的物体要慢慢淡入」）：
       初始 opacity 0，setOn(true) 之后由 applyFade 推上去；不设成 transparent
       的话 three 会走不透明分支，opacity 改了也不生效。 */
    transparent: true,
    opacity: 0
  });

  const screen = new THREE.Mesh(geo, mat);
  screen.position.set(S.position[0], S.position[1], S.position[2]);
  screen.rotation.y = +(S.rotationY !== undefined ? S.rotationY : 0);
  screen.castShadow = false;
  screen.receiveShadow = false;
  group.add(screen);

  /* 幕布黑框（刻意只留 上/左/右 三条 —— 去掉底下那条水平的「架子」，
     幕布就成了悬空的三面框，没有落地托盘的实感，更贴「梦核 / 投影」的气质。
     保留三面是为了让画面有个框住视频的边，不是一张裸幕布。） */
  const thick = +(S.frameThickness !== undefined ? S.frameThickness : 0.06);
  let frameMat = null;                       // 提到外层，applyFade 也要动它
  if(thick > 0){
    frameMat = new THREE.MeshStandardMaterial({ color: S.frameColor || '#2a2a40', roughness: 0.92,
      transparent: true, opacity: 0 });      // 与幕布同步淡入淡出
    const top    = new THREE.Mesh(new THREE.BoxGeometry(w + thick*2, thick, thick), frameMat);
    const left   = new THREE.Mesh(new THREE.BoxGeometry(thick, h, thick), frameMat);
    const right  = new THREE.Mesh(new THREE.BoxGeometry(thick, h, thick), frameMat);
    top.position.set(0,  h/2 + thick/2, 0);
    left.position.set(-w/2 - thick/2, 0, 0);
    right.position.set(w/2 + thick/2, 0, 0);
    screen.add(top, left, right);
  }

  /* ---- 幕布辉光（2026-10-06「电视屏幕应该带一点 bloom，现在去得太彻底了」）----
     为什么必须**单独**加这一层：night 档的 bloom 阈值是 0.45，而且是**线性空间**
     取阈值的。幕布自带的自发光 = emissiveIntensity × emissiveMap，算下来是
     0.35 ×（程序化画布中心柔光的线性亮度 ~0.10）≈ 0.03~0.05 —— 比阈值低整整
     一个数量级。所以把 emissive 往上调根本没用（要调到 4 才跨得过阈值），
     屏幕上**一个 bloom 像素都吃不到**，看着就是一块不发光、缺光感的布。
     这里补一层**加性**辉光面片：贴着幕布边缘向外画一圈递减的矩形环，峰值
     取在阈值上下（线性）。历史：初始 0.65 → 2026-10-06 用户验收连降两次
     （0.325 → 0.1625）→ **2026-10-09 用户改回 0.32**（当时夜间 bloom 已回到
     strength 0.90 的朴素版，辉光的相对比重与当初不同）。
     ⚠ 现值 0.1625 **已经低于 night 档的 0.45 阈值** —— 纯 bloom 光晕基本不再出现，
     看到的是辉光面片本身的加性微光（这正是用户要的「再弱一半」）。
     若之后还想留一点 bloom：把 night 档 `bloom.threshold` 一起降到 0.20 左右即可。
     ★ 中心刻意留成全透明：加性混合下「透明 = 加 0」，所以视频画面一个像素都不动。
       早先「过曝 / 看不清」的老问题来自 emissive 与点光源的叠加，跟 bloom 无关；
       走加性 + 透明中心这条路，那类问题一次都不会重演。
     三个旋钮：glow（峰值亮度，0 = 关）、glowScale（面片 = 幕布 × 这个）、
     glowColor（辉光颜色，默认跟着点光源的暖白）。 */
  let glowMat = null;
  if(+(S.glow !== undefined ? S.glow : 0.32) > 0){
    const gScale = +(S.glowScale !== undefined ? S.glowScale : 1.55);
    const gw = w*gScale, gh = h*gScale;
    const peak = +(S.glow !== undefined ? S.glow : 0.32);

    const gc = document.createElement('canvas');
    gc.width = 256;
    gc.height = Math.max(8, Math.round(256*gh/gw));
    const gx = gc.getContext('2d');
    const GW = gc.width, GH = gc.height;

    /* ⚠ 逐像素写，**不要**改回「N 圈 strokeRect 画同心环」（2026-10-06 用户报「bloom 的
       条纹感觉明显」）。每一圈 stroke 的 alpha 是常数，圈与圈之间没有连续过渡，
       屏幕上就是 N 圈同心亮暗台阶；外圈 alpha 掉到 5/255 以下还会被 8bit 量化直接
       归零再叠一层阶梯。bloom 的多级 downsample 把这些台阶放大 ⇒ 那圈「条纹」。
       这里改成按「到屏幕矩形的外部距离 d」算连续衰减：
         a = peak * (1 - smoothstep(d))，smoothstep 即 d²(3-2d)
         —— f'(0)=f'(1)=0，所以贴屏幕那条边和贴面板外边界这两头都**没有硬边**
         （别用 (1-d)²，它的 f'(0)=-2，边缘照样一像素硬跳，实测是 39/255 的台阶）；
         四角用 hypot ⇒ 距离更大，自然收成圆角，不用再叠一层 destination-in 渐隐。 */
    const hw = GW/2, hh = GH/2;               // 面片半宽/半高（纹素）
    const sw = hw/gScale, sh2 = hh/gScale;    // 屏幕矩形在半张纹理里的半宽/半高
    const band = Math.min(hw - sw, hh - sh2); // 向外可延伸的带宽（纹素）
    const img = gx.createImageData(GW, GH);
    const px = img.data;
    for(let y=0;y<GH;y++){
      const dy = Math.abs(y + 0.5 - hh) - sh2; // >0 才在屏幕矩形之外
      for(let x=0;x<GW;x++){
        const dx = Math.abs(x + 0.5 - hw) - sw;
        let a = 0;
        if(dx > 0 || dy > 0){
          const d = Math.hypot(dx > 0 ? dx : 0, dy > 0 ? dy : 0)/band;
          if(d < 1){ a = peak*(1 - d*d*(3 - 2*d)); }   // 1-smoothstep：两端斜率都为 0
        }
        const i = (y*GW + x)*4;
        px[i] = 255; px[i+1] = 244; px[i+2] = 226;
        px[i+3] = (a*255 + 0.5) | 0;
      }
    }
    gx.putImageData(img, 0, 0);

    const gtex = new THREE.CanvasTexture(gc);
    if(gtex.colorSpace !== undefined) gtex.colorSpace = THREE.SRGBColorSpace;
    /* 显式关 mipmap + 双线性：这张贴图贴在固定尺寸的平面上，本来就没有多级细节需求；
       开着 mipmap 反而会在距离变化时让细环忽隐忽现（更闪）。 */
    gtex.generateMipmaps = false;
    gtex.minFilter = THREE.LinearFilter;
    gtex.magFilter = THREE.LinearFilter;
    gtex.anisotropy = 1;
    glowMat = new THREE.MeshBasicMaterial({
      map: gtex,
      color: new THREE.Color(S.glowColor || '#fff2dd'),
      transparent: true,
      opacity: 0,                             // 与幕布同步淡入淡出
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), glowMat);
    /* 局部 +Z 就是朝向床（观众）那一面；贴 3.5cm 免得跟幕布 z-fighting。
       挂在 screen 下面 ⇒ 幕布 visible=false 时辉光一起消失，不用另外管。 */
    glow.position.set(0, 0, 0.035);
    glow.renderOrder = RO.PROJ;
    screen.add(glow);
  }

  /* 点光源：幕布前方的投影仪辉光 */
  const light = new THREE.PointLight(
    new THREE.Color(L.color || '#ffd9b8'),
    +(L.intensity !== undefined ? L.intensity : 1.1),
    +(L.distance !== undefined ? L.distance : 13),
    +(L.decay !== undefined ? L.decay : 1.7)
  );
  light.position.set(L.position[0], L.position[1], L.position[2]);
  group.add(light);

  /* ---- 第二盏：电视机的本体光（2026-10-06「点光源位置不对，要放在电视机中间，
     另外点光源排除照亮电视机」）----
     ① **位置就是「排除照亮电视机」的那个开关**。three 的 WebGLRenderer 没有
        per-object 排除光源的机制（那是 WebGPURenderer 的 NodeMaterial 才有的
        light filtering），想不照亮某样东西只能靠几何：漫反射是 N·L，
        **灯在屏幕正面那一侧就会照亮正面**（原来那盏在 x=-7.15、屏幕在 -8.23，
        正好在正面，辐照度 0.55/1.08^1.7 ≈ 0.48 额外打在屏幕上）。
        把灯挪到**屏幕背面 12cm**（x = -8.23 - 0.12 = -8.35，y/z 与屏幕中心对齐）
        ⇒ 屏幕正面法线 (+X) 与光方向 (-X) 反向，N·L < 0，**正面一点光都收不到**，
        而光照样往 +X 铺出去照亮床。**正好同时满足「放在电视机中间」+「别照亮它」。**
     ② **decay 才是决定能照多远的那一个**（r15x+）：`distance` 只是软截止
        （`1-(d/cut)^4` 的窗口，d=cut/4 时还有 0.99），26→34 在 6.5m 处只差 0.5%。
        所以「让光覆盖到床」＝压 decay ＋重配 intensity，不是调 distance。
        从 x=-8.35 算：床尾 (x=-6.23) 距离 2.83m、床心 (x=-2) 距离 6.62m。
        decay 1.05 / intensity 2.0 ⇒ 床尾 ≈ 0.68、床心 ≈ 0.29 辐照度
        （夜间环境总面光 ≈ 1.8，即局部 +38% / +16%，看得见又不刺眼）。 */
  const SL = P.spill || {};
  const SLpos = SL.position || [-8.35, 3.95, 1.2];
  const spillBase = +(SL.intensity !== undefined ? SL.intensity : 2.0);
  const spill = new THREE.PointLight(
    new THREE.Color(SL.color || L.color || '#ffd9b8'),
    spillBase,
    +(SL.distance !== undefined ? SL.distance : 30),
    +(SL.decay !== undefined ? SL.decay : 1.05)
  );
  spill.position.set(SLpos[0], SLpos[1], SLpos[2]);
  group.add(spill);

  /* 程序化「老电影/梦境」动画 */
  let animT = 0;
  let nextFrame = 0;
  const fps = +(V.fps !== undefined ? V.fps : 16);
  const falloff = +(S.falloff !== undefined ? S.falloff : 0.38);

  function drawFilm(t){
    const W = cvs.width, H = cvs.height;
    const flicker = 0.88 + 0.12*Math.sin(t*7.3) + 0.07*Math.sin(t*13.7);

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#090912');
    bg.addColorStop(0.5, '#131323');
    bg.addColorStop(1, '#0a0a14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    /* 中央柔光梦核色块 */
    const cx = W/2 + W*0.12*Math.sin(t*0.42);
    const cy = H/2 + H*0.09*Math.cos(t*0.55);
    const r = Math.min(W, H) * (0.30 + 0.03*Math.sin(t*0.8));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(210,180,255,${0.34*flicker})`);
    g.addColorStop(0.45, `rgba(130,150,225,${0.18*flicker})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    /* 漂移文字 */
    ctx.save();
    ctx.translate(W/2, H/2 + H*0.16);
    ctx.rotate(Math.sin(t*0.30)*0.025);
    ctx.font = `bold ${Math.round(W/13)}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(235,225,255,${0.58*flicker})`;
    ctx.fillText('梦 核 电 影', 0, 0);
    ctx.restore();

    /* 胶片颗粒 */
    ctx.fillStyle = `rgba(255,255,255,${0.10*flicker})`;
    for(let i=0;i<800;i++){
      const x = Math.random()*W, y = Math.random()*H, a = Math.random();
      ctx.globalAlpha = a * 0.12 * flicker;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;

    /* 扫描线 */
    ctx.fillStyle = `rgba(0,0,0,${0.05*flicker})`;
    for(let y=0;y<H;y+=3) ctx.fillRect(0, y, W, 1);

    /* 暗角 */
    const vg = ctx.createRadialGradient(W/2, H/2, W*0.32, W/2, H/2, W*0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,0,${0.55 + falloff*0.35})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  if(!src) drawFilm(0); // 首帧先画好，避免上屏时花一秒才出内容

  /* 补一次「已经 ready 但 canplay 也许已经错过」的判定 —— 此时 screen 已建好，
     swapToVideo 里那些 screen.material 赋值才是安全的。 */
  if(videoEl && videoEl.readyState >= 2) swapToVideo();

  /* 诊断出口（2026-10-06）：<video> 是 createElement 出来的、没插进 DOM，
     页面里没法用 querySelector 摸到它，而排查「手机上放不出来」必须看
     readyState / error / networkState。挂到 userData 上，无头探针直接读。 */
  if(videoEl) group.userData.videoEl = videoEl;
  group.userData.spill = spill;             // 无头探针读辐照度用
  group.userData.light = light;             // 同上：主灯（幕布正面溢光）

  /* ⚠ iOS Safari 的自动播放策略：<video> 只有在 **muted** 或「用户手势的同步调用栈里」
       调 play() 时才会动。点「看电视」时 setOn 是在手势里的，理论上够；
       但只要中途被 unmute 过一次（tvAudioOn 就会 unmute），后续 play() 就可能被拒，
       于是「有画面尺寸、readyState 4、currentTime 恒 0」—— 看起来完全正常却不动。
       这里每帧重试前先把 muted 置 true 再 play()，等于走「静音起播」这条最稳的路。 */
  /* ⚠⚠⚠ 这两个函数定义在 `if(src){ … }` 块**之外**，所以只能引用块外可见的
     `videoEl`（函数顶部 let 声明）。早先这里写的是块内的 `const ve`
     ⇒ 每帧抛 ReferenceError、被空 catch 吞掉 ⇒ **play() 从来没被调用过**，
     视频永远停在第一帧（2026-10-06 用户原话「不播放，停在了第一帧」的真凶）。
     教训与本项目里 `bgmBefore` 那次一模一样：并列/跨块的作用域 ReferenceError
     是隐形的，`node --check` 查不出、页面照常渲染、只有那条链路默默失效。 */
  let firstPlayFired = false, lastPlayErr = null, tryPlayN = 0;
  const tryPlay = ()=>{
    const ve = videoEl;                 // ★ 必须用块外的 videoEl
    if(!ve) return;
    try{
      if(!ve.paused){
        if(!firstPlayFired){ firstPlayFired = true; fireFirstPlay(); }
        return;
      }
      tryPlayN++;
      if(!ve.muted) ve.muted = true;      // 静音起播：iOS 只认「静音」或「手势内 play」
      const p = ve.play();
      if(p && p.then) p.then(()=>{ lastPlayErr = null; if(!firstPlayFired){ firstPlayFired = true; fireFirstPlay(); } })
                          .catch((e)=>{ lastPlayErr = (e && e.name ? e.name : 'Error') + ': ' + (e && e.message || e); });
    }catch(e){ lastPlayErr = 'throw: ' + (e && e.message || e); }
  };
  /* 诊断出口：play() 被拒的真实原因 + 尝试次数（无头探针与真机排查都靠它，
     之前 play() 的 rejection 被空 catch 吃掉，症状只能靠猜）。 */
  group.userData.tvDiag = ()=>{ const ve = videoEl;
    if(!ve) return null;
    try{ return { tries: tryPlayN, lastErr: lastPlayErr,
      paused: ve.paused, muted: ve.muted, seeking: ve.seeking, t: +ve.currentTime.toFixed(2),
      rs: ve.readyState }; }catch(_){ return null; } };
  /* 「真的开始播了」这个信号，用来把**解锁声音**这件事延后到画面已经动起来之后。
     iOS 上 unmute 早于 playing 有风险（见上面 tvAudioOn 的注释），
     声音晚半秒无所谓，画面卡住才是致命的。 */
  function fireFirstPlay(){
    try{ if(group.userData.onFirstPlay) group.userData.onFirstPlay(); }catch(_){}
  }

  group.userData.update = function(dt, now){
    if(fadeT !== fadeTo){                    // 淡入淡出驱动（Group 隐藏时也要跑）
      const fwd = fadeTo > fadeT;
      fadeT += (fwd ? 1 : -1) * (dt / (fwd ? FADE_IN : FADE_OUT));
      if((fwd && fadeT >= 1) || (!fwd && fadeT <= 0)) fadeT = fadeTo;
      applyFade();
      if(fadeT === 0){ group.visible = false; screen.visible = false; light.visible = false; }
    }
    if(!group.visible) return;
    if(videoEl){
      if(videoEl.readyState >= 2) tryPlay();
      return;
    }
    if(now < nextFrame) return;
    nextFrame = now + 1/fps;
    animT += dt;
    drawFilm(animT);
    texture.needsUpdate = true;
  };

  /* ---- 淡入淡出（2026-10-05「电视的物体要慢慢淡入」）----
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
    if(glowMat) glowMat.opacity = o;        // 辉光跟着一起淡，不然半透的布配死亮的光晕
    light.intensity = lightBase * o;
    spill.intensity = spillBase * o;          // 补光同理：布淡了一半光也必须跟着淡
  }
  applyFade();                               // 初始：全透
  group.userData.setOn = function(on){
    const v = !!on;
    if(fadeTo === (v ? 1 : 0)) return;       // 已经在往这个方向走了，别重启
    fadeTo = v ? 1 : 0;
    if(v){
      group.visible = true; screen.visible = true; light.visible = true;
      /* spill 不用单独开：它是 group 的子物体，group.visible 一恢复就都在。 */
    }
    if(videoEl){
      /* 关：视频立刻停（用户 2026-10-05「关闭视频播放」），停住的那一帧陪着淡出，
         不必等 fade 跑完才停 —— 淡出总共才 0.9s。 */
      if(v){
        /* ⚠⚠ 别在起播前 seek。线上是 python http.server，**对 Range 请求一律返回 200
           全量、不给 206**；此时设 currentTime 会让浏览器去要它给不出的字节，
           元素卡在 seeking 状态，连带后面的 play() 也一起卡住 ——
           症状就是「不播放，停在第一帧」（2026-10-06 用户原话）。
           只有真的播过一段（数据已在内存缓冲里）才回到开头，那时 seek 是安全的。 */
        try{ if(videoEl.currentTime > 0.5) videoEl.currentTime = 0; }catch(_){}
        tryPlay();
      }
      else { videoEl.pause(); }
    }
    tvAudioOn(v);
    /* 通知外部「电视开/关」了。放在 setOn 里而不是按钮回调里，是因为 setOn 是
       **所有**开关路径的收口：点按钮、closeProjector、按 R 复位、切到非夜间时相，
       全都走它 —— 挂在按钮上会漏掉后面三条。 */
    try{ if(group.userData.onSetOn) group.userData.onSetOn(!!v); }catch(_){}
  };

  /* ⚠ 初始隐藏**不能**只靠 `setOn(false)`：那时 fadeTo 已经是 0，setOn 会
     early return 直接走人，visible 还是构建期默认的 true。所以必须按 fadeT=0
     的状态把可见性摆一遍（opacity 也是 0，但 visible=true 会让 update 里那句
     `if(!group.visible) return` 之外的东西白跑，也别留着）。 */
  applyFade();
  group.visible = false; screen.visible = false; light.visible = false;
  group.userData.setOn(false);      // 幂等：fadeTo 已是 0，只是把「关」这条路注册上
  return group;
}
