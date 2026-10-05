#!/usr/bin/env node
/* ============================================================================
   glb-vertex-ao.mjs —— 把「逐顶点环境光遮蔽(AO)」烘焙进 GLB 的 COLOR_0

   用途：给低模增加真实感。AO 是纯几何量，烘焙到顶点色后材质用 vertexColors
   直接乘到 albedo 上 —— 不需要 SSAO 后处理、不需要额外贴图、不依赖任何图片
   解码能力（小红书那种禁图片解码的容器里也照跑）。

   做法：
     1. 解析 GLB 的 POSITION / NORMAL / 索引。
     2. 按「量化位置」把重复顶点归并（UV 接缝 / 硬边会把同一点拆成多个顶点，
        不归并的话 AO 会在接缝处裂开）。
     3. 均匀网格加速：单元边长 ≈ 射线最大长度，射线只需扫 3×3×3 邻域。
     4. 每顶点按余弦加权半球撒 RAYS 条射线，命中即遮蔽（可提前退出）。
     5. 数值整形：先 raw-gamma 拉对比 → 再压到 floor 下限 → 可选 strength 缩放。
     6. 写回 COLOR_0（u16 归一化）。已有 COLOR_0 就原地覆写（文件大小不变）。

   关键坑（踩过）：
     · **非等比缩放**：模型在场景里常被拉成非等比（本床 局部→世界 是 3.37/4.23/4.97）。
       在局部空间用球形半径算 AO，到世界空间就成了扁椭球 —— 必须用 --scale 把
       顶点缩到「世界比例」再算，--dist 才是真正的世界米数。
     · **跨射线去重**：三角形按质心只挂一个网格单元，3×3×3 扫描里天然不会重复；
       若再加一个跨射线去重缓存，会把「本射线还没测过」的三角形误判为已测，
       后面所有射线全部空转 —— AO 直接算废。

   用法：
     node tools/glb-vertex-ao.mjs --in models/bed2.glb.json --scale 3.37,4.23,4.97 \
          --dist 0.55 --rays 192 --raw-gamma 2.2 --floor 0.30
     node tools/glb-vertex-ao.mjs --in <glb> --print-only
     node tools/glb-vertex-ao.mjs --in <glb> --scale a,b,c --dist d --name v2 --emit tools/_ao-variants.json
       （--emit：不写 GLB，而是把这一组的 u16 顶点色累积进 JSON，供探针一次渲染多组）
   ============================================================================ */

import fs from 'fs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const IN         = opt('in');
const OUT        = opt('out', IN);
const DIST       = parseFloat(opt('dist', '0.22'));      // 射线最大长度（--scale 之后的世界单位）
const RAYS       = parseInt(opt('rays', '128'), 10);
const FLOOR      = parseFloat(opt('floor', '0.30'));     // 全遮蔽时的下限亮度
const RAW_GAMMA  = parseFloat(opt('raw-gamma', '1.0'));  // 作用在「未遮蔽比例」上的对比曲线，>1 拉开暗部
const STRENGTH   = parseFloat(opt('strength', '1.0'));   // 0=不生效 1=满强度
const MINA       = parseFloat(opt('min', '0.0'));        // 硬下限：防止 strength 放大后内表面变纯黑
const SCALE      = (opt('scale', '') || '').split(',').map(Number);   // 局部→世界的每轴缩放
const EMIT       = opt('emit', '');
const NAME       = opt('name', 'v');
const PRINT_ONLY = flag('print-only');
const REVERT     = flag('revert');     // 把 COLOR_0 抹回全白（撤销 AO）

if (!IN) { console.error('缺 --in <glb>'); process.exit(2); }
const SX = SCALE.length === 3 && SCALE.every(Number.isFinite) ? SCALE : [1, 1, 1];

/* ---------------------------------------------------------------- GLB 解析 */
const buf = fs.readFileSync(IN);
if (buf.toString('ascii', 0, 4) !== 'glTF') { console.error(IN + ' 不是二进制 GLB'); process.exit(2); }
const jsonLen  = buf.readUInt32LE(12);
const JSON_AT  = 20;
const json     = JSON.parse(buf.toString('utf8', JSON_AT, JSON_AT + jsonLen));
const binHdrAt = JSON_AT + jsonLen;
const binLen   = buf.readUInt32LE(binHdrAt);
const bin      = buf.subarray(binHdrAt + 8, binHdrAt + 8 + binLen);
if (buf.toString('ascii', binHdrAt + 4, binHdrAt + 8) !== 'BIN\0') { console.error('第二个 chunk 不是 BIN'); process.exit(2); }

const CSIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const readAcc = (idx) => {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  const cs = CSIZE[a.componentType], nc = NCOMP[a.type];
  const stride = bv.byteStride || cs * nc;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * nc);
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride;
    for (let c = 0; c < nc; c++) {
      const p = o + c * cs;
      switch (a.componentType) {
        case 5126: out[i * nc + c] = bin.readFloatLE(p); break;
        case 5123: out[i * nc + c] = bin.readUInt16LE(p); break;
        case 5125: out[i * nc + c] = bin.readUInt32LE(p); break;
        case 5121: out[i * nc + c] = bin.readUInt8(p); break;
        case 5122: out[i * nc + c] = bin.readInt16LE(p); break;
        case 5120: out[i * nc + c] = bin.readInt8(p); break;
      }
    }
  }
  return out;
};

const prims = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  for (let pi = 0; pi < json.meshes[mi].primitives.length; pi++) {
    const pr = json.meshes[mi].primitives[pi];
    if ((pr.mode === undefined ? 4 : pr.mode) !== 4) continue;
    const pos = readAcc(pr.attributes.POSITION);
    const nor = pr.attributes.NORMAL !== undefined ? readAcc(pr.attributes.NORMAL) : null;
    const nv = pos.length / 3;
    let idx;
    if (pr.indices !== undefined) { const raw = readAcc(pr.indices); idx = new Uint32Array(raw.length); for (let i = 0; i < raw.length; i++) idx[i] = raw[i]; }
    else { idx = new Uint32Array(nv); for (let i = 0; i < nv; i++) idx[i] = i; }
    prims.push({ mesh: mi, prim: pi, pos, nor, idx, nv, accColor: pr.attributes.COLOR_0 });
  }
}

/* --------------------------------------------------------- 逐 primitive 烘焙 */
function bakePrim(P) {
  const { idx, nv } = P;
  const nTri = (idx.length / 3) | 0;

  // 缩放到「世界比例」：AO 半径在这里才是各向同性的
  const pos = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) { pos[i*3] = P.pos[i*3]*SX[0]; pos[i*3+1] = P.pos[i*3+1]*SX[1]; pos[i*3+2] = P.pos[i*3+2]*SX[2]; }
  // 法线按逆转置（对角缩放的逆转置 = 1/s），再归一化
  let nor = null;
  if (P.nor) { nor = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { nor[i*3] = P.nor[i*3]/SX[0]; nor[i*3+1] = P.nor[i*3+1]/SX[1]; nor[i*3+2] = P.nor[i*3+2]/SX[2]; } }

  let bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) { const v = pos[i*3+c]; if (v < bmin[c]) bmin[c] = v; if (v > bmax[c]) bmax[c] = v; }

  const tv = new Float64Array(nTri * 9);
  const tmin = new Float64Array(nTri * 3), tmax = new Float64Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    for (let c = 0; c < 3; c++) { tmin[t*3+c] = Infinity; tmax[t*3+c] = -Infinity; }
    for (let k = 0; k < 3; k++) {
      const vi = idx[t*3+k];
      for (let c = 0; c < 3; c++) { const v = pos[vi*3+c]; tv[t*9+k*3+c] = v; if (v < tmin[t*3+c]) tmin[t*3+c] = v; if (v > tmax[t*3+c]) tmax[t*3+c] = v; }
    }
  }

  /* 均匀网格（CSR）：单元边长 = DIST；三角形按质心只挂一个单元 */
  const cs = DIST;
  const gx = Math.max(1, Math.ceil((bmax[0]-bmin[0])/cs) + 1);
  const gy = Math.max(1, Math.ceil((bmax[1]-bmin[1])/cs) + 1);
  const gz = Math.max(1, Math.ceil((bmax[2]-bmin[2])/cs) + 1);
  const nc = gx * gy * gz;
  const cellOf = (x, y, z) => {
    let i = Math.floor((x-bmin[0])/cs); if (i < 0) i = 0; else if (i >= gx) i = gx-1;
    let j = Math.floor((y-bmin[1])/cs); if (j < 0) j = 0; else if (j >= gy) j = gy-1;
    let k = Math.floor((z-bmin[2])/cs); if (k < 0) k = 0; else if (k >= gz) k = gz-1;
    return (k*gy + j)*gx + i;
  };
  const counts = new Int32Array(nc + 1);
  const triCells = new Int32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    triCells[t] = cellOf((tmin[t*3]+tmax[t*3])*0.5, (tmin[t*3+1]+tmax[t*3+1])*0.5, (tmin[t*3+2]+tmax[t*3+2])*0.5);
    counts[triCells[t] + 1]++;
  }
  for (let i = 0; i < nc; i++) counts[i+1] += counts[i];
  const items = new Int32Array(nTri);
  const cursor = counts.slice(0, nc);
  for (let t = 0; t < nTri; t++) items[cursor[triCells[t]]++] = t;

  /* 位置归并：同一点的所有顶点共用一份 AO（否则 UV 接缝处 AO 会裂开） */
  const map = new Map();
  const vid = new Int32Array(nv);
  const gpx = [], gpy = [], gpz = [], gnx = [], gny = [], gnz = [];
  const q = 1e5;
  for (let i = 0; i < nv; i++) {
    const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
    const key = Math.round(x*q) + '|' + Math.round(y*q) + '|' + Math.round(z*q);
    let g = map.get(key);
    if (g === undefined) { g = gpx.length; map.set(key, g);
      gpx.push(0); gpy.push(0); gpz.push(0); gnx.push(0); gny.push(0); gnz.push(0); }
    vid[i] = g;
    gpx[g] += x; gpy[g] += y; gpz[g] += z;
    if (nor) { gnx[g] += nor[i*3]; gny[g] += nor[i*3+1]; gnz[g] += nor[i*3+2]; }
  }
  const ng = gpx.length;
  const cnt = new Float64Array(ng);
  for (let i = 0; i < nv; i++) cnt[vid[i]]++;
  for (let g = 0; g < ng; g++) {
    gpx[g] /= cnt[g]; gpy[g] /= cnt[g]; gpz[g] /= cnt[g];
    let nx = gnx[g], ny = gny[g], nz = gnz[g];
    let L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-9)) { nx = 0; ny = 1; nz = 0; L = 1; }
    gnx[g] = nx/L; gny[g] = ny/L; gnz[g] = nz/L;
  }

  /* 采样方向（Hammersley + 余弦加权），所有顶点复用 */
  const radical = (i) => {
    let b = i;
    b = ((b << 16) | (b >>> 16)) >>> 0;
    b = (((b & 0x55555555) << 1) | ((b & 0xAAAAAAAA) >>> 1)) >>> 0;
    b = (((b & 0x33333333) << 2) | ((b & 0xCCCCCCCC) >>> 2)) >>> 0;
    b = (((b & 0x0F0F0F0F) << 4) | ((b & 0xF0F0F0F0) >>> 4)) >>> 0;
    b = (((b & 0x00FF00FF) << 8) | ((b & 0xFF00FF00) >>> 8)) >>> 0;
    return b * 2.3283064365386963e-10;
  };
  const SR = new Float64Array(RAYS * 2);
  for (let i = 0; i < RAYS; i++) { SR[i*2] = Math.sqrt(1 - (i + 0.5)/RAYS); SR[i*2+1] = 2*Math.PI*radical(i); }

  const tminEps = Math.max(1e-6, (bmax[0]-bmin[0]) * 1e-5);
  const ao = new Float64Array(ng);
  const t0 = Date.now();

  for (let g = 0; g < ng; g++) {
    const px = gpx[g], py = gpy[g], pz = gpz[g];
    const nx = gnx[g], ny = gny[g], nz = gnz[g];
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(ny) > 0.99) { ax = 1; ay = 0; az = 0; }
    let tx = ay*nz - az*ny, ty = az*nx - ax*nz, tz = ax*ny - ay*nx;
    const L = Math.hypot(tx, ty, tz); tx /= L; ty /= L; tz /= L;
    const bx = ny*tz - nz*ty, by = nz*tx - nx*tz, bz = nx*ty - ny*tx;
    const eps = Math.max(1e-6, (bmax[0]-bmin[0]) * 1e-5);
    const ox = px + nx*eps, oy = py + ny*eps, oz = pz + nz*eps;

    const ci = Math.floor((px-bmin[0])/cs), cj = Math.floor((py-bmin[1])/cs), ck = Math.floor((pz-bmin[2])/cs);
    let hits = 0;
    for (let s = 0; s < RAYS; s++) {
      const st = SR[s*2], ph = SR[s*2+1];
      const ct = Math.sqrt(Math.max(0, 1 - st*st));
      const cp = Math.cos(ph), sp = Math.sin(ph);
      const dx = tx*(st*cp) + bx*(st*sp) + nx*ct;
      const dy = ty*(st*cp) + by*(st*sp) + ny*ct;
      const dz = tz*(st*cp) + bz*(st*sp) + nz*ct;
      let occluded = false;
      for (let kk = ck-1; kk <= ck+1 && !occluded; kk++) {
        if (kk < 0 || kk >= gz) continue;
        for (let jj = cj-1; jj <= cj+1 && !occluded; jj++) {
          if (jj < 0 || jj >= gy) continue;
          const rowBase = (kk*gy + jj)*gx;
          for (let ii = ci-1; ii <= ci+1 && !occluded; ii++) {
            if (ii < 0 || ii >= gx) continue;
            const cell = rowBase + ii;
            const s0 = counts[cell], s1 = counts[cell+1];
            for (let m = s0; m < s1; m++) {
              const t = items[m];
              /* 每三角形只挂一个单元 → 27 邻域里最多出现一次，**不需要去重** */
              const e1x = tv[t*9+3]-tv[t*9],   e1y = tv[t*9+4]-tv[t*9+1], e1z = tv[t*9+5]-tv[t*9+2];
              const e2x = tv[t*9+6]-tv[t*9],   e2y = tv[t*9+7]-tv[t*9+1], e2z = tv[t*9+8]-tv[t*9+2];
              const hx = dy*e2z - dz*e2y, hy = dz*e2x - dx*e2z, hz = dx*e2y - dy*e2x;
              const det = e1x*hx + e1y*hy + e1z*hz;
              if (det > -1e-14 && det < 1e-14) continue;
              const inv = 1/det;
              const sx = ox-tv[t*9], sy = oy-tv[t*9+1], sz = oz-tv[t*9+2];
              const u = (sx*hx + sy*hy + sz*hz)*inv;
              if (u < -1e-7 || u > 1+1e-7) continue;
              const qx = sy*e1z - sz*e1y, qy = sz*e1x - sx*e1z, qz = sx*e1y - sy*e1x;
              const v = (dx*qx + dy*qy + dz*qz)*inv;
              if (v < -1e-7 || u+v > 1+1e-7) continue;
              const tt = (e2x*qx + e2y*qy + e2z*qz)*inv;
              if (tt > tminEps && tt < DIST) { occluded = true; break; }
            }
          }
        }
      }
      if (occluded) hits++;
    }
    let a = 1 - hits/RAYS;
    if (RAW_GAMMA !== 1) a = Math.pow(Math.max(0, a), RAW_GAMMA);   // 先拉对比
    a = FLOOR + (1-FLOOR)*a;                                        // 再保下限
    if (STRENGTH !== 1) a = 1 - STRENGTH*(1-a);
    ao[g] = Math.max(MINA, Math.min(1, a));
  }

  let mn = 1, mx = 0, sum = 0;
  const hist = new Array(10).fill(0);
  for (let g = 0; g < ng; g++) { const a = ao[g]; if (a < mn) mn = a; if (a > mx) mx = a; sum += a; hist[Math.min(9, Math.floor(a*10))]++; }
  return { ao, vid, ng, nv, nTri, mn, mx, mean: sum/ng, dt: (Date.now()-t0)/1000, hist };
}

/* ---------------------------------------------------------------- 执行 */
const reports = [];
const emits = [];
for (const P of prims) {
  const R = bakePrim(P);
  reports.push({ mesh: P.mesh, prim: P.prim, ...R });
  console.log(`[mesh${P.mesh}/prim${P.prim}] 顶点 ${R.nv}（合并 ${R.ng} 组）三角形 ${R.nTri}  ${R.dt.toFixed(1)}s`);
  console.log(`   AO min ${R.mn.toFixed(3)} max ${R.mx.toFixed(3)} mean ${R.mean.toFixed(3)}`);
  console.log(`   分布 ${R.hist.map((c,i)=>`${(i/10).toFixed(1)}:${c}`).join(' ')}`);

  // 造 u16 顶点色
  const VALUES = new Uint16Array(R.nv * 4);
  for (let i = 0; i < R.nv; i++) {
    const v = REVERT ? 65535 : Math.round(R.ao[R.vid[i]] * 65535);
    VALUES[i*4] = v; VALUES[i*4+1] = v; VALUES[i*4+2] = v; VALUES[i*4+3] = 65535;
  }
  emits.push({ mesh: P.mesh, prim: P.prim, nv: R.nv, values: Buffer.from(VALUES.buffer).toString('base64') });

  if (PRINT_ONLY || EMIT) continue;

  if (P.accColor !== undefined) {
    const a = json.accessors[P.accColor];
    if (a.type !== 'VEC4' || a.componentType !== 5123) { console.error('   ! COLOR_0 不是 VEC4/u16，暂不支持'); continue; }
    const bv = json.bufferViews[a.bufferView];
    const stride = bv.byteStride || 8;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < R.nv; i++) {
      bin.writeUInt16LE(VALUES[i*4],   base + i*stride + 0);
      bin.writeUInt16LE(VALUES[i*4+1], base + i*stride + 2);
      bin.writeUInt16LE(VALUES[i*4+2], base + i*stride + 4);
      bin.writeUInt16LE(VALUES[i*4+3], base + i*stride + 6);
    }
    if (REVERT) { a.min = [65535,65535,65535,65535]; a.max = [65535,65535,65535,65535]; }
    else {
      let mn = 65535, mx = 0;
      for (let i = 0; i < R.nv; i++) { const v = VALUES[i*4]; if (v < mn) mn = v; if (v > mx) mx = v; }
      a.min = [mn,mn,mn,65535]; a.max = [mx,mx,mx,65535];
    }
    console.log(`   → ${REVERT?'抹回全白':'原地覆写 COLOR_0'}（accessor ${P.accColor}）`);
  } else {
    console.error('   ! 该 primitive 没有 COLOR_0，跳过');
  }
}

if (EMIT) {
  let doc = { variants: {} };
  if (fs.existsSync(EMIT)) { try { doc = JSON.parse(fs.readFileSync(EMIT, 'utf8')); } catch {} }
  if (!doc.variants) doc.variants = {};
  doc.nv = reports.length ? reports[0].nv : 0;
  doc.ng = reports.length ? reports[0].ng : 0;
  doc.itemSize = 4;
  /* 数值按变体分别存 —— 早先写成 doc.prims = emits 是错的：
     每个变体都会把上一份覆盖掉，最后一组数值被所有名字共用。 */
  doc.variants[NAME] = {
    dist: DIST, rays: RAYS, floor: FLOOR, rawGamma: RAW_GAMMA, strength: STRENGTH, scale: SX,
    stats: reports.map(r => ({ mean: +r.mean.toFixed(4), min: +r.mn.toFixed(4), max: +r.mx.toFixed(4) })),
    values: emits,
  };
  fs.writeFileSync(EMIT, JSON.stringify(doc));
  console.log(`\n→ 变体 "${NAME}" 已写入 ${EMIT}`);
}

if (!PRINT_ONLY && !EMIT) {
  let js = JSON.stringify(json);
  js += ' '.repeat((4 - (Buffer.byteLength(js) % 4)) % 4);
  const jsBuf = Buffer.from(js, 'utf8');
  const binPad = (4 - (binLen % 4)) % 4;
  const binOut = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;
  const total = 12 + 8 + jsBuf.length + 8 + binOut.length;
  const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const jH = Buffer.alloc(8); jH.writeUInt32LE(jsBuf.length, 0); jH.write('JSON', 4, 'ascii');
  const bH = Buffer.alloc(8); bH.writeUInt32LE(binOut.length, 0); bH.write('BIN\0', 4, 'ascii');
  fs.writeFileSync(OUT, Buffer.concat([head, jH, jsBuf, bH, binOut]));
  console.log(`\n写出 ${OUT}  ${buf.length} B → ${12 + 8 + jsBuf.length + 8 + binOut.length} B`);
}
