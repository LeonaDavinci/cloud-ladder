import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import { spawn } from 'node:child_process';
const ROOT=path.resolve('dist-minitool'),PORT=8739,CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.xml':'application/octet-stream','.mp3':'audio/mpeg','.glb':'model/gltf-binary'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';fs.readFile(path.join(ROOT,p),(e,b)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(b);});});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await new Promise(r=>server.listen(PORT,r));
const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--window-size=1280,800','--remote-debugging-port=9225','about:blank'],{stdio:'ignore'});
await wait(1500);
const list=await fetch('http://127.0.0.1:9225/json/list').then(r=>r.json());
const pt=list.find(t=>t.type==='page');
const ws=new WebSocket(pt.webSocketDebuggerUrl);
let id=0;const pend=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});
for(let i=0;i<60;i++){await wait(500);const r=await send('Runtime.evaluate',{expression:'!!(window.__dbg&&window.__dbg.bed&&window.__dbg.bed.userData.bedModel)',returnByValue:true});if(r.result&&r.result.result&&r.result.result.value)break;}
await wait(800);
const expr=`(function(){
  const THREE=window.__dbg.THREE,b=window.__dbg.bed,cam=window.__dbg.camera,renderer=window.__dbg.renderer,scene=window.__dbg.scene,ctr=window.__dbg.controls;
  const box=new THREE.Box3().setFromObject(b);const c=box.getCenter(new THREE.Vector3());const sz=box.getSize(new THREE.Vector3());
  cam.position.set(c.x+sz.x*1.1+1.5, c.y+sz.y*0.9+1.2, c.z+sz.z*1.3+2.5);
  ctr.target.copy(c); ctr.update(); cam.updateProjectionMatrix();
  renderer.render(scene,cam);
  const v=c.clone().project(cam);
  const w=renderer.domElement.width,h=renderer.domElement.height;
  const sx=Math.round((v.x*0.5+0.5)*w), sy=Math.round((-v.y*0.5+0.5)*h);
  const gl=renderer.getContext();
  function sample(S,cx,cy){
    const px=new Uint8Array(S*S*4);
    gl.readPixels(Math.max(0,cx-S/2),Math.max(0,h-(cy+S/2)),S,S,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let rs=0,gs=0,bs=0,n=0;const lums=[];
    for(let i=0;i<px.length;i+=4){rs+=px[i];gs+=px[i+1];bs+=px[i+2];lums.push((px[i]+px[i+1]+px[i+2])/3);n++;}
    lums.sort((a,b)=>a-b);
    return {rgb:[(rs/n)|0,(gs/n)|0,(bs/n)|0],median:lums[n>>1]|0,p10:lums[(n*0.1)|0]|0,p90:lums[(n*0.9)|0]|0};
  }
  return {screen:[sx,sy,w,h],center:sample(200,sx,sy),up:sample(120,sx,Math.max(0,sy-120)),down:sample(120,sx,Math.min(h-1,sy+120))};
})()`;
const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true});
console.log('BED CLOSE PIXELS:',JSON.stringify(r.result.result.value));
ws.close();try{chrome.kill('SIGKILL');}catch{}server.close();process.exit(0);
