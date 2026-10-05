import fs from 'fs';
function glb(IN){
  const buf=fs.readFileSync(IN);
  const jsonLen=buf.readUInt32LE(12);
  const json=JSON.parse(buf.toString('utf8',20,20+jsonLen));
  const binHdrAt=20+jsonLen, binLen=buf.readUInt32LE(binHdrAt);
  const bin=buf.subarray(binHdrAt+8,binHdrAt+8+binLen);
  return {json,bin};
}
for(const IN of ['models/bed2.glb.json','models/bed2-.glb.json']){
  const {json,bin}=glb(IN);
  console.log('\n=== '+IN+' meshes='+json.meshes.length);
  for(const m of json.meshes){
    for(const p of m.primitives){
      const a=p.attributes; const acc=(i)=>json.accessors[i];
      const hasN = a.NORMAL!==undefined;
      const idxAcc = p.indices!==undefined?acc(p.indices):null;
      const nord = hasN ? ('NOR='+a.NORMAL) : 'NOR=none';
      const idx = p.indices!==undefined ? ('idx='+p.indices+' nIdx='+idxAcc.count) : 'idx=none';
      console.log('  prim mode='+p.mode+' POS='+a.POSITION+' '+nord+' COL='+a.COLOR_0+' '+idx+' mat='+p.material);
    }
  }
  const a0=json.accessors[0], bv=json.bufferViews[a0.bufferView];
  const base=(bv.byteOffset||0)+(a0.byteOffset||0), stride=bv.byteStride||12;
  let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
  for(let i=0;i<a0.count;i++){const o=base+i*stride;for(let c=0;c<3;c++){const v=bin.readFloatLE(o+c*4);if(v<mn[c])mn[c]=v;if(v>mx[c])mx[c]=v;}}
  console.log('  POS bbox min',mn.map(x=>x.toFixed(3)),'max',mx.map(x=>x.toFixed(3)));
}
