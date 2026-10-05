import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import { spawn } from 'node:child_process';
const ROOT=path.resolve('dist-minitool'),PORT=8738,CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.xml':'application/octet-stream','.mp3':'audio/mpeg','.glb':'model/gltf-binary'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';fs.readFile(path.join(ROOT,p),(e,b)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(b);});});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await new Promise(r=>server.listen(PORT,r));
const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--window-size=1280,800','--remote-debugging-port=9224','about:blank'],{stdio:'ignore'});
await wait(1500);
const list=await fetch('http://127.0.0.1:9224/json/list').then(r=>r.json());
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
  const THREE=window.__dbg.THREE,b=window.__dbg.bed,cam=window.__dbg.camera,renderer=window.__dbg.renderer,scene=window.__dbg.scene;
  const box=new THREE.Box3().setFromObject(b);const c=box.getCenter(new THREE.Vector3());
  const v=c.clone().project(cam);
  const w=renderer.domElement.width,h=renderer.domElement.height;
  const sx=Math.round((v.x*0.5+0.5)*w), sy=Math.round((-v.y*0.5+0.5)*h);
  renderer.render(scene,cam);
  const gl=renderer.getContext();
  const S=120;const px=new Uint8Array(S*S*4);
  const glY=h-(sy+S/2);
  gl.readPixels(Math.max(0,sx-S/2),Math.max(0,glY),S,S,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let rs=0,gs=0,bs=0,n=0,mn=999,mx=0;
  for(let i=0;i<px.length;i+=4){const lum=(px[i]+px[i+1]+px[i+2])/3;rs+=px[i];gs+=px[i+1];bs+=px[i+2];n++;if(lum<mn)mn=lum;if(lum>mx)mx=lum;}
  return {w,h,sx,sy,rgb:[(rs/n)|0,(gs/n)|0,(bs/n)|0],avgLum:((rs+gs+bs)/n/3)|0,minLum:mn|0,maxLum:mx|0};
})()`;
const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true});
console.log('BED PIXELS:',JSON.stringify(r.result.result.value));
ws.close();try{chrome.kill('SIGKILL');}catch{}server.close();process.exit(0);
