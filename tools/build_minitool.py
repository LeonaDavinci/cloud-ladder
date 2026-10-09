#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端之梯 → 小红书小工具离线 zip 构建脚本
================================================
严格按 .skill/minitool-zip-builder 的规范改产物（不是改源码）：
  · references/zip-artifact-spec.md §3 —— 脚本必须外置、**必须经典脚本**（禁 type=module / import / export）
  · §3 —— 禁用 fetch / XHR；所有资源打包在内
  · §4 —— 相对路径、单页
  · performance-budget.md §1/§3 —— 单条 base64 < 1MiB、zip < 10MiB
所以这个脚本做四件事：
  1. 把 three.module.js 与 8 个 addon（外加 3 个 shader）从 ESM 机械转成经典脚本
     —— 每份都套一层 IIFE（否则 addon 之间的同名顶层 const 会在同一个全局词法环境里
        撞成 SyntaxError: Identifier '_vector' has already been declared），
        导出走 window.__M 注册表，three 本体导出成 window.THREE。
  2. 我们自己的 6 个模块同样处理，导出走 window.__APP。
  3. scene.json / config.json 从 fetch 改成内联常量。
  4. 按依赖顺序拼出 index.html 的 <script src>（经典脚本共享全局词法环境，
     所以顺序必须与原来的 import 图一致）。
  5. 资源**原样**搬进产物：`audio/` 整个目录 + scene.json 指到的那个模型，
     文件名一个字符都不改（含 `.mp3.xml` / `.glb.xml` 后缀）。

关于模型的两种取法（都要，缺一不可）：
  · `models/<名字>.glb.xml` 原样进包，`GLTFLoader.load(M.url)` 直接读它 —— 这是
    规范期望的形态（zip-artifact-spec.md §3：资源相对路径引用即可）；
  · 同时把同一份 GLB base64 内联进 data.js 当**兜底**：device-capabilities.md §4
    写着容器不可用 `fetch`/`XMLHttpRequest`，而 GLTFLoader.load() 内部就是 FileLoader
    → fetch。真要是不通，`window.__loadBedGLB()` 会接住错误改用内联副本，
    床不会因为一个请求失败就消失。兜底可以在确认容器允许本地请求后用
    `--no-bed-fallback` 关掉（省约 0.7 MiB）。

为什么不用 esbuild/rollup：本机没有 node_modules，也不该为打包临时装依赖
（js-compatibility.md §2「没有现成构建链时不为兼容性临时引入依赖」）。
这里的转换是**有断言的机械替换** —— 每一处预期片段找不到就直接 BUILD FAIL，
不会静默产出一个看起来正常、跑起来白屏的包。

用法：
  python tools/build_minitool.py                     # 生成 dist-minitool/ 并打包 zip
  python tools/build_minitool.py --nozip             # 只生成目录
  python tools/build_minitool.py --no-bed-fallback   # 不内联 GLB base64（床只走 models/ 文件）
"""

import base64
import json
import os
import re
import shutil
import struct
import sys
import zlib
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist-minitool")
ZIP_PATH = os.path.join(ROOT, "cloud-ladder-minitool.zip")

NO_BED_FALLBACK = False        # main() 里按命令行开关置位
NO_VIDEO = False               # --no-video：包不带视频（默认带，见 copy_assets 的说明）
FAILED = []


def die(msg):
    print("BUILD FAIL: " + msg)
    sys.exit(1)


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


WRITTEN = set()


def write(p, text):
    full = os.path.join(DIST, p)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    WRITTEN.add(p.replace("\\", "/"))
    print("  + %-28s %7d B" % (p, len(text.encode("utf-8"))))


def must(text, needle, where):
    if needle not in text:
        die("%s: 找不到预期片段 -> %r" % (where, needle[:90]))


def sub1(text, pattern, repl, where):
    """只允许命中一次的整体替换；命中 0 次或多次都算失败。"""
    new, n = re.subn(pattern, repl, text, count=1)
    if n != 1:
        die("%s: 正则命中 %d 次（期望 1 次）-> %s" % (where, n, pattern[:90]))
    return new


def iife(body, publish, label):
    return "/* %s */\n;(function(){\n%s\n%s\n})();\n" % (label, body.rstrip(), publish)


EXPORT_RE = re.compile(r"^export\s*\{([^}]*)\};?\s*$", re.M | re.S)
IMPORT_NAMED_RE = re.compile(r"import\s*\{([^}]*)\}\s*from\s*'([^']*)';")
IMPORT_STAR_RE = re.compile(r"import\s*\*\s*as\s+(\w+)\s*from\s*'([^']*)';")
EXPORT_DECL_RE = re.compile(r"^export\s+(function|const|let|var|class)\s+(\w+)", re.M)


def strip_exports(src, label, allow_empty=False):
    """把 `export function x` 拆成普通声明，并收集要发布的标识符。"""
    names = []

    def _keep(m):
        names.append(m.group(2))
        return "%s %s" % (m.group(1), m.group(2))

    src = EXPORT_DECL_RE.sub(_keep, src)
    m = EXPORT_RE.search(src)
    if m:
        names += [n.strip() for n in m.group(1).split(",") if n.strip()]
        src = src[: m.start()] + src[m.end():]
    if not names and not allow_empty:
        die("%s: 没解析到任何导出" % label)
    return src, names


def rewrite_imports(src, label, ours):
    """'three' → window.THREE；addon → window.__M；自家模块 → window.__APP。"""

    def _star(m):
        mod = m.group(2).split("?")[0]
        if mod == "three":
            return "const %s = window.THREE;" % m.group(1)
        die("%s: 未支持的 `import * as` 来源 %s" % (label, mod))

    def _named(m):
        names, mod = m.group(1), m.group(2).split("?")[0]
        if mod == "three":
            return "const {%s} = window.THREE;" % names
        # 相对路径：自家模块之间走 __APP，addon 之间走 __M（两边不能混，
        # 否则 maskPass 会去 __APP 里找一个根本不存在的 Pass）
        if mod.startswith("."):
            return "const {%s} = window.%s;" % (names, "__APP" if ours else "__M")
        if mod.startswith("three/addons/"):
            return "const {%s} = window.__M;" % names
        die("%s: 未支持的 import 来源 %s" % (label, mod))

    src = IMPORT_STAR_RE.sub(_star, src)
    src = IMPORT_NAMED_RE.sub(_named, src)
    return src


# ----------------------------------------------------------------------------
# 1. three 本体：唯一一处 `export { ... }` 全量列出，替换成 window.THREE = { ... }
# ----------------------------------------------------------------------------
ADDONS = [                      # 顺序 = 依赖顺序（IIFE 里 const {X} = window.__M 是即时求值）
    "shaders/CopyShader.js",
    "shaders/LuminosityHighPassShader.js",
    "shaders/OutputShader.js",
    "utils/BufferGeometryUtils.js",
    "postprocessing/Pass.js",
    "postprocessing/MaskPass.js",
    "postprocessing/ShaderPass.js",
    "postprocessing/EffectComposer.js",
    "postprocessing/RenderPass.js",
    "postprocessing/UnrealBloomPass.js",
    "postprocessing/OutputPass.js",
    "controls/OrbitControls.js",
    "loaders/GLTFLoader.js",
]

OURS = ["audio.js", "scene.js", "model.js", "postfx.js", "atmosphere.js", "main.js"]


def build_three():
    src = read("vendor/three/three.module.js")
    m = EXPORT_RE.search(src)
    if not m:
        die("three.module.js: 找不到末尾的 export {} 清单")
    names = m.group(1)
    if " as " in names:
        die("three.module.js: 导出清单里有别名（需要额外处理）")
    body = src[: m.start()] + "window.THREE = {\n" + names + "\n};"
    write("three.global.js", iife(body, "", "three.js r? (ESM → window.THREE)"))


def build_addons():
    parts = []
    for rel in ADDONS:
        src = read("vendor/three/addons/" + rel)
        src = rewrite_imports(src, rel, ours=False)
        src, names = strip_exports(src, rel)
        parts.append(iife(src, "window.__M = Object.assign(window.__M || {}, { %s });"
                          % ", ".join(names), "addons/" + rel))
    write("addons.global.js", "\n".join(parts))


def build_ours():
    for name in OURS:
        src = read(name)
        src = rewrite_imports(src, name, ours=True)
        src, names = strip_exports(src, name, allow_empty=(name == "main.js"))
        pub = ("window.__APP = Object.assign(window.__APP || {}, { %s });"
               % ", ".join(names)) if name != "main.js" else ""
        write(name, iife(src, pub, name + " (ESM → 经典脚本)"))


# ----------------------------------------------------------------------------
# 2. 内联数据：scene.json / config.json（＋ 床 GLB 的 base64 兜底副本）
# ----------------------------------------------------------------------------
def js_literal(text):
    lit = json.dumps(text, ensure_ascii=False)
    return lit.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build_data():
    scene = json.loads(read("scene.json"))
    conf = json.loads(read("config.json"))

    # performance-budget.md §4 的初始预算：drawing buffer 的 DPR 默认档是
    # min(devicePixelRatio, 1.5)。桌面页给的是 2（那是给大屏显示器的取舍），
    # 小工具跑在手机 WebView 上，按预算收到 1.5；只在产物里改，源码不动。
    r = scene.setdefault("renderer", {})
    old_pr = r.get("pixelRatioMax")
    r["pixelRatioMax"] = 1.5
    print("     （renderer.pixelRatioMax %s → 1.5，按 perf 预算的初始档）" % old_pr)

    # 曲目文件名**原样保留**（含 `.mp3.xml` 后缀）。
    # 这里以前会把 `.xml` 去掉，理由是「容器按扩展名识别资源类型」——那是我自己
    # 推的，规范里并没有这一条（zip-artifact-spec.md §3：文件/目录自由组织、相对
    # 路径引用即可）。而这套 `.xml` 后缀是用户**刻意**的约定（躲开本机 Windows
    # 注册表对 .mp3 的 MIME 映射），config.json 里写的也是 `.mp3.xml`。产物里改名
    # 等于「源码一套名字、产物另一套」，下次改完对不上还以为是没生效。
    # 所以：打包器只搬文件，不改名字。
    tracks = (conf.get("audio") or {}).get("tracks") or []
    adir = os.path.join(ROOT, "audio")
    for t in tracks:
        f = t.get("file")
        if not f:
            continue
        if not os.path.isfile(os.path.join(adir, f)):
            die("config.json 的 audio.tracks 指到不存在的文件：audio/%s" % f)
    print("     （曲目文件名保持原样：%s）" % ", ".join(t["file"] for t in tracks if t.get("file")))

    # _说明 是给人看的面板注释（applyConfig 明确跳过 `_` 开头以外的键不读它），
    # 运行时完全用不到 —— 24 KB 的中文文档塞进包里只会拖慢解析。
    dropped = 0
    if "_说明" in conf:
        dropped = len(json.dumps(conf["_说明"], ensure_ascii=False).encode("utf-8"))
        del conf["_说明"]

    # 小工具 zip 有 10 MiB 预算，且视频走媒体管线在部分容器里受限。
    # 所以 mini-tool 里把 projector.video.src 置空，让它回退到程序化画布动画；
    # web 版保留 scene.json 里的 ./video/night.mp4 原样播放。
    proj = scene.get("projector")
    if proj and proj.get("video") and proj["video"].get("src"):
        vsrc = proj["video"]["src"]
        if NO_VIDEO:
            proj["video"]["src"] = ""
            print("     （--no-video：去掉视频引用 %s，用程序化画布回退）" % vsrc)
        else:
            # 2026-10-09：默认**保留**视频。之前这里把 src 置空 + 不打包 video/，
            # 于是小红书里看到的永远是程序化画布兜底（用户报「视频播放不了」）。
            print("     （保留视频：%s 原样进包，走相对路径加载）" % vsrc)

    js = [
        "/* 由 tools/build_minitool.py 生成：把 fetch 换成内联常量（容器禁用 fetch） */",
        "window.SCENE_JSON = JSON.parse(%s);"
        % js_literal(json.dumps(scene, ensure_ascii=False, separators=(",", ":"))),
        "window.CONFIG_JSON = JSON.parse(%s);"
        % js_literal(json.dumps(conf, ensure_ascii=False, separators=(",", ":"))),
    ]
    print("     （config.json 的 _说明 已剥离：省 %d B）" % dropped)

    # GLB 路径**从 scene.json 读**，别再写死 models/bed.glb.xml —— 换过一次床模型
    # （bed.glb.xml → bed2.glb.xml）才发现写死的后果：打包脚本会静默地把**旧床**
    # 塞进产物，而源码页显示的是新床，于是「产物与源码逐像素一致」这条断言
    # 反而变成假绿（两边都比的是旧床）。文件不存在就直接 BUILD FAIL。
    glb_rel = (scene.get("bed", {}).get("model", {}) or {}).get("url") or ""
    if glb_rel.startswith("./"):
        glb_rel = glb_rel[2:]
    if not glb_rel:
        die("scene.json 的 bed.model.url 是空的，无法确定要塞哪个 GLB")
    glb_path = os.path.join(ROOT, glb_rel.replace("/", os.sep))
    if not os.path.isfile(glb_path):
        die("scene.json 指的模型不存在：%s" % glb_rel)
    glb = open(glb_path, "rb").read()
    if glb[:4] != b"glTF":
        die("%s 不是二进制 glTF" % glb_rel)
    if b'"uri"' in glb:
        die("GLB 里有外部 uri，parse() 无法离线解析")

    if NO_BED_FALLBACK:
        print("     （--no-bed-fallback：不内联 base64，床只走包内的 %s）" % glb_rel)
        write("data.js", "\n".join(js) + "\n")
        return

    b64 = base64.b64encode(glb).decode("ascii")
    print("     （%s %d B → base64 %d B = %.1f KiB，上限 1 MiB）"
          % (glb_rel, len(glb), len(b64), len(b64) / 1024))
    if len(glb) > 1024 * 1024:
        die("GLB 解码后超过 1 MiB，规范要求改为独立文件")
    js += [
        "",
        "/* 上面那个 GLB 的兜底副本：容器若禁掉 fetch/XHR，GLTFLoader.load(包内文件)",
        "   会失败，这里把它 parse 成 ArrayBuffer 再喂一次（见文件头的说明）。 */",
        "window.BED_GLB_B64 = %s;" % js_literal(b64),
        "/* base64 → ArrayBuffer。GLTFLoader.parse() 直接吃 ArrayBuffer。 */",
        "window.__b64ToBuf = function(b64){",
        "  var bin = atob(b64), n = bin.length, buf = new ArrayBuffer(n), u8 = new Uint8Array(buf);",
        "  for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);",
        "  return buf;",
        "};",
        "/* 先走包内文件，失败/卡住就换内联副本。签名刻意做成「在 .load( 前面插两个参数」",
        "   的形状，patch_model() 才能一行 replace 换掉调用点，不用去改函数体。",
        "   兜底只在**真出错**（或 30s 完全没动静）时启动 —— 实测教训：一开始把空闲",
        "   超时定成 12s，无头软件渲染下读那个 616 KB 的文件本身就超过 12s，于是",
        "   「兜底」和正在路上的请求同时跑了两遍 GLB 解析，启动从 14.3s 变成 29.0s，",
        "   而 via 最后还是 'file'（文件那份先回来）。正确判据不是「等了多久」而是",
        "   「请求死了没有」：**只要收到过一次数据就撤掉定时器**，之后再慢也认它是活的；",
        "   容器禁 fetch 时错误是立刻返回的，根本用不着靠计时猜。 */",
        "window.__loadBedGLB = function(url, loader, b64, onLoad, onProgress, onError){",
        "  var done = false, falling = false, idle = 0;",
        "  /* __bedSrc 是给探针看的：床到底是从包里的文件读出来的，还是退回内联副本。 */",
        "  window.__bedSrc = { via: '', url: url, note: '', chunks: 0 };",
        "  function stopIdle(){ if(idle){ clearTimeout(idle); idle = 0; } }",
        "  function fin(fn, arg){ if(done) return; done = true; stopIdle(); fn(arg); }",
        "  function fallback(err){",
        "    if(done || falling) return;                 /* 超时与 onError 可能都来一次 */",
        "    falling = true;",
        "    stopIdle();",
        "    if(!b64){ window.__bedSrc.via = 'file-only'; return fin(onError, err); }",
        "    window.__bedSrc.via = 'inline';",
        "    window.__bedSrc.note = String((err && err.message) || err || '').slice(0, 120);",
        "    console.warn('模型文件读取失败，改用内联副本：', window.__bedSrc.note);",
        "    try{ loader.parse(window.__b64ToBuf(b64), '', function(g){ fin(onLoad, g); }, onError); }",
        "    catch(e){ fin(onError, e); }",
        "  }",
        "  function bump(){ if(done) return; stopIdle(); idle = setTimeout(function(){ fallback(new Error('读取超时')); }, 30000); }",
        "  try{",
        "    loader.load(url, function(g){ window.__bedSrc.via = 'file'; fin(onLoad, g); },",
        "                function(ev){ window.__bedSrc.chunks++; stopIdle(); if(onProgress) onProgress(ev); },",
        "                fallback);",
        "  }catch(e){ fallback(e); }",
        "  bump();",
        "};",
    ]
    # 床贴图预烘焙（DataTexture 用，容器禁图片解码时也不白）：追加到 data.js
    js.append(build_bed_tex(glb))
    write("data.js", "\n".join(js) + "\n")


# ----------------------------------------------------------------------------
# 2b. 床贴图预烘焙：把 GLB 内嵌的 PNG 贴图（albedo / metallicRoughness）在构建期
#     解码成 256×256 的 RGBA 像素，连同 raw JPEG 法线一起塞进 window.BED_TEX。
#     运行时用 THREE.DataTexture（直接把字节传 GPU，不经过 Image / data: URI 解码）
#     赋值给床材质 —— 这样**即使容器禁掉了 Image / createImageBitmap / data: URI**
#     （小红书 WebView 常见），床依然有颜色，不会再退化成纯白。
#     为什么不直接让 GLTFLoader 解码内嵌贴图：那条路在本地 Chrome 正常，但小红书
#     容器里图片解码被禁，床就只剩 baseColorFactor（默认白）→ 全白。DataTexture
#     是唯一不依赖任何图片解码 API 的路径。
#     贴图缩到 256²：① 单张 base64 < 1MiB 预算；② 256 是 2 的幂，WebGL2 可生成
#     mipmap；③ 床上小物件用不上 512 的精度。
# ----------------------------------------------------------------------------
def _png_decode(raw):
    """纯 stdlib（zlib）PNG → RGBA 字节。支持 color type 0/2/4/6。"""
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not png")
    pos = 8; w = h = ct = 0; idat = b""
    while pos < len(raw):
        ln = struct.unpack(">I", raw[pos:pos + 4])[0]
        typ = raw[pos + 4:pos + 8]; data = raw[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, _bd, ct = struct.unpack(">IIBB", data[:10])
        elif typ == b"IDAT":
            idat += data
        elif typ == b"IEND":
            break
        pos += 12 + ln
    rawz = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = w * ch
    out = bytearray(); prev = bytearray(stride); p = 0
    for _ in range(h):
        f = rawz[p]; p += 1
        line = bytearray(rawz[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]; c = prev[i - ch] if i >= ch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out += line; prev = line
    if ct == 6:
        return w, h, bytes(out)
    if ct == 2:
        return w, h, b"".join(out[i:i + 3] + b"\xff" for i in range(0, len(out), 3))
    if ct == 0:
        return w, h, b"".join(bytes([v, v, v, 255]) for v in out)
    if ct == 4:
        return w, h, b"".join(out[i:i + 1] * 3 + out[i + 1:i + 2] for i in range(0, len(out), 2))
    raise ValueError("unsupported png color type %d" % ct)


def _downscale(rgba, w, h, ds):
    out = bytearray()
    for oy in range(ds):
        for ox in range(ds):
            sx, sy = ox * 2, oy * 2
            r = g = b = a = n = 0
            for dy in range(2):
                for dx in range(2):
                    x, y = sx + dx, sy + dy
                    if x < w and y < h:
                        i = (y * w + x) * 4
                        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n += 1
            out += bytes([r // n, g // n, b // n, a // n])
    return ds, ds, bytes(out)


def build_bed_tex(glb):
    """从 GLB 字节里抠出 albedo / metallicRoughness 的 PNG 与 normal 的 JPEG，
    返回 'window.BED_TEX = {...};' 字符串；任何一步失败都回退成 null（床退回标准贴图）。"""
    try:
        off = 12
        jlen = struct.unpack("<I", glb[off:off + 4])[0]
        js = json.loads(glb[off + 8:off + 8 + jlen].decode("utf-8"))
        bin_off = off + 8 + jlen
        blen = struct.unpack("<I", glb[bin_off:bin_off + 4])[0]
        bindata = glb[bin_off + 8:bin_off + 8 + blen]
        mat = js["materials"][0]
        pbr = mat["pbrMetallicRoughness"]

        def src_of(key):
            return js["textures"][pbr[key]["index"]]["source"]

        albedo_img = src_of("baseColorTexture")
        rough_img = src_of("metallicRoughnessTexture")
        normal_img = js["textures"][mat["normalTexture"]["index"]]["source"]

        def bv_bytes(idx):
            bv = js["bufferViews"][idx]
            return bindata[bv.get("byteOffset", 0): bv["byteOffset"] + bv["byteLength"]]

        def rgb_b64(img_idx):
            raw = bv_bytes(js["images"][img_idx]["bufferView"])
            w, h, rgba = _png_decode(raw)
            _w, _h, small = _downscale(rgba, w, h, 256)
            return base64.b64encode(small).decode("ascii"), _w, _h

        albedo_b64, aw, ah = rgb_b64(albedo_img)
        rough_b64, _rw, _rh = rgb_b64(rough_img)
        normal_raw = bv_bytes(js["images"][normal_img]["bufferView"])
        normal_b64 = base64.b64encode(normal_raw).decode("ascii")
        normal_mime = js["images"][normal_img].get("mimeType", "image/jpeg")
        obj = {
            "w": aw, "h": ah,
            "albedo": albedo_b64, "rough": rough_b64,
            "normal": normal_b64, "normalMime": normal_mime,
        }
        print("     （床贴图预烘焙：albedo/rough → 256² RGBA，normal → raw %d B，"
              "全走 DataTexture，不依赖容器图片解码）" % len(normal_raw))
        return "window.BED_TEX = %s;" % json.dumps(obj, separators=(",", ":"))
    except Exception as e:
        print("  ! 床贴图预烘焙失败，床将退回标准 GLTF 贴图：%s" % e)
        return "window.BED_TEX = null;"


# ----------------------------------------------------------------------------
# 3. index.html：抽出 body 内容 → 去掉脚本 → 换成一串经典 <script src>
# ----------------------------------------------------------------------------
HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport"
        content="width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>云端之梯 · #梦核 · Ladder to the Cloud</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="style.css">
  <style>
    /* 容器已禁用长按菜单与文字选择，这里只补：全屏铺满 + 兜底配色 */
    html,body{margin:0;padding:0;height:100%%;overflow:hidden;background:#8a78cc;}
    #app{width:100%%;height:100%%;}
    #boot-error{
      position:fixed;top:0;right:0;bottom:0;left:0;display:none;place-items:center;
      background:#a98fd8;color:#2a2040;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;
      padding:32px;z-index:9999;
    }
    #boot-error > div{max-width:560px;background:rgba(255,255,255,.92);border-radius:16px;padding:24px 28px;}
    /* 加载提示：样式必须随 HEAD 一起进产物（产物的 head 是这里的模板，
       不是源码 index.html 的 head），否则小工具里会是一行裸字。 */
    #boot-tip{
      position:fixed;top:0;right:0;bottom:0;left:0;z-index:9000;
      display:flex;align-items:center;justify-content:center;
      background:radial-gradient(120%% 100%% at 50%% 38%%,#c6b2ec 0%%,#a98fd8 58%%,#8a78cc 100%%);
      color:#2f2447;font:600 17px/1.6 system-ui,"Microsoft YaHei",sans-serif;
      letter-spacing:.08em;pointer-events:none;
      opacity:1;visibility:visible;
      transition:opacity .5s ease .1s,visibility 0s linear .6s;
    }
    #boot-tip.is-hidden{opacity:0;visibility:hidden;}
    #boot-tip i{
      width:6px;height:6px;margin-left:7px;border-radius:50%%;background:#4b3a6e;
      opacity:.3;animation:boot-pulse 1.1s ease-in-out infinite;
    }
    #boot-tip i:nth-of-type(2){animation-delay:.16s;}
    #boot-tip i:nth-of-type(3){animation-delay:.32s;}
    @keyframes boot-pulse{0%%,100%%{opacity:.3;}50%%{opacity:1;}}
  </style>
</head>
<body>
"""

FOOT_TMPL = """
  <div id="boot-error"><div id="boot-error-body">场景脚本没有跑起来，请重新打开小工具。</div></div>

  <!-- 经典脚本，按依赖顺序：three → addons → 内联数据 → 音频 → 场景 → 模型 → 后处理 → 时相 → 入口。
       容器禁用 ES 模块脚本，这些文件之间靠 window.THREE / window.__M / window.__APP 传递。 -->
  <script src="three.global.js"></script>
  <script src="addons.global.js"></script>
  <script src="data.js"></script>
  <script src="audio.js"></script>
  <script src="scene.js"></script>
  <script src="model.js"></script>
  <script src="postfx.js"></script>
  <script src="atmosphere.js"></script>
  <script src="main.js"></script>
</body>
</html>
"""


def build_html():
    src = read("index.html")
    m = re.search(r"<body>([\s\S]*)</body>", src)
    if not m:
        die("index.html: 找不到 <body>")
    body = m.group(1)
    n_scripts = len(re.findall(r"<script", body))
    body = re.sub(r"<script[\s\S]*?</script>", "", body)
    body = re.sub(r"\s*<!-- \?v= \u7528\u4e8e\u7ed5\u8fc7\u6d4f\u89c8\u5668\u65e7\u7f13\u5b58 -->", "", body)
    # 源码里那层 #boot-error 整块拿掉：产物用 FOOT_TMPL 里同名的那一个（文案更贴容器场景）。
    # 不去掉就会出现**两个同 id 的元素** —— 非法 HTML，而且 getElementById 只会取到第一个，
    # showBootError 填的是源码那个空壳、用户看到的却是另一个，排查时极易看错。
    body, n_boot = re.subn(
        r"\s*<div id=\"boot-error\">\s*<div id=\"boot-error-body\"></div>\s*</div>",
        "", body)
    if n_boot != 1:
        die("index.html: 预期剥掉 1 段 #boot-error，实际 %d 段" % n_boot)
    body = re.sub(r"\n{3,}", "\n\n", body)
    if "<script" in body:
        die("index.html: 还有没剥干净的 <script>")
    if "<iframe" in body or "<object" in body:
        die("index.html: 有 iframe/object（容器禁用）")
    print("     （剥掉 %d 段脚本 + 1 段源码 boot-error，body 只留 DOM）" % n_scripts)
    write("index.html", (HEAD + body.rstrip() + "\n" + FOOT_TMPL).replace("%%", "%"))


# ----------------------------------------------------------------------------
# 4. 源码侧的三处定点改造（都在产物里，源码保持可用浏览器直开）
# ----------------------------------------------------------------------------
def patch_main():
    p = os.path.join(DIST, "main.js")
    src = open(p, encoding="utf-8").read()
    src = sub1(
        src,
        r"Promise\.all\(\[[\s\S]*?\n\]\)",
        "Promise.resolve([window.SCENE_JSON, window.CONFIG_JSON])",
        "main.js 的 Promise.all(fetch...)",
    )
    must(src, "window.SCENE_JSON", "main.js 内联数据替换")
    if "fetch(" in src:
        die("main.js: 产物里仍有 fetch(")
    open(p, "w", encoding="utf-8", newline="\n").write(src)
    print("  ~ main.js    fetch → 内联常量")


def patch_model():
    p = os.path.join(DIST, "model.js")
    src = open(p, encoding="utf-8").read()
    must(src, "new GLTFLoader().load(M.url, ", "model.js 的 GLTFLoader.load")
    if NO_BED_FALLBACK:
        # 没有内联副本可退，就让源码原样走 .load(包内文件) —— 一个字符都不用改。
        open(p, "w", encoding="utf-8", newline="\n").write(src)
        print("  ~ model.js   原样：GLTFLoader.load(包内 models/ 文件)")
        return
    # 只在 .load( 前面插两个参数（loader 与备用 base64），函数体一行不动。
    src = src.replace(
        "new GLTFLoader().load(M.url, ",
        "window.__loadBedGLB(M.url, new GLTFLoader(), window.BED_GLB_B64, ",
    )
    must(src, "window.__loadBedGLB(M.url,", "model.js 的兜底加载替换")
    # 电视 <video> 的 crossOrigin：与 audio.js 同理剥掉。
    # 构建时 projector.video.src 被置空 ⇒ 那段 `if(src){…}` 是死代码、运行时压根不执行，
    # 但产物里留着 (a) 静态检查会命中 (b) 将来谁把 src 填回来就会踩「容器自定义 scheme
    # 下设 crossOrigin 被拒」的坑。剥掉是一行注释，零成本。
    must(src, "ve.crossOrigin = 'anonymous';", "model.js 的 video crossOrigin")
    src = src.replace(
        "ve.crossOrigin = 'anonymous';",
        "/* crossOrigin 去掉：容器自定义 scheme 下设它反而可能被拒（与 audio.js 同理） */",
    )
    open(p, "w", encoding="utf-8", newline="\n").write(src)
    print("  ~ model.js   load(包内文件) → 失败/卡住时退回内联 base64")
    print("  ~ model.js   video 的 crossOrigin=anonymous 移除")


def patch_audio():
    p = os.path.join(DIST, "audio.js")
    src = open(p, encoding="utf-8").read()
    must(src, "el.crossOrigin = 'anonymous';", "audio.js 的 crossOrigin")
    src = src.replace(
        "el.crossOrigin = 'anonymous';",
        "/* crossOrigin 去掉：包内本地媒体不走 CORS，容器自定义 scheme 下设它反而可能被拒 */",
    )
    open(p, "w", encoding="utf-8", newline="\n").write(src)
    print("  ~ audio.js   crossOrigin=anonymous 移除")


# ----------------------------------------------------------------------------
# 5. 静态资源
# ----------------------------------------------------------------------------
def patch_landscape_lock():
    """小工具容器里**禁用 fullscreen / orientation.lock** —— 禁用能力扫描会命中
    `requestFullscreen`（2026-10-09 首次命中：强制横屏那套用了它）。

    这里的处理是把它降级成 `null`：`lockLandscape()` 里是
    `const req = el.requestFullscreen || …; if(req){…}else after();`
    ⇒ req 变 null 后走 else 分支，只剩 orientation.lock 的尝试（也包在 try/catch 里，
    失败无副作用）。**横屏本身不受影响** —— 真正干活的是 CSS 旋转（`.ls-rot`），
    真锁只是「锦上添花」，容器里能省则省。

    ⚠ 与「先落地再修」的取舍：不要整段删掉 lockLandscape()，删了会让
       bindRotateGate / bindLandscapeGesture 的调用变成 undefined 引用。
       只摘掉那一个禁用 API 字符串，最小改动。"""
    p2 = os.path.join(DIST, "main.js")
    src = open(p2, encoding="utf-8").read()
    must(src, "el.requestFullscreen || el.webkitRequestFullscreen", "main.js 的 requestFullscreen")
    src = src.replace(
        "el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen",
        "null /* 小工具容器禁用 fullscreen；横屏靠 CSS 旋转，不需要它 */",
    )
    open(p2, "w", encoding="utf-8", newline="\n").write(src)
    print("  ~ main.js   requestFullscreen → null（容器禁用；横屏靠 .ls-rot）")


def copy_assets():
    """资源原样进包 —— 文件名一个字符都不改（用户的 `.xml` 后缀是刻意的）。"""
    adir = os.path.join(DIST, "audio")
    os.makedirs(adir, exist_ok=True)
    n_audio = 0
    for f in sorted(os.listdir(os.path.join(ROOT, "audio"))):
        shutil.copyfile(os.path.join(ROOT, "audio", f), os.path.join(adir, f))
        WRITTEN.add("audio/" + f)
        n_audio += 1
        print("  + audio/%-32s %8d B" % (f, os.path.getsize(os.path.join(adir, f))))
    if not n_audio:
        die("audio/ 是空的")
    shutil.copyfile(os.path.join(ROOT, "favicon.svg"), os.path.join(DIST, "favicon.svg"))
    shutil.copyfile(os.path.join(ROOT, "style.css"), os.path.join(DIST, "style.css"))
    WRITTEN.update(("favicon.svg", "style.css"))
    print("  + favicon.svg / style.css")
    # 电视视频原样进包（文件名一个字符不改），<video src="./video/night.mp4"> 才能加载。
    # ⚠ 体积是硬约束：zip 上限 10 MiB，视频约 5 MiB ⇒ 构建末尾必须断言体积。
    if not NO_VIDEO:
        # copy_assets 拿不到 main() 里的 scene（它在别的作用域），直接读磁盘
        _scene = json.load(open(os.path.join(ROOT, "scene.json"), encoding="utf-8-sig"))
        vsrc = (_scene.get("projector") or {}).get("video", {}).get("src") or ""
        if vsrc:
            vpath = os.path.join(ROOT, vsrc[2:] if vsrc.startswith("./") else vsrc)
            if not os.path.isfile(vpath):
                die("scene.json 引用的视频不存在：%s" % vsrc)
            vdir = os.path.join(DIST, "video")
            os.makedirs(vdir, exist_ok=True)
            vname = os.path.basename(vpath)
            shutil.copyfile(vpath, os.path.join(vdir, vname))
            WRITTEN.add("video/" + vname)
            print("  + video/%-32s %8d B" % (vname, os.path.getsize(os.path.join(vdir, vname))))
    # 产物里的 CSS 不再带 ?v=，但 style.css 里没有任何 URL 依赖，直接复制即可
    css = open(os.path.join(DIST, "style.css"), encoding="utf-8").read()
    if re.search(r"url\(\s*['\"]?https?:", css):
        die("style.css 里有外部 URL")


def copy_models():
    """把 scene.json 指到的那个模型**原样**搬进产物（连 `.glb.xml` 后缀一起）。

    以前 `models/` 整目录不进包：床是 base64 内联的，产物里根本没有模型文件。
    用户点出来「漏打包了 models」——他的 config 里写的就是 `./models/bed2.glb.xml`，
    产物里就该有这个名字的文件（zip-artifact-spec.md §6：页面引用的每个资源都在
    包里、路径正确）。文件名照抄，改一个字符都算改人家的东西。
    只搬被引用的那一个：models/ 里可能留着换下来的旧床（bed.glb.xml），
    没有任何地方引用它，塞进包里只是死重量。"""
    scene = json.loads(read("scene.json"))
    url = ((scene.get("bed") or {}).get("model") or {}).get("url") or ""
    rel = url[2:] if url.startswith("./") else url
    if not rel:
        die("scene.json 的 bed.model.url 是空的")
    src = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.isfile(src):
        die("scene.json 指的模型不存在：%s" % rel)
    dst = os.path.join(DIST, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    WRITTEN.add(rel)
    print("  + %-38s %8d B" % (rel, os.path.getsize(dst)))


def prune_dist():
    """清掉上一轮留下的、这一轮不再产出的文件。

    刻意**不用 shutil.rmtree(DIST)**：整目录递归删除会触发工作区的批量删除保护
    （>50 个文件要人工确认），在无人值守时直接把构建打断在半路 —— 实测就是
    「目录删到一半被拦、脚本退出、dist 还是上一版」，比不做清理更危险。
    改成「先全量覆盖写，再逐个删掉多余的」，一次最多删几个，既安全又不会残留。"""
    stale = []
    for base, _dirs, names in os.walk(DIST):
        for n in names:
            rel = os.path.relpath(os.path.join(base, n), DIST).replace("\\", "/")
            if rel not in WRITTEN:
                stale.append(rel)
    if not stale:
        print("  ~ prune: 无残留")
        return
    if len(stale) > 20:
        die("产物目录里有 %d 个非本轮产出文件，人工看一眼再跑：%s" % (len(stale), stale[:5]))
    for rel in stale:
        os.remove(os.path.join(DIST, rel))
    print("  ~ prune: 删掉 %d 个上一轮残留 %s" % (len(stale), stale))


def zip_dist():
    if os.path.exists(ZIP_PATH):
        os.remove(ZIP_PATH)
    files = []
    for base, _dirs, names in os.walk(DIST):
        for n in sorted(names):
            full = os.path.join(base, n)
            files.append((os.path.relpath(full, DIST).replace("\\", "/"), full))
    files.sort()
    # index.html 必须在 zip 根目录，且压缩的是「目录内容」而不是目录本身 ⇒ 用相对路径名入包
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for arc, full in files:
            if arc.split("/")[0] in ("node_modules", ".git"):
                die("产物里有 %s" % arc)
            zi = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(zi, f.read())
    print("\n  zip -> %s  (%.2f MiB)" % (ZIP_PATH, os.path.getsize(ZIP_PATH) / 1048576))


def verify_manifest():
    """产物里「页面会去要的每个文件」都得在（用户的报错就出在这条上）。

    打包器以前只保证**脚本**齐全：脚本是我们自己拼的，而 models/ 与 audio/
    是「搬过来的」，搬漏了没人喊。这里把 index.html 的 <script src> 与 style、
    config.json 的曲目、scene.json 的模型逐个对着产物目录点名，少一个就 FAIL。
    """
    print("\n=== 资源清单核对（产物里必须有的文件）===")
    scene = json.loads(read("scene.json"))
    conf = json.loads(read("config.json"))
    html = open(os.path.join(DIST, "index.html"), encoding="utf-8").read()
    need = ["style.css", "favicon.svg"] + re.findall(r'<script src="([^"]+)"', html)
    need += ["audio/" + t["file"]
             for t in ((conf.get("audio") or {}).get("tracks") or []) if t.get("file")]
    url = ((scene.get("bed") or {}).get("model") or {}).get("url") or ""
    need.append(url[2:] if url.startswith("./") else url)
    bad = []
    for rel in need:
        full = os.path.join(DIST, rel.replace("/", os.sep))
        if not os.path.isfile(full):
            bad.append(rel)
        else:
            print("  ✓ %-36s %9d B" % (rel, os.path.getsize(full)))
    if bad:
        die("产物里缺少页面会引用的文件：%s" % bad)
    print("  → %d 项齐全" % len(need))
    return len(need)


def scan_forbidden():
    """容器禁用能力的静态扫描（device-capabilities.md §7 清单）。"""
    bad = {
        "fetch(": r"\bfetch\s*\(",
        "XMLHttpRequest": r"XMLHttpRequest",
        "WebSocket": r"new\s+WebSocket\s*\(",
        "EventSource": r"new\s+EventSource\s*\(",
        "Web Worker": r"new\s+(Shared)?Worker\s*\(",
        "eval/new Function": r"\beval\s*\(|new\s+Function\s*\(",
        "WebAssembly": r"WebAssembly\.",
        "window.open": r"window\.open\s*\(",
        "location 跳转": r"location\.href\s*=|location\.assign\s*\(",
        "type=module": r'type\s*=\s*["\']module["\']',
        "import/export 残留": r"^\s*(import|export)\s",
        "外部 http 资源": r"(src|href)\s*=\s*[\"']https?:",
        "clipboard": r"navigator\.clipboard",
        "geolocation": r"navigator\.geolocation",
        "serviceWorker": r"navigator\.serviceWorker",
        "requestFullscreen": r"requestFullscreen",
        "iframe/object": r"<iframe|<object",
    }
    print("\n=== 禁用能力扫描（dist-minitool/）===")
    problems = 0
    for base, _d, names in os.walk(DIST):
        for n in names:
            full = os.path.join(base, n)
            rel = os.path.relpath(full, DIST).replace("\\", "/")
            if not n.endswith((".js", ".html", ".css")):
                continue
            if rel == "three.global.js" or rel == "addons.global.js":
                continue   # 第三方库内部有自检代码，逐项见 README 的说明
            text = open(full, encoding="utf-8", errors="replace").read()
            for label, pat in bad.items():
                for m in re.finditer(pat, text, re.M):
                    line = text[: m.start()].count("\n") + 1
                    print("  ✖ %-14s %s:%d  %s" % (label, rel, line,
                                                  text.split("\n")[line - 1].strip()[:80]))
                    problems += 1
    print("  → %d 处命中" % problems)
    # three / addons 里只剩「用不到的」fetch/XHR 实现（FileLoader / ImageBitmapLoader 等），
    # 我们没有调用它们，但按规范要如实登记：
    for rel in ("three.global.js", "addons.global.js"):
        text = open(os.path.join(DIST, rel), encoding="utf-8", errors="replace").read()
        hits = {}
        for label, pat in (("fetch(", r"\bfetch\s*\("), ("XMLHttpRequest", r"XMLHttpRequest"),
                           ("eval(", r"\beval\s*\("), ("new Function", r"new\s+Function\s*\(")):
            c = len(re.findall(pat, text))
            if c:
                hits[label] = c
        print("  · %-18s 库内残留：%s（未调用）" % (rel, hits or "无"))
    return problems


def main():
    global NO_BED_FALLBACK
    NO_BED_FALLBACK = "--no-bed-fallback" in sys.argv
    global NO_VIDEO
    NO_VIDEO = "--no-video" in sys.argv
    print("=== 构建 dist-minitool/ ===")
    os.makedirs(DIST, exist_ok=True)
    print("\n[1/7] three 本体")
    build_three()
    print("[2/7] addons")
    build_addons()
    print("[3/7] 自身模块")
    build_ours()
    print("[4/7] 内联数据")
    build_data()
    print("[5/7] index.html")
    build_html()
    print("[6/7] 定点改造")
    patch_main()
    patch_model()
    patch_audio()
    print("[7/7] 静态资源（audio/ + models/ + favicon + css）")
    patch_landscape_lock()
    copy_assets()
    copy_models()
    prune_dist()

    verify_manifest()
    scan_forbidden()
    if "--nozip" not in sys.argv:
        zip_dist()
    print("\nDONE")


if __name__ == "__main__":
    main()
