# -*- coding: utf-8 -*-
"""检查三个模块的 import / export 是否闭合。

node --check 只验语法，验不出「导入了对方没导出的名字」——
而这一条会让整个 module graph 链接失败，页面上只显示「脚本加载失败」，
看不到具体原因。所以单独扫一遍。
"""
import io, re, os, json

FILES = ["scene.js", "model.js", "main.js"]

def exports_of(path):
    src = io.open(path, encoding="utf-8").read()
    names = set()
    # export function f / export const a = 1, b = 2 / export class C / export let x
    for m in re.finditer(r"^export\s+(?:async\s+)?(?:function|class)\s+(\w+)", src, re.M):
        names.add(m.group(1))
    for m in re.finditer(r"^export\s+(?:const|let|var)\s+([^=;\n]+)", src, re.M):
        chunk = m.group(1)
        for part in chunk.split(","):
            nm = part.strip().split("=")[0].strip()
            if re.match(r"^\w+$", nm):
                names.add(nm)
    # export { a, b }
    for m in re.finditer(r"^export\s*\{([^}]*)\}", src, re.M):
        for part in m.group(1).split(","):
            nm = part.strip().split(" as ")[-1].strip()
            if nm:
                names.add(nm)
    return names

def imports_of(path):
    src = io.open(path, encoding="utf-8").read()
    out = []
    for m in re.finditer(r"import\s+([\s\S]*?)\s+from\s+['\"]([^'\"]+)['\"]", src):
        body, spec = m.group(1), m.group(2)
        names = []
        bm = re.search(r"\{([\s\S]*)\}", body)
        if bm:
            for part in bm.group(1).split(","):
                nm = part.strip().split(" as ")[-1].strip()
                if nm:
                    names.append(nm)
        out.append((spec, names))
    return out

cache = {f: exports_of(f) for f in FILES}
print("== 各文件导出 ==")
for f in FILES:
    print("  %-10s %d 个: %s" % (f, len(cache[f]), ", ".join(sorted(cache[f]))))

bad = 0
print("\n== import 逐一核对 ==")
for f in FILES:
    for spec, names in imports_of(f):
        if spec.startswith("three") or spec.startswith("./audio") or spec.startswith("./postfx") \
           or spec.startswith("./atmosphere"):
            print("  %-10s -> %-22s (外部模块，跳过)" % (f, spec)); continue
        target = os.path.normpath(os.path.join(os.path.dirname(f) or ".", spec))
        if not os.path.exists(target):
            print("  !! %-10s -> %-22s 目标文件不存在" % (f, spec)); bad += 1; continue
        miss = [n for n in names if n not in cache.get(target, set())]
        if miss:
            print("  !! %-10s -> %-22s 缺少导出: %s" % (f, spec, miss)); bad += 1
        else:
            print("  ok %-10s -> %-22s %d 个名字全部命中" % (f, spec, len(names)))

print("\n问题数: %d" % bad)
