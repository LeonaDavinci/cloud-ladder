#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""扫 CSS 里的「注释提前闭合」隐患

现象（2026-10-08 实际踩到）：某条规则**整条不在 CSSOM 里**、computed 停在初始值，
而它前后相邻的规则都正常。根因是**注释里混进了 `*/`** —— 中文标点很容易撞上，
例如「…的注释）：」里的 `*/` 会让注释在那一行就闭合，后面的中文散文
就被浏览器当成 CSS 解析，解析错误一路持续，把紧随其后的规则吃掉。

CSS 的注释语义就是「`/*` 到**最近的** `*/`」，所以本检查按同样规则切块，
再判断每一块是否「看起来像一段正常的说明」：
  · 块内出现了 `*/` 之外的提前闭合迹象 —— 表现为：**闭合之后紧跟着一行
    「不含任何 CSS 记号的中文散文」**，那行就说明它被当成 CSS 了。

用法：python tools/check_css_comments.py [style.css ...]
退出码 0 = 干净；1 = 有可疑行（会逐行打印）
"""
import io
import re
import sys

# 一行里出现这些就说明它至少像个 CSS 记号，而不是散文
CSS_TOKEN = re.compile(r'[{};:#.*()\[\]=]|/\*|\*/|@media|@import|px|em|%|!important')


def scan(path):
    s = io.open(path, encoding='utf-8').read()
    lines = s.split('\n')
    problems = []
    in_comment = False
    for i, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line:
            continue
        if in_comment:
            # 注释块内：找第一个 */
            end = raw.find('*/')
            if end >= 0:
                in_comment = False
                rest = raw[end + 2:].strip()
                if rest and not CSS_TOKEN.search(rest) and re.search(r'[一-鿿]', rest):
                    problems.append((i, '注释提前闭合后残留散文', rest[:70]))
            continue
        start = raw.find('/*')
        if start >= 0:
            end = raw.find('*/', start + 2)
            if end >= 0:
                rest = raw[end + 2:].strip()
                if rest and not CSS_TOKEN.search(rest) and re.search(r'[一-鿿]', rest):
                    problems.append((i, '注释提前闭合后残留散文', rest[:70]))
            else:
                in_comment = True
    return problems


def main():
    files = sys.argv[1:] or ['style.css']
    bad = 0
    for p in files:
        probs = scan(p)
        print('=== %s ===' % p)
        if not probs:
            print('  干净：没有「注释提前闭合 + 散文被当 CSS」的行')
            continue
        for ln, kind, txt in probs:
            print('  L%-5d %s：%s' % (ln, kind, txt))
        bad += len(probs)
    print()
    print('=== 汇总：%d 处可疑 ===' % bad)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
