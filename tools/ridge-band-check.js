// 环山山脊线验证：仰角分布 + 一圈 ASCII 轮廓
const fs=require('fs');
const cfg=JSON.parse(fs.readFileSync('scene.json','utf8'));
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const ss=(x,a,b)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
function hash2(x,y){const n=Math.sin(x*127.1+y*311.7)*43758.5453123;return n-Math.floor(n);}
function noise2(x,y){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy);
  const a=hash2(ix,iy),b=hash2(ix+1,iy),c=hash2(ix,iy+1),d=hash2(ix+1,iy+1);
  return a*(1-ux)*(1-uy)+b*ux*(1-uy)+c*(1-ux)*uy+d*ux*uy;}
function fbm2(x,y){return noise2(x,y)*0.55+noise2(x*2.1,y*2.1)*0.25+noise2(x*4.3,y*4.3)*0.12+noise2(x*8.9,y*8.9)*0.08;}
const camY=cfg.camera.position[1], camX=cfg.camera.position[0], camZ=cfg.camera.position[2];

cfg.sky.ridgeBands.forEach((B,bi)=>{
  const seg=720, k=B.noiseRadius, seed=B.seed;
  const angs=[];
  for(let i=0;i<seg;i++){
    const th=i/seg*Math.PI*2;
    const cx=Math.cos(th)*k+seed, cy=Math.sin(th)*k+seed*1.7;
    let n=fbm2(cx,cy)*0.68+fbm2(cx*3.1+5.5,cy*3.1+9.9)*0.32;
    n=clamp((n-0.5)*B.gain+0.5,0,1);
    n=1-Math.pow(1-n,B.sharp);
    const top=B.y+B.height*(B.base+(1-B.base)*n);
    const x=Math.cos(th)*B.radius, z=Math.sin(th)*B.radius;
    const d=Math.hypot(x-camX,z-camZ);
    angs.push(Math.atan2(top-camY,d)*180/Math.PI);
  }
  const s=angs.slice().sort((a,b)=>a-b);
  const q=p=>s[Math.floor(p*(s.length-1))].toFixed(2);
  const avg=angs.reduce((a,b)=>a+b,0)/angs.length;
  const sd=Math.sqrt(angs.reduce((a,b)=>a+(b-avg)**2,0)/angs.length);
  console.log(`band${bi} R=${B.radius}  仰角 p05=${q(0.05)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} p95=${q(0.95)}  min=${q(0)} max=${q(1)} 均值=${avg.toFixed(2)} 标准差=${sd.toFixed(2)}`);
  // ASCII 轮廓（方位 0→360，每 6° 一列）
  const rows=14, cols=[];
  for(let a=0;a<360;a+=6){
    const th=a*Math.PI/180;
    const cx=Math.cos(th)*k+seed, cy=Math.sin(th)*k+seed*1.7;
    let n=fbm2(cx,cy)*0.68+fbm2(cx*3.1+5.5,cy*3.1+9.9)*0.32;
    n=clamp((n-0.5)*B.gain+0.5,0,1); n=1-Math.pow(1-n,B.sharp);
    const top=B.y+B.height*(B.base+(1-B.base)*n);
    const x=Math.cos(th)*B.radius, z=Math.sin(th)*B.radius;
    cols.push(Math.atan2(top-camY,Math.hypot(x-camX,z-camZ))*180/Math.PI);
  }
  for(let r=rows;r>=1;r--){
    let line='';
    for(const v of cols) line += (v>=r)?'#':(v>=r-1?'+':(v>=r-1.7?'.':' '));
    console.log(String(r).padStart(2)+'° |'+line);
  }
  console.log('    +'+'-'.repeat(cols.length)+'   (每列 6°，120 列里只画了 60 列)');
});
