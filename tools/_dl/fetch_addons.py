"""下载匹配 vendor/three（r160）的后处理 addons + shaders。

为什么用 Python 而不是 shell 循环：这台机器上 Git-Bash 的 shim 在 for 循环里
对 `curl -o <路径>` 的处理很怪（第一条能写、后面报 No such file or directory）。
urllib 会读环境变量里的 http(s)_proxy，走同一个代理。
"""
import os, sys, urllib.request

VER = 'r160'
BASE = 'https://raw.githubusercontent.com/mrdoob/three.js/%s/examples/jsm/' % VER
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FILES = [
    'postprocessing/EffectComposer.js',
    'postprocessing/Pass.js',
    'postprocessing/ShaderPass.js',
    'postprocessing/MaskPass.js',
    'postprocessing/RenderPass.js',
    'postprocessing/UnrealBloomPass.js',
    'postprocessing/OutputPass.js',
    'shaders/CopyShader.js',
    'shaders/LuminosityHighPassShader.js',
    'shaders/OutputShader.js',
]

ok = True
for rel in FILES:
    dst = os.path.join(ROOT, 'vendor', 'three', 'addons', rel.replace('/', os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        with urllib.request.urlopen(BASE + rel, timeout=40) as r:
            data = r.read()
        if len(data) < 400:
            print('TOO SMALL %-46s %d' % (rel, len(data)))
            ok = False
            continue
        with open(dst, 'wb') as f:
            f.write(data)
        print('ok  %-46s %7d bytes' % (rel, len(data)))
    except Exception as e:
        print('FAIL %-45s %s' % (rel, e))
        ok = False

# 依赖自检：把每个文件的 import 目标列出来，缺谁一眼可见
import re
print('--- import 依赖 ---')
for rel in FILES:
    src = open(os.path.join(ROOT, 'vendor', 'three', 'addons', rel.replace('/', os.sep)), encoding='utf-8').read()
    deps = sorted(set(re.findall(r"from '([^']+)'", src)))
    print('%-42s %s' % (rel, ' '.join(deps)))
sys.exit(0 if ok else 1)
