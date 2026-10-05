"""统计截图里「云」的像素面积 / 包围盒 / 形心 —— 用来判定整朵云有没有变大变小、移位。

为什么要它：云是几百张半透明 billboard 叠出来的，凭肉眼看截图很难判断
「刚刚改完流动之后，整朵云是不是比原来虚了、大了」。

遮罩规则（针对本场景的配色，比亮度阈值可靠得多）：
    云（粉 #ff9ecb / 白 #fff6fb / 底部 #f76aa8）   → 红 > 蓝  且  红 > 绿
    天空（薰衣草紫 #cdb6e8）与远山（蓝紫雾）        → 蓝 > 红
    草地（绿）与薰衣草                              → 绿 > 红
三个判定互不重叠，所以俯视/地面机位都能用，不会把天空或草地算成云。
（之前用「亮度 > 175 且 红 > 绿」——草地 #7ec850 的亮度约 164，离阈值只有 11，
 云稍微薄一点就跨过阈值，数字会跟着噪声跳。）

用法：
  python tools/cloud-area.py shot.png [shot2.png ...] [--lum 150]
  给两个及以上文件时，第一个当作「基准」，逐个打印相对它的变化量。
"""
import sys
import os
import importlib.util

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('pngstats', os.path.join(_here, 'png-stats.py'))
pngstats = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pngstats)
load_png = pngstats.load_png


def cloud_area(path, lum_thr=0.0, d_rb=8, d_rg=8):
    data, w, h, nch = load_png(path)
    n = 0
    sx = sy = 0
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w * nch
        for x in range(w):
            o = row + x * nch
            r, g, b = data[o], data[o + 1], data[o + 2]
            if r > b + d_rb and r > g + d_rg:
                if lum_thr:
                    if 0.2126 * r + 0.7152 * g + 0.0722 * b <= lum_thr:
                        continue
                n += 1
                sx += x; sy += y
                if x < x0: x0 = x
                if y < y0: y0 = y
                if x > x1: x1 = x
                if y > y1: y1 = y
    if n == 0:
        return dict(w=w, h=h, area=0, frac=0.0, box=None, cen=None)
    box = (x0, y0, x1, y1)                       # 像素坐标，便于算位移
    cen = (round(sx / n, 2), round(sy / n, 2))
    return dict(w=w, h=h, area=n, frac=round(n / (w * h), 4), box=box, cen=cen,
                rel=(round(x0 / w, 4), round(y0 / h, 4), round(x1 / w, 4), round(y1 / h, 4)))


def fmt(s):
    if s['area'] == 0:
        return '画面里没有云（遮罩全空）'
    b = s['box']
    return (f'云像素 {s["area"]:>7d}  占画面 {s["frac"]*100:5.2f}%  '
            f'包围盒 px=({b[0]},{b[1]})-({b[2]},{b[3]})  尺寸 {b[2]-b[0]+1}x{b[3]-b[1]+1}  '
            f'形心 {s["cen"]}')


if __name__ == '__main__':
    args = sys.argv[1:]
    lum = 0.0
    if '--lum' in args:
        i = args.index('--lum')
        lum = float(args[i + 1])
        del args[i:i + 2]
    files = [a for a in args if a.endswith('.png')]
    base = None
    for f in files:
        s = cloud_area(f, lum)
        print(f'{f}\n  {fmt(s)}')
        if base is None:
            base = (f, s)
        else:
            b0 = base[1]
            d_area = (s['area'] - b0['area']) / max(b0['area'], 1) * 100
            d_cen = None if not s['cen'] or not b0['cen'] else (
                round(s['cen'][0] - b0['cen'][0], 1), round(s['cen'][1] - b0['cen'][1], 1))
            db = tuple(s['box'][k] - b0['box'][k] for k in range(4))
            print(f'  相对 {base[0]}: 面积 {d_area:+.2f}%  包围盒四边位移 px={db}  形心位移 px={d_cen}')
