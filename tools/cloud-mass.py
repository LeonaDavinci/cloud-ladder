"""量「画面里有朵多大的云」—— 对「无云基线」求亮度差，再统计它的总量/面积/形心。

为什么不用「粉色像素计数」：那是在半透明软边上打硬阈值。
实测幅度从 drift 0.45 一路降到 0.10（位移 2.5m → 0.6m），粉色像素数只从 +22% 变到 +12%，
读数几乎不随幅度变化 —— 说明它量的是阈值伪影，不是云的视觉大小。

这个工具改用物理量：把云整组 visible=false 拍一张「无云基线」，
再拍有云的图，逐像素取亮度差 ΔL = L(有云) − L(无云)。
    ΣΔL     = 云给画面加的总光量 —— 云只要「总体没变大变淡」，这个数就恒定，
              和内部分片怎么翻滚无关（分片换位置不会凭空增加总的覆盖量）。
    A3/A12  = ΔL > 3 / > 12 的像素数 = 云的柔边 / 云芯面积。
    C       = ΔL 加权形心 = 云的位置。

用法：
  python tools/cloud-mass.py bg.png shot1.png shot2.png ... [--box y0,y1,x0,x1] [--thr 3,12]
  第一个参数必须是无云基线；后续每张都与它相减，并与第一张有云图比较。
  ⚠ box 顺序是 y0,y1,x0,x1（与 make-ab.py 一致）；png-stats.py 是 x0,y0,x1,y1，别搞混。
"""
import sys
import os
import importlib.util

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('pngstats', os.path.join(_here, 'png-stats.py'))
pngstats = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pngstats)
load_png = pngstats.load_png


def mass(bg_path, path, box=None, thr_lo=3.0, thr_hi=12.0):
    B, w, h, nch = load_png(bg_path)
    I, w2, h2, _ = load_png(path)
    assert (w, h) == (w2, h2), f'尺寸不一致: {bg_path} vs {path}'
    y0, y1, x0, x1 = (0.0, 1.0, 0.0, 1.0) if box is None else box
    ry0, ry1 = int(h * y0), int(h * y1)
    rx0, rx1 = int(w * x0), int(w * x1)
    tot = 0.0
    n3 = n12 = 0
    sx = sy = 0.0
    for y in range(ry0, ry1):
        row = y * w * nch
        for x in range(rx0, rx1):
            o = row + x * nch
            lb = 0.2126 * B[o] + 0.7152 * B[o + 1] + 0.0722 * B[o + 2]
            li = 0.2126 * I[o] + 0.7152 * I[o + 1] + 0.0722 * I[o + 2]
            d = li - lb
            if d <= 0:
                continue
            tot += d
            sx += d * x
            sy += d * y
            if d > thr_lo: n3 += 1
            if d > thr_hi: n12 += 1
    npx = (ry1 - ry0) * (rx1 - rx0)
    return dict(sum=tot, n3=n3, n12=n12,
                cen=None if tot <= 0 else (round(sx / tot, 2), round(sy / tot, 2)),
                npx=npx)


if __name__ == '__main__':
    args = sys.argv[1:]
    box = None
    thr = (3.0, 12.0)
    if '--box' in args:
        i = args.index('--box')
        box = tuple(float(v) for v in args[i + 1].split(','))
        del args[i:i + 2]
    if '--thr' in args:
        i = args.index('--thr')
        thr = tuple(float(v) for v in args[i + 1].split(','))
        del args[i:i + 2]
    files = [a for a in args if a.endswith('.png')]
    bg, tests = files[0], files[1:]
    print(f'无云基线 {bg}   统计区 {box or "全画面"}   阈值 {thr}')
    base = None
    for f in tests:
        s = mass(bg, f, box, *thr)
        line = (f'{f}\n  总光量 ΣΔL {s["sum"]/1e6:8.4f} M   柔边面积 {s["n3"]:>6d}   云芯面积 {s["n12"]:>6d}   '
                f'形心 {s["cen"]}')
        if base is None:
            base = (f, s)
        else:
            b = base[1]
            dsum = (s['sum'] - b['sum']) / max(b['sum'], 1e-9) * 100
            d3 = (s['n3'] - b['n3']) / max(b['n3'], 1) * 100
            d12 = (s['n12'] - b['n12']) / max(b['n12'], 1) * 100
            dcen = None if not s['cen'] or not b['cen'] else (
                round(s['cen'][0] - b['cen'][0], 2), round(s['cen'][1] - b['cen'][1], 2))
            line += (f'\n  相对 {base[0]}: 总光量 {dsum:+.2f}%  柔边面积 {d3:+.2f}%  '
                     f'云芯面积 {d12:+.2f}%  形心位移 px={dcen}')
        print(line)
