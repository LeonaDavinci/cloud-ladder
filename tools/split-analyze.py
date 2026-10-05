# -*- coding: utf-8 -*-
"""拆分前静态分析：找出 main.js 每个顶层声明的行区间，以及它引用了哪些其它顶层名。

不做真正的 JS 解析（不需要），只做「顶层声明切块 + 标识符扫描」——
对这个文件足够用，目标是拿到依赖矩阵，好判定切分边界是否单向。
"""
import io, re, json, collections

SRC = "main.js"
lines = io.open(SRC, encoding="utf-8").read().split("\n")

# ---- 1. 找顶层声明（行首顶格的 function / const / let / var / class）----
DECL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)"
    r"|(?:const|let|var)\s+(\w+)"
    r"|class\s+(\w+))"
)

decls = []          # [{'name','kind','start'(0based),'end','body'}]
for i, ln in enumerate(lines):
    m = DECL.match(ln)
    if not m:
        continue
    name = m.group(1) or m.group(2) or m.group(3)
    kind = "fn" if m.group(1) else ("class" if m.group(3) else "var")
    decls.append({"name": name, "kind": kind, "start": i, "end": len(lines), "body": ""})

for idx, d in enumerate(decls):
    d["end"] = decls[idx + 1]["start"] if idx + 1 < len(decls) else len(lines)
    d["body"] = "\n".join(lines[d["start"]:d["end"]])

# 头部前导区（import / 注释 / 直到第一条声明）
head_end = decls[0]["start"] if decls else len(lines)
head = "\n".join(lines[:head_end])

# ---- 2. 每个声明引用了哪些其它顶层名 ----
TOKEN = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
names = [d["name"] for d in decls]
nameset = set(names)

for d in decls:
    body = d["body"]
    # 去掉自身声明那一行，避免自引用
    used = set()
    for t in TOKEN.findall(body):
        if t in nameset and t != d["name"]:
            used.add(t)
    # 去掉属性访问 .foo 与对象字面量 key 的干扰（近似：前面紧邻 '.' 的算属性）
    used = {u for u in used if not re.search(r"\.\s*" + re.escape(u) + r"\b", body) or
            re.search(r"(?<![.\w$])" + re.escape(u) + r"\b", body)}
    d["uses"] = sorted(used)

# ---- 3. 谁被谁用 ----
used_by = collections.defaultdict(list)
for d in decls:
    for u in d["uses"]:
        used_by[u].append(d["name"])

# ---- 4. 报告 ----
out = []
out.append("== 头部（前 %d 行）==" % head_end)
out.append(head)
out.append("")
out.append("== 顶层声明（%d 个）==" % len(decls))
for d in decls:
    out.append("%-4d %-5s %-28s 行 %d-%d (%d 行)  uses=%s"
               % (d["start"] + 1, d["kind"], d["name"], d["start"] + 1, d["end"],
                  d["end"] - d["start"], ",".join(d["uses"]) if d["uses"] else "-"))

out.append("")
out.append("== 被引用次数排行 ==")
for n, c in sorted(used_by.items(), key=lambda kv: -len(kv[1]))[:40]:
    out.append("%-28s <- %d 次: %s" % (n, len(c), ",".join(c[:14]) + (" ..." if len(c) > 14 else "")))

io.open("tools/split-report.txt", "w", encoding="utf-8").write("\n".join(out))
print("\n".join(out[:0]))
print("wrote tools/split-report.txt ; decls=%d head=%d" % (len(decls), head_end))
