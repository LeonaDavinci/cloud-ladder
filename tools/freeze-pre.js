/* 预注入脚本（PRE_SCRIPT）：让截图变成「可逐像素复现」的。
   1) 固定 Math.random 种子 —— 草/云/蝴蝶的位置与颜色都是随机的，
      不固定种子，两次刷新就是两套布局，任何像素对照都不成立。
   2) 冻结时钟 —— performance.now() 恒返回 0 ⇒ THREE.Clock 的 dt=0、
      elapsed=0，云不飘、蝴蝶不飞、草不摆。这样才能把「隐藏了哪一层山」
      的差异从「动画相位差异」里分离出来。 */
(function () {
  var a = 0x9e3779b9;
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  var _now = performance.now.bind(performance);
  performance.now = function () { return 0; };
  window.__frozenNow = _now;
})();
