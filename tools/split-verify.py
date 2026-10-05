# -*- coding: utf-8 -*-
"""拆分等价性校验：原始单文件的每一行代码，必须能在三个新文件里找到同一行。

允许的差异（且只允许这些）：
  · 被删掉的 7 行 RT 声明（QUALITY/CLOUD_Q/PUFF_N/MOUND/RANGES/MICRO/BROAD）
  · 被改写的 ~25 行（QUALITY -> RT.quality 这类）
  · 被修正缩进的 3 行（buildCloud 里少缩进的三行）
  · 新增的 import / export / 注释
反过来说：如果原始里有任何**别的**代码行找不到，就是搬运丢了东西。
"""
import io, re, collections

SRC = "tools/_main.before-split.js"
orig = io.open(SRC, encoding="utf-8").read().split("\n")
new_txt = "\n".join(io.open(f, encoding="utf-8").read() for f in ("scene.js", "model.js", "main.js"))

def keys(lines):
    """把每行搓成一个「无关缩进、无关空行」的键，但仍区分内容。"""
    out = []
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        out.append(s)
    return out

def strip_comment(s):
    return re.sub(r"/\*.*?\*/", "", s).strip()

o = [strip_comment(k) for k in keys(orig)]
n_set = set(strip_comment(k) for k in keys(new_txt.split("\n")))
n_txt = strip_comment("\n".join(keys(new_txt.split("\n"))))

DROP = {"let QUALITY  = 1;", "let CLOUD_Q  = 1;", "let PUFF_N    = 0;",
        "let MOUND = null;", "let RANGES = null;", "let MICRO = null;", "let BROAD = null;",
        "var sun = null;"}
# 被改写 / 被重新缩进的行：按前缀识别
RE_RT = re.compile(r"(?<![\w$.])(QUALITY|CLOUD_Q|PUFF_N|MOUND|RANGES|MICRO|BROAD|sun)(?![\w$])")
def expected_changed(s):
    # 只在这些标识符真的被当作「值」用时才算 —— 排除 obj.sun / L.sun 这类属性访问
    if RE_RT.search(s): return True
    if s.startswith("const radius = 0.3") or s.startswith("const segments = 10"): return True
    if s.startswith("const shadowPlaneGeometry"): return True
    return False

missing, changed, dropped, ok = [], [], [], 0
for s in o:
    if s in n_set or s in n_txt:
        ok += 1; continue
    if s in DROP:
        dropped.append(s); continue
    if expected_changed(s):
        changed.append(s); continue
    missing.append(s)

print("原文件有效行（去空行、去注释块内联）: %d" % len(o))
print("  直接命中新文件            : %d" % ok)
print("  预期删除（7 行 RT 声明）  : %d" % len(dropped))
print("  预期改写（RT./缩进修正）  : %d" % len(changed))
print("  **未命中且非预期**        : %d" % len(missing))
for m in missing[:40]:
    print("     !! %s" % m[:140])

# 反向：新文件里出现、但原始里没有的行（应当只是 import/export/注释/RT 块）
o_set = set(o)
extra = [k for k in keys(new_txt.split("\n")) if strip_comment(k) not in o_set
         and not strip_comment(k).startswith(("import ", "export ", "} from", "@@"))
         and strip_comment(k) not in ("};",)]
print("新文件新增行（import/export/RT 块以外）: %d" % len(extra))
for e in extra[:40]:
    print("     ++ %s" % e[:140])
