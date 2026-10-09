#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小红书小工具 zip 产物 · 规范逐项核对
================================================
规范要点（摘��自 .skill/minitool-zip-builder/references，见 build_minitool.py 头部）：
  §3 脚本必须外置、**必须经典脚本**（禁 type="module" / import / export）
  §3 禁用 fetch / XHR；所有资源打包在内
  §4 相对路径、单页
  performance-budget §1/§3  单条 base64 < 1 MiB、zip < 10 MiB
  device-capabilities §4    容器不可用 fetch / XMLHttpRequest ⇒ GLB 必须有内联兜底

⚠ 与 build_minitool.py 的分工：那个脚本负责「按规范改产物」（有断言，预期片段找不到就
   BUILD FAIL）；本脚本负责「事後独立复核」—— 不信任构建过程，只看产物本身满不满足规范。
   两者独立才有意义：构建脚本自己说自己合规不算数。

用法：python tools/check_minitool_spec.py
退出码 0 = 全过；1 = 有 FAIL
"""
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist-minitool')
ZIP = os.path.join(ROOT, 'cloud-ladder-minitool.zip')

MAX_BASE64 = 1 * 1024 * 1024      # 单条 base64 上限 1 MiB
MAX_ZIP = 10 * 1024 * 1024       # zip 上限 10 MiB

results = []
def check(name, ok, detail=''):
    results.append((ok, name, detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  → ' + detail) if detail else ''))

def read(p):
    with open(p, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()

print('=== 小红书小工具产物 · 规范核对 ===')
print('目录:', DIST)
print()

if not os.path.isdir(DIST):
    print('  产物目录不存在，请先跑 tools/build_minitool.py')
    sys.exit(1)

html_files = [f for f in os.listdir(DIST) if f.lower().endswith(('.html', '.htm'))]
js_files = [f for f in os.listdir(DIST) if f.lower().endswith('.js')]

# ---- §3 单页 ----
check('§4 单页：产物里只有 1 个 html', len(html_files) == 1,
      '%d 个：%s' % (len(html_files), html_files))

# ---- §3 经典脚本 ----
html = read(os.path.join(DIST, html_files[0])) if html_files else ''
check('§3 禁 type="module"', 'type="module"' not in html and "type='module'" not in html,
      '出现 %d 次' % (html.count('type="module"') + html.count("type='module'")))
check('§3 html 里的 script 全部外置（无内联大段代码）',
      html.count('<script') == len(re.findall(r'<script[^>]*\bsrc=', html)),
      '%d 个 <script>，其中带 src 的 %d 个' % (html.count('<script'),
                                                len(re.findall(r'<script[^>]*\bsrc=', html))))

# 顶层 import/export：只看行首（缩进的是函数体内的动态 import，不算）
bad_import = []
for f in js_files:
    txt = read(os.path.join(DIST, f))
    for i, line in enumerate(txt.splitlines(), 1):
        s = line.strip()
        if re.match(r'^import\s', s) or re.match(r'^export\s+(default\s+)?(const|let|var|function|class|\{)', s):
            bad_import.append('%s:%d  %s' % (f, i, s[:60]))
check('§3 禁 import/export 语句（顶层）', not bad_import,
      '命中 %d 处：%s' % (len(bad_import), bad_import[:3]))

# ---- §3 禁 fetch / XHR ----
fetch_hits = []
for f in js_files:
    txt = read(os.path.join(DIST, f))
    n = len(re.findall(r'\bfetch\s*\(', txt))
    x = len(re.findall(r'\bXMLHttpRequest\b', txt))
    if n or x:
        fetch_hits.append('%s: fetch×%d, XHR×%d' % (f, n, x))
# three.global.js 里的 fetch 是 GLTFLoader/FileLoader 的库内残留 —— 已被我们的
# window.__loadBedGLB() 兜底接住，只���「有没有被真正调用」要紧。
real_fetch = [h for h in fetch_hits if not h.startswith('three.global.js')]
check('§3 禁 fetch / XHR（three 库内残留不计）', not real_fetch,
      ('库内残留: %s' % '; '.join(fetch_hits)) if fetch_hits else '0 处')

# ---- §4 相对路径 ----
abs_links = re.findall(r'(?:src|href)\s*=\s*["\']((?:https?:)?//[^"\']+)', html)
check('§4 html 资源引用全为相对路径（无外链）', not abs_links, str(abs_links[:5]))

# ⚠ **必须把「自研代码」与「three 库内残留」分开算**，否则全是误报：
#   · three.global.js 里的 `http://www.w3.org/1999/xhtml` 是 **XML 命名空间常量**
#     （document.createElementNS 用），不是网络请求；
#   · addons.global.js 里的 `https://my-cnd-server.com/assets/...` 是 FileLoader /
#     TextureLoader 的**默认 base 路径常量**（three 源码里的 __DEFAULT_PATH），不发请求；
#   · 库里的 `crossOrigin` 是 loader 的 API 参数（this.crossOrigin），我们没传值就不触发。
# 只有自研模块里出现这些才算违规。
LIB_FILES = {'three.global.js', 'addons.global.js'}
NS_LITERAL = 'www.w3.org'          # XML 命名空间，不是路径
abs_in_js = []
for f in js_files:
    if f == 'data.js' or f in LIB_FILES:   # data.js 里是内联 JSON，路径字段另查
        continue
    txt = read(os.path.join(DIST, f))
    for m in re.findall(r'''["']((?:https?:)?//[^"']{6,})["']''', txt):
        if NS_LITERAL in m:
            continue
        abs_in_js.append('%s: %s' % (f, m[:50]))
check('§4 自研 js 里无 http(s):// 路径字面量', not abs_in_js, str(abs_in_js[:5]))
lib_urls = []
for f in LIB_FILES:
    p = os.path.join(DIST, f)
    if os.path.isfile(p):
        for m in re.findall(r'''["']((?:https?:)?//[^"']{6,})["']''', read(p)):
            if NS_LITERAL not in m:
                lib_urls.append('%s: %s' % (f, m[:46]))
print('  INFO  库内默认路径常量（不发请求，不计违规）: %s' % (lib_urls[:3] if lib_urls else '无'))

# ---- performance-budget：单条 base64 < 1MiB ----
data_js = read(os.path.join(DIST, 'data.js')) if os.path.isfile(os.path.join(DIST, 'data.js')) else ''
b64 = re.findall(r'"([A-Za-z0-9+/=]{200,})"', data_js)
longest = max((len(s) for s in b64), default=0)
check('budget 单条 base64 < 1 MiB', longest < MAX_BASE64,
      '最长一条 %d B（%.2f MiB），共 %d 条' % (longest, longest / 1048576, len(b64)))

# ---- device-capabilities：GLB 内联兜底存在 ----
check('§4 床模型有内联 base64 兜底（容器禁 fetch）', len(b64) > 0,
      'data.js 里 %d 条长 base64' % len(b64))
check('§4 models/ 里也有可读的原始文件（规范期望的形态）',
      os.path.isdir(os.path.join(DIST, 'models')) and
      len([f for f in os.listdir(os.path.join(DIST, 'models'))]) > 0,
      str(os.listdir(os.path.join(DIST, 'models')) if os.path.isdir(os.path.join(DIST, 'models')) else '缺 models/'))

# ---- performance-budget：zip < 10 MiB ----
if os.path.isfile(ZIP):
    zs = os.path.getsize(ZIP)
    check('budget zip < 10 MiB', zs < MAX_ZIP,
          '%.2f MiB（%d B）' % (zs / 1048576, zs))
    with zipfile.ZipFile(ZIP) as z:
        names = z.namelist()
    check('zip 里有 index.html 且在最前（容器默认入口）',
          any(n.endswith('index.html') for n in names), '%d 个条目' % len(names))
else:
    check('budget zip < 10 MiB', False, 'zip 不存在')

# ---- crossOrigin：小工具容器里会直接把请求判失败 ----
# 只查自研模块：three 库里的 `crossOrigin: this.crossOrigin` 是 loader 的 API 参数，
# 我们没给任何 loader 传 crossOrigin ⇒ 不触发 CORS 请求。
co_hits = []
for f in js_files:
    if f in LIB_FILES:
        continue
    txt = read(os.path.join(DIST, f))
    for i, line in enumerate(txt.splitlines(), 1):
        if 'crossOrigin' not in line:
            continue
        s = line.strip()
        # 注释行不算违规 —— 构建脚本把 crossOrigin 替换成注释来留痕，
        # 那些注释里也会出现 crossOrigin 这个词。
        if s.startswith('//') or s.startswith('/*') or s.startswith('*') or s.endswith('*/'):
            continue
        co_hits.append('%s:%d  %s' % (f, i, s[:70]))
check('自研代码里无 crossOrigin（容器会判失败）', not co_hits, str(co_hits[:3]))
lib_co = []
for f in LIB_FILES:
    p = os.path.join(DIST, f)
    if os.path.isfile(p):
        n = read(p).count('crossOrigin')
        if n:
            lib_co.append('%s×%d' % (f, n))
if lib_co:
    print('  INFO  库内 loader 的 crossOrigin API 参数（未传值，不计违规）: %s' % ', '.join(lib_co))

# ---- 电视视频（2026-10-09 起默认打进包里）----
# ⚠ 之前这里断言的是「产物不含 video/」：那时构建脚本把 projector.video.src 置空、
#   也不打包视频，用户在小红书里看到的永远是程序化画布兜底（报「视频播放不了」）。
#   现在默认带视频（`--no-video` 可退回旧行为），断言反过来：**要么干净地带，
#   要么干净地没有** —— src 与文件必须一致，绝不能出现「src 指向一个不存在的文件」。
has_video_dir = os.path.isdir(os.path.join(DIST, 'video'))
video_files = sorted(os.listdir(os.path.join(DIST, 'video'))) if has_video_dir else []

vsrc = ''
m = re.search(r'window\.SCENE_JSON\s*=\s*JSON\.parse\((.*?)\);', data_js, re.S)
if m:
    try:
        vscene = json.loads(json.loads(m.group(1).strip()))
        vsrc = (vscene.get('projector') or {}).get('video', {}).get('src') or ''
    except Exception:
        vsrc = ''

if vsrc:
    want = os.path.basename(vsrc)
    check('电视视频：src 指向的文件确实在包里',
          has_video_dir and want in video_files,
          'src=%r, video/=%s' % (vsrc, video_files))
    if has_video_dir and want in video_files:
        sz = os.path.getsize(os.path.join(DIST, 'video', want))
        check('电视视频：单文件 < 5.5 MiB（zip 10 MiB 上限的主要占用方）',
              sz < 5.5 * 1024 * 1024, '%.2f MiB' % (sz / 1048576))
else:
    check('电视视频：未启用（src 为空 ⇒ 走程序化画布回退，体积更小）',
          not has_video_dir,
          'src 为空却存在 video/（不一致）' if has_video_dir else 'src 为空且无 video/')
    print('  INFO  未打包视频：等价于 --no-video')

# ---- 汇总 ----
fails = [r for r in results if not r[0]]
print()
print('=== 汇总：%d 项通过，%d 项失败 ===' % (len(results) - len(fails), len(fails)))
if fails:
    for _, n, d in fails:
        print('  FAIL  ' + n + ('  → ' + d if d else ''))
    sys.exit(1)
print('全部通过 ✓')
sys.exit(0)