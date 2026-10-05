# -*- coding: utf-8 -*-
"""把单文件 main.js 拆成 scene.js / model.js / main.js。

原则：
  1. **字节级等价搬迁**：代码行原样搬运，只做三件事 —— 加/删 `export`、
     生成 import、把 main.js 的模块级 `let QUALITY` 一类改成 `RT.xxx`
     （ES module 的 import 绑定只读，不能赋值，所以跨模块可变状态必须收进对象）。
  2. **依赖单向**：scene.js → 无本地依赖；model.js → scene.js；main.js → 两者。
  3. 段按原文件顺序输出，所以每个模块内部的相对顺序不变（函数 hoisting 行为一致）。
"""
import io, re, os, sys

SRC = "tools/_main.before-split.js"   # 拆分前的原始单文件（脚本会覆盖 main.js，所以源必须另存）
raw = io.open(SRC, encoding="utf-8").read().split("\n")

# ---------------------------------------------------------------- 1. 切段
DECL = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)"
                  r"|(?:const|let|var)\s+(\w+)"
                  r"|class\s+(\w+))")
decls = []
for i, ln in enumerate(raw):
    m = DECL.match(ln)
    if m:
        decls.append({"name": m.group(1) or m.group(2) or m.group(3), "start": i})
for k, d in enumerate(decls):
    d["end"] = decls[k + 1]["start"] if k + 1 < len(decls) else len(raw)

HEAD = raw[:decls[0]["start"]]          # 1-7 行：原来的 6 条 import

# 伪声明：其实是 buildCloud 体内的代码，只是作者少缩进了 —— 并回 buildCloud
PSEUDO = {"radius", "segments", "shadowPlaneGeometry"}
# 变成共享状态对象 RT 成员的声明：整行删掉（值改写进 RT）
RTIFY = {"QUALITY", "CLOUD_Q", "PUFF_N", "MOUND", "RANGES", "MICRO", "BROAD", "sun"}

segs = [d for d in decls if d["name"] not in PSEUDO]

# ---------------------------------------------------------------- 2. 尾随注释归属下个段
# 每一行都带原始行号（lineno, text）—— 改写表是按原行号索引的，
# 段头插入注释后行号会错位，所以必须显式携带。
def split_trailing_comment(buf):
    """把段尾「连续的注释行（+它们之间的空行）」切出来，归属下一个段。
       注释紧贴它说明的声明，而声明可能被分到另一个模块 —— 不搬的话注释就孤零零了。"""
    i = len(buf) - 1
    while i >= 0 and buf[i][1].strip() == "":
        i -= 1
    end_trim = i + 1
    start = end_trim
    while i >= 0:
        s = buf[i][1].strip()
        if s.startswith("//"):
            start = i; i -= 1; continue
        if s.endswith("*/"):
            j = i
            while j >= 0 and "/*" not in buf[j][1]:
                j -= 1
            if j < 0:
                break
            start = j; i = j - 1; continue
        if s == "":            # 注释块之间的空行，继续往上探
            i -= 1; continue
        break
    if start >= end_trim:
        return buf, []
    return buf[:start], buf[start:end_trim]

pending_comment = []           # 被删段遗留下来的说明文字，收进 RT 声明处
for k in range(len(segs)):
    is_last = (k == len(segs) - 1)
    a = segs[k]["start"]
    b = segs[k]["end"] if is_last else segs[k + 1]["start"]
    buf = [(a + 1 + off, ln) for off, ln in enumerate(raw[a:b])]
    body, tail = split_trailing_comment(buf)
    segs[k]["lines"] = body
    if tail:
        if k + 1 < len(segs):
            segs[k + 1].setdefault("lead", []).extend(tail)
        else:
            segs[k]["lines"] = buf           # 最后一段，注释留着

# ---------------------------------------------------------------- 3. 分配到模块
SCENE = {
    "TINT_CLOUD", "TINT_BG", "regTint",
    "hash2", "noise2", "fbm2", "ridged", "hash1", "noise1", "fbm1",
    "terrainHeight",
    "hexToRgba", "hexToRgb255",
    "buildSky", "makeCloudTexture", "buildRidgeBand",
    "mulberry32", "pnoise", "pfbm", "SRGB2LIN", "makeGrassTexture", "buildTerrain",
    "buildFarClouds",
}
MODEL = {
    "qcount",
    "windSnippet", "injectWind", "makeShadowDepth", "applyShadowFlags",
    "makeGrassBladeGeo", "resolveAvoid", "makeAvoid", "buildGrass",
    "makeTuftTexture", "buildTufts",
    "makeLavenderTexture", "buildLavender",
    "buildBed", "smoothGeometryNormals", "loadBedModel",
    "makeDaisyTexture", "buildDaisies",
    "bedFootprint", "bedHalfLocal", "bedScaleOf", "bedSurfaceHeight", "makeBedAoTexture",
    "buildBedShadow",
    "makeRailGeometry", "buildLadder",
    "makeButterflyTexture", "buildButterflies",
    "makeGlintTexture", "buildGlints", "snapGlintsToBed",
    "buildCloud",
    "makeRippleTexture", "puffPoke", "rippleAt", "updateRipples",
    "updateCloudFlow", "updateCloudFade", "setupCloudPoke",
}
MAIN = {
    "sun", "_QS", "_FORCE_MOBILE", "IS_TOUCH", "IS_SMALL", "AUTO_MOBILE",
    "PR_CAP", "SHADOW_SZ", "CFG_EFF",
    "makeSupport", "setupModes", "applyConfig", "createSceneUI", "build",
}

module_of = {}
for s in segs:
    n = s["name"]
    if n in RTIFY:
        module_of[n] = "DROP"
    elif n in SCENE:
        module_of[n] = "scene"
    elif n in MODEL:
        module_of[n] = "model"
    elif n in MAIN:
        module_of[n] = "main"
    else:
        print("!! 未分配:", n); sys.exit(1)

# ---------------------------------------------------------------- 4. 每模块导出什么
EXPORTS = {
    "scene": {"RT", "terrainHeight", "TINT_CLOUD", "TINT_BG", "regTint",
              "hexToRgba", "hexToRgb255", "fbm2", "makeCloudTexture",
              "buildSky", "buildRidgeBand", "buildTerrain", "buildFarClouds"},
    "model": {"buildGrass", "buildTufts", "buildLavender", "buildBed", "loadBedModel",
              "buildDaisies", "buildBedShadow", "buildLadder", "buildButterflies",
              "buildGlints", "snapGlintsToBed", "buildCloud", "setupCloudPoke",
              "updateCloudFlow", "updateCloudFade",
              "resolveAvoid", "bedHalfLocal", "bedScaleOf", "bedSurfaceHeight"},
    "main": set(),
}

# 行级改写（1-based 原行号 -> [(旧片段, 新片段), ...]）
REWRITE = {
    # --- scene.js：地形参数 / 画质倍率 -> RT
    102: [("MOUND", "RT.mound")], 104: [("MOUND", "RT.mound")], 105: [("MOUND", "RT.mound")],
    106: [("MOUND", "RT.mound")], 108: [("MOUND", "RT.mound")], 109: [("MOUND", "RT.mound")],
    112: [("MOUND", "RT.mound")],
    120: [("MICRO", "RT.micro")], 122: [("MICRO", "RT.micro")], 123: [("MICRO", "RT.micro")],
    97:  [("BROAD", "RT.broad")], 99: [("BROAD", "RT.broad")], 100: [("BROAD", "RT.broad")],
    125: [("RANGES", "RT.ranges")], 128: [("RANGES", "RT.ranges")],
    634: [("QUALITY", "RT.quality")],
    # --- model.js
    31:  [("QUALITY", "RT.quality")],
    2077:[("PUFF_N", "RT.puffN"), ("CLOUD_Q", "RT.cloudQ")],
    2081:[("CLOUD_Q", "RT.cloudQ")],
    2089:[("PUFF_N", "RT.puffN")],
    # --- main.js
    3663:[("MOUND", "RT.mound")], 3664:[("RANGES", "RT.ranges")],
    3665:[("MICRO", "RT.micro")], 3666:[("BROAD", "RT.broad")],
    3673:[("QUALITY", "RT.quality")], 3675:[("CLOUD_Q", "RT.cloudQ")],
    3861:[("QUALITY", "RT.quality"), ("CLOUD_Q", "RT.cloudQ")],
    3862:[("PUFF_N", "RT.puffN")],
    # 这两行是**对象简写**（{ ..., sun, ... }），不能简单换成 RT.sun，得写成 sun: RT.sun
    3839:[("sun, hemi,", "sun: RT.sun, hemi,")],
    3850:[("camera, sun, controls", "camera, sun: RT.sun, controls")],
}
# 自动改写：裸 sun -> RT.sun。sun 是 build() 里建的平行光（夜间当月光），
# 但 model.js 的 buildCloud 要用它摆阴影平面 —— 属于跨模块状态，进 RT。
# 只作用于非注释行，且排除对象简写那两处（SKIP_AUTO）。
AUTO = [(re.compile(r"(?<![\w$.])sun(?![\w$])"), "RT.sun")]
SKIP_AUTO = {3839, 3850}
# buildCloud 里少缩进的三行，顺手缩进对（让它真正成为 buildCloud 的局部变量）
REINDENT = {2146: 4, 2147: 4, 2148: 4}

def fix_line(lineno, text):
    if lineno in REINDENT:
        text = " " * REINDENT[lineno] + text.lstrip()
    if lineno not in SKIP_AUTO and not text.strip().startswith(("//", "*", "/*")):
        for rx, rep in AUTO:
            text = rx.sub(rep, text)
    for old, new in REWRITE.get(lineno, []):
        text = re.sub(r"(?<![.\w$])" + re.escape(old) + r"\b", new.replace("\\", "\\\\"), text) \
               if re.match(r"^\w+$", old) else text.replace(old, new)
    return text

# ---------------------------------------------------------------- 5. 组装
out = {"scene": [], "model": [], "main": []}
RT_BLOCK = None

for s in segs:
    mod = module_of[s["name"]]
    if mod == "DROP":
        if s.get("lead"):
            pending_comment.extend(s["lead"])
        continue
    buf = list(s.get("lead", [])) + list(s["lines"])
    fixed = [fix_line(no, ln) for no, ln in buf]
    if s["name"] in EXPORTS[mod]:
        for i, ln in enumerate(fixed):
            if DECL.match(ln):                       # 找到真正的声明行，给它加 export
                fixed[i] = "export " + ln
                break
    # RT 声明插在 terrainHeight 之前（正好接住那几行地形注释）
    if s["name"] == "terrainHeight":
        out["scene"].append("@@RT@@")
    out[mod].append(fixed)

print("[dbg] segs=%d  out scene=%d model=%d main=%d  pending=%d"
      % (len(segs), len(out["scene"]), len(out["model"]), len(out["main"]), len(pending_comment)))

def join(segs_list):
    chunks = []
    for seg in segs_list:
        if seg == "@@RT@@":
            chunks.append("@@RT@@")
            continue
        buf = list(seg)
        while buf and buf[-1].strip() == "":
            buf.pop()
        while buf and buf[0].strip() == "":
            buf.pop(0)
        chunks.append("\n".join(buf))
    return "\n\n".join(chunks)

scene_body = join(out["scene"])
model_body = join(out["model"])
main_body  = join(out["main"])

rt_comment = "\n".join(txt for _no, txt in sorted(pending_comment)).rstrip()
RT_BLOCK = (rt_comment + "\n" if rt_comment else "") + """/* ------------------------------------------------------------
   运行时状态（RT）
   ------------------------------------------------------------
   这几个值「构建期被写、运行期被读」，原本是 main.js 的模块级 let。
   拆成三个文件后，ES module 的 import 绑定**只读不能写**，
   所以收进一个可变对象：谁要写就 RT.xxx = ...
     sun                          那盏平行光（夜间当月光）—— model.js 摆云的阴影平面要读它
     quality / cloudQ / puffN     画质档位（手机自动降档）
     mound / ranges / micro / broad   地形剖面参数（scene.json 注入）
   ------------------------------------------------------------ */
export const RT = {
  sun    : null,   // 唯一的平行光（日夜共用一盏，省一套阴影贴图）
  quality: 1,      // 植被实例数倍率
  cloudQ : 1,      // 体积云 billboard 倍率
  puffN  : 0,      // 实际生成的云 billboard 数（供调试出口读取）
  mound  : null,   // 中央谷地
  ranges : null,   // 远山
  micro  : null,   // 微观起伏
  broad  : null    // 大尺度起伏
};"""

FILES = {
    "scene.js": """import * as THREE from 'three';

/* ============================================================
   场景：噪声 / 地形 / 天空 / 远景
   ------------------------------------------------------------
   这一层只负责「世界本身」——地面高度场、天穹、远景环山与远景云，
   以及它们共用的程序化噪声与贴图。所有函数都是**纯构建**：
   给参数，返回 Object3D，不改全局状态（除了 RT 里的地形剖面）。
   物品（草/花/床/梯子/云/蝴蝶…）在 model.js，组装与交互在 main.js。
   ============================================================ */

@@BODY@@
""",
    "model.js": """import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  RT, terrainHeight, fbm2, hexToRgba, hexToRgb255, makeCloudTexture,
  regTint, TINT_CLOUD
} from './scene.js';

/* ============================================================
   物品建模：草 / 花 / 薰衣草 / 白菊 / 床 / 梯子 / 蝴蝶 / 云
   ------------------------------------------------------------
   每个 buildXxx(cfg, …) 收一份配置、返回一个 Object3D，
   内部管线一致：贴图（程序化画在 canvas 上）→ 几何 → 材质 → 实例化。
   地面高度一律用 scene.js 的 terrainHeight() 采样，所以只要地形剖面
   变了（RT.mound/…），物件会自动跟着起伏。
   ------------------------------------------------------------ */

@@BODY@@
""",
    "main.js": """import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createAudio } from './audio.js';
import { createPostFX } from './postfx.js';
import { createAtmosphere } from './atmosphere.js';
import {
  RT, terrainHeight, TINT_CLOUD, TINT_BG,
  buildSky, buildRidgeBand, buildTerrain, buildFarClouds
} from './scene.js';
import {
  resolveAvoid, bedHalfLocal, bedScaleOf, bedSurfaceHeight,
  buildGrass, buildTufts, buildLavender, buildBed, loadBedModel,
  buildDaisies, buildBedShadow, buildLadder, buildButterflies,
  buildGlints, snapGlintsToBed, buildCloud,
  setupCloudPoke, updateCloudFlow, updateCloudFade
} from './model.js';

/* ============================================================
   主入口：配置 → 组装 → 交互 → 渲染循环
   ------------------------------------------------------------
   scene.js 造世界，model.js 造物件，这里负责：
     · 读 scene.json / config.json 并合并覆盖（applyConfig）
     · 建渲染器、相机、控制器、音频、后处理、时相，并把所有物件摆好（build）
     · 三种相机模式的操控（setupModes）与屏幕上的时相/滤镜/雾档面板（createSceneUI）
     · 每帧推进：动画 → 云的流场/淡出 → 戳云 → 相机模式 → 后处理
   ============================================================ */

@@BODY@@
""",
}

for name, tmpl in FILES.items():
    body = {"scene.js": scene_body, "model.js": model_body, "main.js": main_body}[name]
    t = tmpl.replace("@@BODY@@", body.strip("\n"))
    t = t.replace("@@RT@@", RT_BLOCK)      # RT 块在 body 内部，必须最后替换
    io.open(name, "w", encoding="utf-8").write(t)
    print("%-10s %5d 行" % (name, t.count("\n") + 1))

print("done")
