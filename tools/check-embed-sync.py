# -*- coding: utf-8 -*-
"""比对源码 JSON 与 dist-minitool/data.js 内联进产物里的那份（打包后防「包比源码旧」）。

用法：
    python tools/check-embed-sync.py [scene|config|all]

为什么需要它：`build_minitool.py` 把 scene.json / config.json 内联进 data.js，
而 dist 是**快照**。改完源码忘记重打包时，页面（走 fetch）是新值、产物（走内联
常量）是旧值 —— 两边都「能跑」，只有逐项读数值才看得出来。时间戳不可靠
（改一次再改回来、编辑器重写同内容都会动 mtime），所以直接比**解析后的对象**。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def embedded(name):
    js = open(os.path.join(ROOT, 'dist-minitool', 'data.js'), encoding='utf-8').read()
    m = re.search(r'window\.%s_JSON = JSON\.parse\("((?:[^"\\]|\\.)*)"\);' % name.upper(), js)
    if not m:
        raise SystemExit('data.js 里找不到 window.%s_JSON' % name.upper())
    return json.loads(json.loads('"' + m.group(1) + '"'))


def diff(a, b, path=''):
    out = []
    if type(a) is not type(b):
        return ['%s: 类型 %s vs %s' % (path, type(a).__name__, type(b).__name__)]
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append('%s/%s: 仅包内有' % (path, k))
            elif k not in b:
                out.append('%s/%s: 仅源码有' % (path, k))
            else:
                out += diff(a[k], b[k], '%s/%s' % (path, k))
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append('%s: 长度 %d vs %d' % (path, len(a), len(b)))
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                out += diff(x, y, '%s[%d]' % (path, i))
    elif a != b:
        out.append('%s: 源码 %r vs 包内 %r' % (path, a, b))
    return out


def normalize(name, src):
    """把源码那份按**打包脚本已知的定点改写**归一化，否则脚本天天误报。

    打包器只动两处（都是有意为之，不是陈旧）：
      1. conf._说明 整段剥离（省 ~25 KB）
      2. renderer.pixelRatioMax → 1.5（性能预算的初始档）

    它**不再**改音频文件名。以前这里还额外把 `audio.tracks[*].file` 的 `.xml`
    去掉（那时打包器会改名），所以那一条得一起消掉；后来改成「资源一律原样搬、
    连文件名都不动」，这一条归一化就必须删 —— 留着它会**把真实的差异也一起
    抹平**（包里的曲目名被剥掉 `.xml` 去跟源码比，正好比中，于是改了名也看不出来）。
    """
    src = json.loads(json.dumps(src))
    if name == 'config':
        src.pop('_说明', None)
    for path in ('renderer',):
        if path in src and isinstance(src[path], dict) and 'pixelRatioMax' in src[path]:
            src[path]['pixelRatioMax'] = 1.5
    return src


def main():
    which = (sys.argv[1] if len(sys.argv) > 1 else 'all')
    names = ['scene', 'config'] if which == 'all' else [which]
    bad = 0
    for n in names:
        src = json.load(open(os.path.join(ROOT, n + '.json'), encoding='utf-8'))
        emb = embedded(n)
        d = diff(normalize(n, src), emb)
        if d:
            bad = 1
            print('%s.json  与包内不一致（%d 处）—— 需要重打包：' % (n, len(d)))
            for line in d[:25]:
                print('   ', line)
        else:
            print('%s.json  与包内一致（已按打包规则归一化）' % n)
    return bad


if __name__ == '__main__':
    raise SystemExit(main())
