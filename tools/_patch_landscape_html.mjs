/* 2026-10-08「画面要设置为横版」
 * ① index.html 补 per-kernel 横屏 meta（UC / QQ / X5 / iOS 各认不同那几个）
 * ② 加竖屏门 DOM（默认隐藏，只在「已旋转且用户没确认」时显示）
 *
 * ⚠ index.html 是 LF 行尾，别被 CRLF 规范化掉（skill 的坑：EOL 是逐文件的）。
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const f = 'index.html';
let src = readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const subs = [
{ name: 'per-kernel 横屏 meta', n:1,
  from:`  <title>云端之梯 · #梦核 · Ladder to the Cloud</title>`,
  to:`  <!-- 强制横屏用的 per-kernel meta（2026-10-08）。每个内核只认自己那几个：
         screen-orientation = UC/QQ，x5-orientation = 微信/QQ X5，
         full-screen / x5-fullscreen 是 X5 锁定前的必要条件（它要先全屏才肯锁），
         后两个是「加到主屏后按独立应用运行」。真正的锁定在 main.js 里做，
         这些 meta 只是给内核一个意向；iOS Safari 不认它们，靠 CSS 旋转兜底。 -->
  <meta name="screen-orientation" content="landscape">
  <meta name="x5-orientation" content="landscape">
  <meta name="full-screen" content="yes">
  <meta name="x5-fullscreen" content="true">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">

  <title>云端之梯 · #梦核 · Ladder to the Cloud</title>` },

{ name: '竖屏门 DOM', n:1,
  from:`  <!-- ?v= 用于绕过浏览器旧缓存 -->
  <script type="module" src="main.js?v=76"></script>`,
  to:`  <!-- 竖屏门（2026-10-08）：只在「舞台已被 CSS 旋转过」且用户还没点「好」时显示。
       两个出口是必须的：设备锁了方向旋转时，门会变成死路；而且页面自己的 90° 旋转
       会抵消用户的物理旋转 —— 侧着拿手机恰好是画面看起来是正的姿势，
       但 innerWidth/innerHeight 与 screen.orientation 都不会变，
       **任何 orientation 事件都测不出来**，只能让用户自己确认。
       所以主按钮必须**保留旋转**（绝不能在那儿调反向旋转函数）。 -->
  <div id="rotateGate">
    <div>
      <div class="rg-ico">📱↻</div>
      <div class="rg-t">请横过来玩</div>
      <div class="rg-d">把手机横过来 —— 这个场景是横向构图，竖屏会又窄又挤。</div>
      <button id="rotateOk" type="button">好 · 开始</button>
      <button id="rotateSkip" class="rg-skip" type="button">仍要竖屏继续</button>
    </div>
  </div>

  <!-- ?v= 用于绕过浏览器旧缓存 -->
  <script type="module" src="main.js?v=76"></script>` },
];

let ok = true;
for (const s of subs){ const c = src.split(s.from).length - 1;
  if (c !== s.n){ ok = false; console.error(`[FAIL] ${s.name} 命中 ${c}（期望 ${s.n}）`); } else console.log(`[ok]   ${s.name}`); }
if (!ok){ console.error('锚点没全中，一个字都没写'); process.exit(1); }
for (const s of subs) src = src.replace(s.from, s.to);
writeFileSync(join(ROOT, f), src, 'utf8');       // 保持 LF
console.log('[DONE] index.html (LF preserved)');
