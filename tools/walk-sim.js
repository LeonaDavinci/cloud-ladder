/* ============================================================
   角色巡演模拟（纯数值，不渲染）
   ------------------------------------------------------------
   复现 main.js 里的支撑面查询 + 角色状态机，按 scene.json 的
   roam.route 跑一遍「走 → 上床 → 爬梯 → 云端跳下 → 落地」，打印时间线。
   用途：改 route / 改 rig 参数后，先看数字对不对再截图。

   用法：node tools/walk-sim.js [seconds]
   ============================================================ */
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('scene.json', 'utf8'));

/* ---- 地形（与 main.js 一致） ---- */
const T = cfg.terrain, MOUND = T.mound, RANGES = T.ranges, MICRO = T.micro, BROAD = T.broad;
const clamp = (v,a,b)=> v<a?a:v>b?b:v;
const ss = (x,a,b)=>{ if(a===b) return x<a?0:1; const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
function hash2(x,y){ const n=Math.sin(x*127.1+y*311.7)*43758.5453123; return n-Math.floor(n); }
function noise2(x,y){ const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);
  const a=hash2(ix,iy),b=hash2(ix+1,iy),c=hash2(ix,iy+1),d=hash2(ix+1,iy+1);
  return a*(1-ux)*(1-uy)+b*ux*(1-uy)+c*(1-ux)*uy+d*ux*uy; }
function fbm2(x,y){ return noise2(x,y)*0.55+noise2(x*2.1,y*2.1)*0.25+noise2(x*4.3,y*4.3)*0.12+noise2(x*8.9,y*8.9)*0.08; }
function ridged(x,y,oct,freq){ let v=0,a=0.5,f=freq,norm=0;
  for(let i=0;i<oct;i++){ const n=1-Math.abs(noise2(x*f,y*f)*2-1); v+=a*n*n; norm+=a; a*=0.5; f*=2.07; }
  return v/norm; }
function terrainHeight(x,z){
  const d=Math.hypot(x,z);
  const n1=fbm2(x*0.004,z*0.004)*30.0, n2=fbm2(x*0.016+7.3,z*0.016+2.9)*6.0, n3=fbm2(x*0.06+13.1,z*0.06+5.7)*1.2;
  let h=n1+n2+n3;
  const flat=ss(d,10,38);
  h=h*(0.06+0.94*flat)+(1-flat)*0.6;
  if(BROAD) h+=ss(d,BROAD.start,BROAD.full)*BROAD.amp*fbm2(x*BROAD.freq+3.7,z*BROAD.freq);
  if(MOUND){
    const t=clamp((d-MOUND.innerRadius)/(MOUND.outerRadius-MOUND.innerRadius),0,1);
    const s=Math.pow(t,MOUND.power), valley=MOUND.top-MOUND.drop*s;
    const capped=h>valley?valley+(h-valley)*MOUND.above:h;
    const w=1-ss(d,MOUND.fadeStart,MOUND.fadeEnd);
    h=h*(1-w)+capped*w;
    const R=MOUND.roll;
    if(R){ const rw=ss(d,R.start,R.full);
      const r1=fbm2(x*R.freq+21.7,z*R.freq+8.3)*2-1, r2=fbm2(x*R.freq*2.9+4.1,z*R.freq*2.9+15.9)*2-1;
      h+=rw*R.amp*(r1+r2*R.detail); }
  }
  if(MICRO){ const mw=ss(d,MICRO.start,MICRO.full); h+=mw*MICRO.amp*(fbm2(x*MICRO.freq+41.3,z*MICRO.freq+17.9)*2-1); }
  if(RANGES){ const G=RANGES; const mr=ss(d,G.start,G.full);
    if(mr>0){
      let r=ridged(x,z,G.octaves||4,G.freq);
      if(G.freq2&&G.mix2) r=r*(1-G.mix2)+ridged(x+313.7,z-217.3,G.octaves2||3,G.freq2)*G.mix2;
      h+=mr*G.height*(G.base+(1-G.base)*r);
    }
  }
  return h;
}

/* ---- rig：床 + 梯子（复现 build() 里的计算） ---- */
const B = cfg.bed, LB = cfg.ladder;
const bedY = terrainHeight(B.position[0], B.position[2]) + B.terrainOffset;
const bedTop = bedY + B.surfaceY;
const bw = (B.size ? B.size[0] : 4.7)/2, bd = (B.size ? B.size[1] : 3.4)/2, bth = B.rotationY || 0;
const bed = { x:B.position[0], z:B.position[2], top:bedTop,
  rx: Math.abs(bw*Math.cos(bth)) + Math.abs(bd*Math.sin(bth)),
  rz: Math.abs(bw*Math.sin(bth)) + Math.abs(bd*Math.cos(bth)) };

/* Euler YXZ → 旋转后的 +Y 轴（= 梯子轴向） */
function upFromYXZ(rx, ry, rz){
  const vx=[0,1,0];
  // Rz(rz) 作用
  let v=[ vx[0]*Math.cos(rz)-vx[1]*Math.sin(rz), vx[0]*Math.sin(rz)+vx[1]*Math.cos(rz), vx[2] ];
  // Rx(rx)
  v=[ v[0], v[1]*Math.cos(rx)-v[2]*Math.sin(rx), v[1]*Math.sin(rx)+v[2]*Math.cos(rx) ];
  // Ry(ry)
  v=[ v[0]*Math.cos(ry)+v[2]*Math.sin(ry), v[1], -v[0]*Math.sin(ry)+v[2]*Math.cos(ry) ];
  return v;
}
const rot = LB.rotation || [0,0,0];
const up  = upFromYXZ(rot[0], rot[1], rot[2] || 0);
const by  = (LB.bottom[1] === null) ? bedTop + (LB.bottomOffsetY || 0) : LB.bottom[1];
const hl  = Math.hypot(up[0], up[2]) || 1;
const LD  = { foot:[LB.bottom[0], by, LB.bottom[2]], up, length:LB.length,
              step: LB.rungStep || 0.78, off:[up[2]/hl*0.42, -up[0]/hl*0.42] };

console.log(`床：顶面 y=${bedTop.toFixed(2)}  AABB x±${bed.rx.toFixed(2)} z±${bed.rz.toFixed(2)} @(${bed.x},${bed.z})`);
console.log(`梯：脚(${LD.foot.map(v=>v.toFixed(2))})  轴向(${up.map(v=>v.toFixed(3))})  长=${LD.length}  档距=${LD.step}`);
console.log(`梯顶：(${LD.foot.map((v,i)=>(v+up[i]*LD.length).toFixed(2)).join(', ')})`);

/* ---- 支撑面 ---- */
const W = cfg.walk || {};
const stepUp = W.stepUp ?? 0.62, climbUp = W.climbUp ?? 0.95, grab = W.ladderGrab ?? 1.15;
function project(x,y,z){
  const px=x-LD.foot[0], py=y-LD.foot[1], pz=z-LD.foot[2];
  const s=px*LD.up[0]+py*LD.up[1]+pz*LD.up[2];
  const q=[LD.foot[0]+LD.up[0]*s, LD.foot[1]+LD.up[1]*s, LD.foot[2]+LD.up[2]*s];
  return { s, d:Math.hypot(x-q[0],y-q[1],z-q[2]) };
}
function support(x,z,footY){
  let y=terrainHeight(x,z), kind='ground';
  if(Math.abs(x-bed.x)<=bed.rx && Math.abs(z-bed.z)<=bed.rz &&
     bed.top<=footY+Math.max(stepUp,climbUp) && bed.top>y){ y=bed.top; kind='bed'; }
  return { y, kind };
}

/* ---- 角色 ---- */
const speed=W.speed||4.0, climbSpeed=W.climbSpeed||2.3, gravity=W.gravity||18,
      jumpV=W.jumpSpeed||6.2, followK=W.ySmooth||11;
const P = { x:cfg.camera.position[0], z:cfg.camera.position[2], foot:terrainHeight(cfg.camera.position[0],cfg.camera.position[2]),
            vy:0, state:'ground', ls:0, lsq:0 };
function tryClimb(wx,wz){
  if(P.state!=='ground') return false;
  const info=project(P.x,P.foot,P.z);
  if(info.d<grab && info.s<LD.length-0.15){
    const h2=Math.hypot(LD.up[0],LD.up[2])||1;
    const toward=(wx*LD.up[0]+wz*LD.up[2])/h2;
    const nextS=(Math.floor(Math.max(info.s,0)/LD.step)+1)*LD.step;
    const nextY=LD.foot[1]+nextS*LD.up[1];
    if(toward>0.4 && nextY-P.foot<=LD.step*LD.up[1]+0.45){
      P.state='ladder'; P.ls=nextS; P.lsq=Math.max(info.s,0); return true;
    }
  }
  const ex=Math.max(Math.abs(P.x-bed.x)-bed.rx,0), ez=Math.max(Math.abs(P.z-bed.z)-bed.rz,0);
  if(Math.hypot(ex,ez)<0.8 && bed.top>P.foot+0.05 && bed.top-P.foot<2.4){
    const tx=bed.x-P.x, tz=bed.z-P.z, tl=Math.hypot(tx,tz)||1;
    if((wx*tx+wz*tz)/tl>0.4){ P.state='bed'; return true; }
  }
  return false;
}
function move(dt,wx,wz,jump,climbDir){
  if(P.state==='ladder'){
    P.ls=clamp(P.ls+(climbDir||0)*climbSpeed*dt,0,LD.length);
    const rr=Math.round(P.ls/LD.step)*LD.step;
    P.lsq+=(rr-P.lsq)*(1-Math.exp(-15*dt));
    P.x=LD.foot[0]+LD.up[0]*P.lsq+LD.off[0];
    P.z=LD.foot[2]+LD.up[2]*P.lsq+LD.off[1];
    P.foot=LD.foot[1]+LD.up[1]*P.lsq; P.vy=0;
    if(jump){ P.state='air'; P.vy=jumpV; P.x+=LD.off[0]*2.4; P.z+=LD.off[1]*2.4; }
    return;
  }
  if(P.state==='bed'){
    P.foot=Math.min(P.foot+climbSpeed*dt,bed.top);
    P.x+=wx*speed*0.3*dt; P.z+=wz*speed*0.3*dt;
    if(P.foot>=bed.top-0.004){ P.foot=bed.top; P.state='ground'; }
    if(jump){ P.state='air'; P.vy=jumpV; }
    return;
  }
  const prev=P.foot, mag=Math.hypot(wx,wz);
  if(mag>1e-3){
    const inv=Math.min(mag,1)/mag, dx=wx*inv*speed*dt, dz=wz*inv*speed*dt;
    if(P.state==='ground'){
      if(support(P.x+dx,P.z,P.foot).y-P.foot<=stepUp+0.02) P.x+=dx;
      if(support(P.x,P.z+dz,P.foot).y-P.foot<=stepUp+0.02) P.z+=dz;
    }else{ P.x+=dx*0.7; P.z+=dz*0.7; }
  }
  if(P.state==='ground'){
    const sup=support(P.x,P.z,P.foot);
    if(sup.y<P.foot-0.08){ P.state='air'; P.vy=0; }
    else P.foot+=(sup.y-P.foot)*(1-Math.exp(-followK*dt));
    if(jump){ P.state='air'; P.vy=jumpV; }
  }
  if(P.state==='air'){
    P.vy-=gravity*dt;
    const sup=support(P.x,P.z,prev);
    P.foot+=P.vy*dt;
    if(P.vy<=0 && P.foot<=sup.y && prev>=sup.y-0.02){ P.foot=sup.y; P.vy=0; P.state='ground'; wasAir=false; return true; }
  }
  return false;
}

/* ---- 跑一遍 route ---- */
const route = cfg.roam.route;
const run = { i:0, t:0 };
function done(st){
  if(st.go) return (P.state==='ladder'||P.state==='bed') || Math.hypot(st.go[0]-P.x,st.go[1]-P.z)<(st.tol||0.6);
  if(st.climbBed) return P.foot>=bed.top-0.03;
  if(st.climbLadder!==undefined) return P.state==='ladder' && P.ls>=st.climbLadder*LD.length-LD.step*0.6;
  if(st.wait!==undefined) return run.t>=st.wait;
  return true;
}
const dt=1/60, secs=Number(process.argv[2]||70);
let lastState=P.state, lastStep=-1;
console.log('\n=== 巡演时间线 ===');
for(let n=0;n*dt<secs;n++){
  const st=route[run.i%route.length];
  run.t+=dt;
  if(run.i!==lastStep){ console.log(`[t=${(n*dt).toFixed(1)}s] → step${run.i} ${JSON.stringify(st)}`); lastStep=run.i; }
  let wx=0,wz=0,jump=false,climbDir=0;
  if(st.go){
    const dx=st.go[0]-P.x, dz=st.go[1]-P.z, d=Math.hypot(dx,dz)||1;
    wx=dx/d; wz=dz/d; if(st.run){ wx*=st.run; wz*=st.run; }
    tryClimb(wx,wz);
  }else if(st.climbBed){
    const tx=bed.x-P.x, tz=bed.z-P.z, tl=Math.hypot(tx,tz)||1;
    wx=tx/tl; wz=tz/tl; tryClimb(wx,wz);
  }else if(st.climbLadder!==undefined){
    climbDir=1;
    if(P.state!=='ladder'){
      const h2=Math.hypot(LD.up[0],LD.up[2])||1;
      wx=LD.up[0]/h2; wz=LD.up[2]/h2; tryClimb(wx,wz);
    }
  }else if(st.jump) jump=true;
  const landed=move(dt,wx,wz,jump,climbDir);
  if(P.state!==lastState){
    console.log(`[t=${(n*dt).toFixed(1)}s]   state ${lastState} → ${P.state}  foot=${P.foot.toFixed(2)} pos=(${P.x.toFixed(1)},${P.z.toFixed(1)})`);
    lastState=P.state;
  }
  if(landed) console.log(`[t=${(n*dt).toFixed(1)}s]   落地 ✔ foot=${P.foot.toFixed(2)} pos=(${P.x.toFixed(1)},${P.z.toFixed(1)})`);
  if(done(st) || run.t>(st.max||18)){ run.i=(run.i+1)%route.length; run.t=0; lastStep=-1; }
}
console.log(`\n收尾：state=${P.state} foot=${P.foot.toFixed(2)} pos=(${P.x.toFixed(1)},${P.z.toFixed(1)}) step=${run.i}`);
