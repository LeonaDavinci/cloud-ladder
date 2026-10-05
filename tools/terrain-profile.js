// 远山天际线分析：复现 main.js 的 terrainHeight
const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('scene.json','utf8'));
const T=cfg.terrain, MOUND=T.mound, RANGES=T.ranges, MICRO=T.micro, BROAD=T.broad;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const ss=(x,a,b)=>{ if(a===b) return x<a?0:1; const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
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
  if(BROAD){ h+=ss(d,BROAD.start,BROAD.full)*BROAD.amp*fbm2(x*BROAD.freq+3.7,z*BROAD.freq); }
  if(MOUND){
    const t=clamp((d-MOUND.innerRadius)/(MOUND.outerRadius-MOUND.innerRadius),0,1);
    const s=Math.pow(t,MOUND.power);
    const valley=MOUND.top-MOUND.drop*s;
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
      if(G.freq2&&G.mix2){ r=r*(1-G.mix2)+ridged(x+313.7,z-217.3,G.octaves2||3,G.freq2)*G.mix2; }
      let env=1;
      if(G.sectorAmp){ const a=Math.atan2(z,x), k=G.sectorFreq||1.1;
        let e=fbm2(Math.cos(a)*k,Math.sin(a)*k)*0.7+fbm2(Math.cos(a)*k*2.6+11.3,Math.sin(a)*k*2.6+4.9)*0.3;
        e=clamp((e-0.5)*(G.sectorGain||1)+0.5,0,1);
        env=(1-G.sectorAmp)+G.sectorAmp*2*e; }
      const far=1+(G.farGain||0)*ss(d,G.full,G.farFull||2000);
      h+=mr*G.height*env*far*(G.base+(1-G.base)*r);
    }
    if(G.rimMin){ const rw=ss(d,G.rimStart||1700,G.rimFull||1980);
      if(rw>0){ const fh=rw*G.rimMin*(0.6+0.8*fbm2(x*0.0025+71.3,z*0.0025+9.1)); if(h<fh) h=fh; } }
  }
  return h;
}
const camY=cfg.camera.position[1];
// 1) 沿 -Z 方向（正前方）的高度剖面
console.log('=== 沿 -Z 剖面 (x=0, z = -200..-1900) ===');
for(let zd=-200; zd>=-1900; zd-=100){
  const h=terrainHeight(0,zd);
  const ang=Math.atan2(h-camY, Math.abs(zd-30))*180/Math.PI;
  console.log(`z=${String(zd).padStart(6)}  h=${h.toFixed(1).padStart(7)}  仰角=${ang.toFixed(2)}°`);
}
// 2) 天际线：各方位角的最大仰角（模拟"看一圈"）
console.log('\n=== 天际线仰角（每个方位角取 200..1900 的最大仰角）===');
const sky=[];
for(let a=0;a<360;a+=10){
  const th=a*Math.PI/180; let best=-99, bestD=0;
  for(let d=200; d<=1900; d+=12){
    const x=Math.cos(th)*d, z=Math.sin(th)*d;
    const h=terrainHeight(x,z);
    const hd=Math.hypot(x-cfg.camera.position[0], z-cfg.camera.position[2]);
    const ang=Math.atan2(h-camY, hd)*180/Math.PI;
    if(ang>best){ best=ang; bestD=d; }
  }
  sky.push(best);
  console.log(`方位 ${String(a).padStart(3)}°  天际仰角 ${best.toFixed(2).padStart(6)}°  @d=${bestD}`);
}
const mn=Math.min(...sky), mx=Math.max(...sky);
const avg=sky.reduce((a,b)=>a+b,0)/sky.length;
const sd=Math.sqrt(sky.reduce((a,b)=>a+(b-avg)**2,0)/sky.length);
console.log(`\n天际线: min=${mn.toFixed(2)}° max=${mx.toFixed(2)}° 极差=${(mx-mn).toFixed(2)}° 均值=${avg.toFixed(2)}° 标准差=${sd.toFixed(2)}°`);
// 2b) 细采样 + ASCII 天际线图（看清峰谷形状）
console.log('\n=== 天际线 ASCII 图（方位 0→360°，每 3° 一列，纵轴仰角 0..14°）===');
const rows=14, cols=[];
for(let a=0;a<360;a+=3){
  const th=a*Math.PI/180; let best=-99;
  for(let d=200; d<=1980; d+=10){
    const x=Math.cos(th)*d, z=Math.sin(th)*d;
    const hd=Math.hypot(x-cfg.camera.position[0], z-cfg.camera.position[2]);
    const ang=Math.atan2(terrainHeight(x,z)-camY, hd)*180/Math.PI;
    if(ang>best) best=ang;
  }
  cols.push(best);
}
for(let r=rows;r>=1;r--){
  const lo=(r-1), hi=r;
  let line='';
  for(const v of cols) line += (v>=hi)?'#':(v>=lo?'+':(v>=lo-0.5?'.':' '));
  console.log(String(hi).padStart(2)+'° |'+line);
}
console.log('    +'+'-'.repeat(cols.length));
console.log('     0°  各列间隔 3°，共 120 列 → 360°');
const c2=cols.slice().sort((a,b)=>a-b);
console.log(`细采样: min=${c2[0].toFixed(2)} max=${c2[c2.length-1].toFixed(2)} p25=${c2[Math.floor(cols.length*0.25)].toFixed(2)} p50=${c2[Math.floor(cols.length*0.5)].toFixed(2)} p75=${c2[Math.floor(cols.length*0.75)].toFixed(2)}`);
// 3) 远山带（d=600..1500）内高度分布
console.log('\n=== 远山带 d=600..1500 高度分布（采样 4000 点）===');
const hs=[];
for(let i=0;i<4000;i++){
  const th=Math.random()*Math.PI*2, d=600+Math.random()*900;
  hs.push(terrainHeight(Math.cos(th)*d, Math.sin(th)*d));
}
hs.sort((a,b)=>a-b);
const q=p=>hs[Math.floor(p*(hs.length-1))].toFixed(1);
console.log(`p05=${q(0.05)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} p95=${q(0.95)}  max=${hs[hs.length-1].toFixed(1)} 极差=${(hs[hs.length-1]-hs[0]).toFixed(1)}`);
