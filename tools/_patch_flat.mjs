import fs from 'fs';

const COLOR = '#f4eee2';
const files = ['dist-minitool/data.js', 'cloud-ladder-minitool/data.js'];
const re = /window\.SCENE_JSON = JSON\.parse\(("(?:[^"\\]|\\.)*")\)/;

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  const mm = s.match(re);
  if (!mm) { console.log('NO MATCH', f); continue; }
  const obj = JSON.parse(JSON.parse(mm[1]));
  obj.bed.model.flatColor = COLOR;
  const newInner = JSON.stringify(obj);
  const newLiteral = '"' + newInner.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  s = s.slice(0, mm.index) + 'window.SCENE_JSON = JSON.parse(' + newLiteral + ')' + s.slice(mm.index + mm[0].length);
  fs.writeFileSync(f, s);
  console.log('patched', f, '->', JSON.stringify(obj.bed.model));
}
