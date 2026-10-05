#!/usr/bin/env node
/* ============================================================================
   bake-bed2-ao.mjs —— 给 bed2.glb.json 烘 AO（强度 --strength）

   特殊性：bed2.glb.json 的 9 个 primitive **共享同一个 POSITION(0) 和
   同一个 COLOR_0(3) access器**。通用 baker 是「逐 prim 烘一遍、分别写 COLOR_0」，
   在这里会出问题：每个 prim 只用自己的三角形算 AO，而且 9 次写入都落在同一个
   共享 COLOR_0 上 —— 最后那次（只有 93 个三角形的 prim）会覆盖前面所有结果，
   AO 基本废掉。

   本脚本改成「聚合」：把所有 9 个 prim 的索引并成一张全局三角形表，用**全部**
   三角形算一次 AO，再写回那个唯一的 COLOR_0 一次。几何是同一套（4164 顶点），
   所以结果等价于「整张床一起烘」。

   AO 算法与通用 baker 完全一致（余弦加权半球射线 + 均匀网格 + 量化位置归并）。
   ============================================================================ */

import fs from 'fs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };

const IN    = opt('in', 'models/bed2.glb.json');
const OUT   = opt('out', IN);
const DIST  = parseFloat(opt('dist', '1.2'));
const RAYS  = parseInt(opt('rays', '256'), 10);
const FLOOR = parseFloat(opt('floor', '0.25'));
const RAW_GAMMA = parseFloat(opt('raw-gamma', '2.2'));
const STRENGTH  = parseFloat(opt('strength', '0.5'));
const MINA  = parseFloat(opt('min', '0.12'));
const SCALE = (opt('scale', '3.3694,4.23,4.9728')).split(',').map(Number);
const SX = SCALE.length === 3 && SCALE.every(Number.isFinite) ? SCALE : [1,1,1];

/* ---------------------------------------------------------------- GLB 解析 */
const buf = fs.readFileSync(IN);
if (buf.toString('ascii', 0, 4) !== 'glTF') { console.error(IN + ' 不是二进制 GLB'); process.exit(2); }
const jsonLen  = buf.readUInt32LE(12);
const JSON_AT  = 20;
const json     = JSON.parse(buf.toString('utf8', JSON_AT, JSON_AT + jsonLen));
const binHdrAt = JSON_AT + jsonLen;
const binLen   = buf.readUInt32LE(binHdrAt);
const bin      = buf.subarray(binHdrAt + 8, binHdrAt + 8 + binLen);

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

const pos = readAcc(0);
const nor = readAcc(1);
const nv  = pos.length / 3;

/* 聚合所有 prim 的索引 → 一张全局三角形表（它们都引用同一个 4164 顶点数组） */
let idx = [];
for (const m of json.meshes) {
  for (const p of m.primitives) {
    if ((p.mode === undefined ? 4 : p.mode) !== 4) continue;
    if (p.indices === undefined) { for (let i = 0; i < nv; i++) idx.push(i); }
    else { const raw = readAcc(p.indices); for (let i = 0; i < raw.length; i++) idx.push(raw[i]); }
  }
}
idx = new Uint32Array(idx);
const nTri = (idx.length / 3) | 0;
console.log(`聚合后：顶点 ${nv}，三角形 ${nTri}（所有 prim 索引合并）`);

/* --------------------------------------------------------- 逐顶点 AO（与通用 baker 同算法） */
{
  // 缩放到世界比例
  const sp = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) { sp[i*3] = pos[i*3]*SX[0]; sp[i*3+1] = pos[i*3+1]*SX[1]; sp[i*3+2] = pos[i*3+2]*SX[2]; }
  let sn = null;
  if (nor) { sn = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { sn[i*3] = nor[i*3]/SX[0]; sn[i*3+1] = nor[i*3+1]/SX[1]; sn[i*3+2] = nor[i*3+2]/SX[2]; } }

  let bmin = [Infinity,Infinity,Infinity], bmax = [-Infinity,-Infinity,-Infinity];
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) { const v = sp[i*3+c]; if (v<bmin[c]) bmin[c]=v; if (v>bmax[c]) bmax[c]=v; }

  const tv = new Float64Array(nTri * 9);
  const tmin = new Float64Array(nTri*3), tmax = new Float64Array(nTri*3);
  for (let t = 0; t < nTri; t++) {
    for (let c = 0; c < 3; c++) { tmin[t*3+c]=Infinity; tmax[t*3+c]=-Infinity; }
    for (let k = 0; k < 3; k++) {
      const vi = idx[t*3+k];
      for (let c = 0; c < 3; c++) { const v = sp[vi*3+c]; tv[t*9+k*3+c]=v; if (v<tmin[t*3+c]) tmin[t*3+c]=v; if (v>tmax[t*3+c]) tmax[t*3+c]=v; }
    }
  }

  const cs = DIST;
  const gx = Math.max(1, Math.ceil((bmax[0]-bmin[0])/cs)+1);
  const gy = Math.max(1, Math.ceil((bmax[1]-bmin[1])/cs)+1);
  const gz = Math.max(1, Math.ceil((bmax[2]-bmin[2])/cs)+1);
  const nc = gx*gy*gz;
  const cellOf = (x,y,z) => {
    let i=Math.floor((x-bmin[0])/cs); if(i<0)i=0; else if(i>=gx)i=gx-1;
    let j=Math.floor((y-bmin[1])/cs); if(j<0)j=0; else if(j>=gy)j=gy-1;
    let k=Math.floor((z-bmin[2])/cs); if(k<0)k=0; else if(k>=gz)k=gz-1;
    return (k*gy+j)*gx+i;
  };
  const counts = new Int32Array(nc+1);
  const triCells = new Int32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    triCells[t] = cellOf((tmin[t*3]+tmax[t*3])*0.5,(tmin[t*3+1]+tmax[t*3+1])*0.5,(tmin[t*3+2]+tmax[t*3+2])*0.5);
    counts[triCells[t]+1]++;
  }
  for (let i = 0; i < nc; i++) counts[i+1] += counts[i];
  const items = new Int32Array(nTri);
  const cursor = counts.slice(0, nc);
  for (let t = 0; t < nTri; t++) items[cursor[triCells[t]]++] = t;

  // 位置归并
  const map = new Map();
  const vid = new Int32Array(nv);
  const gpx=[],gpy=[],gpz=[],gnx=[],gny=[],gnz=[];
  const q = 1e5;
  for (let i = 0; i < nv; i++) {
    const x=sp[i*3],y=sp[i*3+1],z=sp[i*3+2];
    const key = Math.round(x*q)+'|'+Math.round(y*q)+'|'+Math.round(z*q);
    let g = map.get(key);
    if (g===undefined){ g=gpx.length; map.set(key,g); gpx.push(0);gpy.push(0);gpz.push(0);gnx.push(0);gny.push(0);gnz.push(0); }
    vid[i]=g; gpx[g]+=x;gpy[g]+=y;gpz[g]+=z;
    if (sn){ gnx[g]+=sn[i*3];gny[g]+=sn[i*3+1];gnz[g]+=sn[i*3+2]; }
  }
  const ng = gpx.length;
  const cnt = new Float64Array(ng);
  for (let i = 0; i < nv; i++) cnt[vid[i]]++;
  for (let g = 0; g < ng; g++) {
    gpx[g]/=cnt[g];gpy[g]/=cnt[g];gpz[g]/=cnt[g];
    let nx=gnx[g],ny=gny[g],nz=gnz[g]; let L=Math.hypot(nx,ny,nz);
    if(!(L>1e-9)){nx=0;ny=1;nz=0;L=1;} gnx[g]=nx/L;gny[g]=ny/L;gnz[g]=nz/L;
  }

  // 采样方向
  const radical=(i)=>{let b=i;b=((b<<16)|(b>>>16))>>>0;b=(((b&0x55555555)<<1)|((b&0xAAAAAAAA)>>>1))>>>0;b=(((b&0x33333333)<<2)|((b&0xCCCCCCCC)>>>2))>>>0;b=(((b&0x0F0F0F0F)<<4)|((b&0xF0F0F0F0)>>>4))>>>0;b=(((b&0x00FF00FF)<<8)|((b&0xFF00FF00)>>>8))>>>0;return b*2.3283064365386963e-10;};
  const SR = new Float64Array(RAYS*2);
  for (let i = 0; i < RAYS; i++){ SR[i*2]=Math.sqrt(1-(i+0.5)/RAYS); SR[i*2+1]=2*Math.PI*radical(i); }

  const tminEps = Math.max(1e-6,(bmax[0]-bmin[0])*1e-5);
  const ao = new Float64Array(ng);
  const t0 = Date.now();
  for (let g = 0; g < ng; g++) {
    const px=gpx[g],py=gpy[g],pz=gpz[g],nx=gnx[g],ny=gny[g],nz=gnz[g];
    let ax=0,ay=1,az=0; if(Math.abs(ny)>0.99){ax=1;ay=0;az=0;}
    let tx=ay*nz-az*ny,ty=az*nx-ax*nz,tz=ax*ny-ay*nx; let L=Math.hypot(tx,ty,tz);tx/=L;ty/=L;tz/=L;
    const bx=ny*tz-nz*ty,by=nz*tx-nx*tz,bz=nx*ty-ny*tx;
    const eps=Math.max(1e-6,(bmax[0]-bmin[0])*1e-5);
    const ox=px+nx*eps,oy=py+ny*eps,oz=pz+nz*eps;
    const ci=Math.floor((px-bmin[0])/cs),cj=Math.floor((py-bmin[1])/cs),ck=Math.floor((pz-bmin[2])/cs);
    let hits=0;
    for (let s = 0; s < RAYS; s++) {
      const st=SR[s*2],ph=SR[s*2+1],ct=Math.sqrt(Math.max(0,1-st*st)),cp=Math.cos(ph),sp2=Math.sin(ph);
      const dx=tx*(st*cp)+bx*(st*sp2)+nx*ct,dy=ty*(st*cp)+by*(st*sp2)+ny*ct,dz=tz*(st*cp)+bz*(st*sp2)+nz*ct;
      let occluded=false;
      for (let kk=ck-1;kk<=ck+1&&!occluded;kk++){ if(kk<0||kk>=gz)continue;
        for (let jj=cj-1;jj<=cj+1&&!occluded;jj++){ if(jj<0||jj>=gy)continue;
          const rowBase=(kk*gy+jj)*gx;
          for (let ii=ci-1;ii<=ci+1&&!occluded;ii++){ if(ii<0||ii>=gx)continue;
            const cell=rowBase+ii; const s0=counts[cell],s1=counts[cell+1];
            for (let m=s0;m<s1;m++){ const t=items[m];
              const e1x=tv[t*9+3]-tv[t*9],e1y=tv[t*9+4]-tv[t*9+1],e1z=tv[t*9+5]-tv[t*9+2];
              const e2x=tv[t*9+6]-tv[t*9],e2y=tv[t*9+7]-tv[t*9+1],e2z=tv[t*9+8]-tv[t*9+2];
              const hx=dy*e2z-dz*e2y,hy=dz*e2x-dx*e2z,hz=dx*e2y-dy*e2x;
              const det=e1x*hx+e1y*hy+e1z*hz; if(det>-1e-14&&det<1e-14)continue;
              const inv=1/det; const sx0=ox-tv[t*9],sy0=oy-tv[t*9+1],sz0=oz-tv[t*9+2];
              const u=(sx0*hx+sy0*hy+sz0*hz)*inv; if(u<-1e-7||u>1+1e-7)continue;
              const qx=sy0*e1z-sz0*e1y,qy=sz0*e1x-sx0*e1z,qz=sx0*e1y-sy0*e1x;
              const v=(dx*qx+dy*qy+dz*qz)*inv; if(v<-1e-7||u+v>1+1e-7)continue;
              const tt=(e2x*qx+e2y*qy+e2z*qz)*inv; if(tt>tminEps&&tt<DIST){occluded=true;break;}
            }
          }
        }
      }
      if(occluded)hits++;
    }
    let a=1-hits/RAYS;
    if(RAW_GAMMA!==1)a=Math.pow(Math.max(0,a),RAW_GAMMA);
    a=FLOOR+(1-FLOOR)*a;
    if(STRENGTH!==1)a=1-STRENGTH*(1-a);
    ao[g]=Math.max(MINA,Math.min(1,a));
  }
  let mn=1,mx=0,sum=0; const hist=new Array(10).fill(0);
  for(let g=0;g<ng;g++){const a=ao[g];if(a<mn)mn=a;if(a>mx)mx=a;sum+=a;hist[Math.min(9,Math.floor(a*10))]++;}
  console.log(`AO 计算完成 ${((Date.now()-t0)/1000).toFixed(1)}s  分组(合并后) ${ng}`);
  console.log(`   AO min ${mn.toFixed(3)} max ${mx.toFixed(3)} mean ${(sum/ng).toFixed(3)}`);
  console.log(`   分布 ${hist.map((c,i)=>`${(i/10).toFixed(1)}:${c}`).join(' ')}`);

  /* 写回共享 COLOR_0（accessor 3） */
  const colIdx = 3;
  const a = json.accessors[colIdx];
  if (a.type!=='VEC4' || a.componentType!==5123){ console.error('   ! COLOR_0 不是 VEC4/u16，暂不支持'); process.exit(2); }
  const bv = json.bufferViews[a.bufferView];
  const stride = bv.byteStride || 8;
  const base = (bv.byteOffset||0)+(a.byteOffset||0);
  const VALUES = new Uint16Array(nv*4);
  for (let i = 0; i < nv; i++){ const v=Math.round(ao[vid[i]]*65535); VALUES[i*4]=v;VALUES[i*4+1]=v;VALUES[i*4+2]=v;VALUES[i*4+3]=65535; }
  for (let i = 0; i < nv; i++){
    bin.writeUInt16LE(VALUES[i*4],   base+i*stride+0);
    bin.writeUInt16LE(VALUES[i*4+1], base+i*stride+2);
    bin.writeUInt16LE(VALUES[i*4+2], base+i*stride+4);
    bin.writeUInt16LE(VALUES[i*4+3], base+i*stride+6);
  }
  let cmn=65535,cmx=0; for(let i=0;i<nv;i++){const v=VALUES[i*4];if(v<cmn)cmn=v;if(v>cmx)cmx=v;}
  a.min=[cmn,cmn,cmn,65535]; a.max=[cmx,cmx,cmx,65535];
  console.log(`   → 写回 COLOR_0（accessor ${colIdx}），值范围 ${cmn}..${cmx}`);
}

/* ---------------------------------------------------------------- 写出 */
let js = JSON.stringify(json);
js += ' '.repeat((4 - (Buffer.byteLength(js) % 4)) % 4);
const jsBuf = Buffer.from(js, 'utf8');
const binPad = (4 - (binLen % 4)) % 4;
const binOut = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;
const total = 12 + 8 + jsBuf.length + 8 + binOut.length;
const head = Buffer.alloc(12); head.write('glTF',0,'ascii'); head.writeUInt32LE(2,4); head.writeUInt32LE(total,8);
const jH = Buffer.alloc(8); jH.writeUInt32LE(jsBuf.length,0); jH.write('JSON',4,'ascii');
const bH = Buffer.alloc(8); bH.writeUInt32LE(binOut.length,0); bH.write('BIN\0',4,'ascii');
fs.writeFileSync(OUT, Buffer.concat([head,jH,jsBuf,bH,binOut]));
console.log(`\n写出 ${OUT}  ${buf.length} B → ${total} B`);
