import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('dist-minitool');
const PORT = 8736;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.mp3':'audio/mpeg',
  '.glb':'model/gltf-binary','.xml':'application/octet-stream','.ico':'image/x-icon'
};
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]);
  if(p==='/') p='/index.html';
  const fp = path.join(ROOT,p);
  fs.readFile(fp,(e,buf)=>{
    if(e){res.writeHead(404);res.end('nf');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(buf);
  });
});
function wait(ms){return new Promise(r=>setTimeout(r,ms));}

async function main(){
  await new Promise(r=>server.listen(PORT,r));
  console.log('server up', PORT);

  const chrome = spawn(CHROME, [
    '--headless=new','--no-sandbox','--disable-dev-shm-usage',
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--hide-scrollbars','--window-size=1280,800',
    '--remote-debugging-port=9222','about:blank'
  ], {stdio:'ignore'});
  await wait(1500);

  const ver = await fetch('http://127.0.0.1:9222/json/version').then(r=>r.json());
  const list = await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json());
  const pageTarget = list.find(t=>t.type==='page' && t.url!=='about:blank') || list.find(t=>t.type==='page');
  console.log('page target:', pageTarget.url, pageTarget.webSocketDebuggerUrl);
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let id=0; const pending=new Map();
  const send=(method,params={})=>new Promise((res)=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
  ws.addEventListener('message',(ev)=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));

  ws.addEventListener('message',(ev)=>{const m=JSON.parse(ev.data);
    if(m.method==='Runtime.consoleAPICalled'){const t=m.params.args.map(a=>a.value??a.description??a.type).join(' ');console.log('[console]',t);}
    if(m.method==='Runtime.exceptionThrown'){console.log('[exception]',JSON.stringify(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text));}
    if(m.method==='Network.loadingFailed'){console.log('[netfail]',m.params.type,m.params.errorText, m.params.requestId);}
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/`});

  let ready=false;
  for(let i=0;i<60;i++){
    await wait(500);
    const r=await send('Runtime.evaluate',{expression:'({dbg:!!(window.__dbg&&window.__dbg.bed), app:!!window.__APP, state:document.readyState, href:location.href})',returnByValue:true});
    if(i===2||i===12||i===32) console.log('RAW',i,JSON.stringify(r.result));
    const v=r.result&&r.result.result&&r.result.result.value;
    if(v&&v.dbg){ready=true; console.log('ready at',i*0.5,'s', JSON.stringify(v)); break;}
  }
  console.log('__dbg ready:',ready);

  // wait for the GLB bed model to finish loading + applying flat material
  let bedLoaded=false;
  for(let i=0;i<60;i++){
    await wait(500);
    const r=await send('Runtime.evaluate',{expression:'(function(){const b=window.__dbg.bed;if(!b||!b.userData)return {ok:false};const bm=b.userData.bedModel;let off=0,total=0;const THREE=window.__dbg.THREE;b.traverse(o=>{if(o.isMesh&&o.visible){total++;if(o.material&&o.material.color&&Math.abs(o.material.color.r*255-244)<10&&Math.abs(o.material.color.g*255-238)<10&&Math.abs(o.material.color.b*255-226)<10)off++;}});return {ok:!!bm, off, total};})()',returnByValue:true});
    const v=r.result&&r.result.result&&r.result.result.value;
    if(v&&v.ok){bedLoaded=true; console.log('bed model loaded at',(i*0.5).toFixed(1),'s ->', JSON.stringify(v)); break;}
    if(i===10||i===30) console.log('bed-wait',i,JSON.stringify(v));
  }
  console.log('bed model loaded:',bedLoaded);
  await wait(1500);
  if(ready){
    const expr = `(function(){
      const b=window.__dbg.bed, THREE=window.__dbg.THREE;
      let total=0, offwhite=0, samples=[];
      const tgt=new THREE.Vector3();
      b.traverse(o=>{ if(o.isMesh && o.visible){ total++;
        const m=o.material; if(m&&m.color){
          const r=Math.round(m.color.r*255),g=Math.round(m.color.g*255),bl=Math.round(m.color.b*255);
          if(Math.abs(r-244)<10&&Math.abs(g-238)<10&&Math.abs(bl-226)<10) offwhite++;
          if(samples.length<4) samples.push(r+','+g+','+bl);
        }
      }});
      const box=new THREE.Box3().setFromObject(b); box.getCenter(tgt);
      const sz=box.getSize(new THREE.Vector3());
      const cam=window.__dbg.camera, ctr=window.__dbg.controls;
      cam.position.set(tgt.x+sz.x*1.3+2, tgt.y+sz.y*1.1+1.5, tgt.z+sz.z*1.6+3);
      ctr.target.copy(tgt); ctr.update(); cam.updateProjectionMatrix();
      return {total, offwhite, samples, center:[+tgt.x.toFixed(2),+tgt.y.toFixed(2),+tgt.z.toFixed(2)]};
    })()`;
    const chk = await send('Runtime.evaluate',{expression:expr,returnByValue:true});
    console.log('BED CHECK:', JSON.stringify(chk.result&&chk.result.result&&chk.result.result.value));
    await wait(1200);
    const shot = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(shot.result){
      const out=path.resolve('shots/verify-bed-flat.png');
      fs.mkdirSync(path.dirname(out),{recursive:true});
      fs.writeFileSync(out,Buffer.from(shot.result.data,'base64'));
      console.log('screenshot ->',out);
    } else console.log('no screenshot', JSON.stringify(shot));
  }
  ws.close(); try{chrome.kill('SIGKILL');}catch{} server.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
