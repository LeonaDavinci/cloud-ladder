# -*- coding: utf-8 -*-
"""天际线归因分析：算出「画面里每列最上方的非天空像素」是哪一层山贡献的。

背景：远景有三层环山（半径 2200 / 2950 / 3400）。想知道「哪一层在挡天空」，
肉眼看不清——三层颜色都被雾冲淡、又互相遮挡。这里用「逐层累加隐藏」的办法：
    slvl0-all      全部
    slvl1-no3400   隐藏最远(3400)
    slvl2-no2950   再隐藏 2950
    slvl3-noall    三层都隐藏
    slvl4-skyonly  连地形/云/草全部隐藏，只剩天穹
每张图与 skyonly 比，得到「非天空像素」掩码；再对每列取最上方的一行 = 天际线。

用法: python tools/skyline-attrib.py <shots目录> [tol]
"""
import sys, os
from PIL import Image
import numpy as np

d = sys.argv[1]
tol = int(sys.argv[2]) if len(sys.argv) > 2 else 10

names = ['slvl0-all', 'slvl1-no3400', 'slvl2-no2950', 'slvl3-noall']
sky = np.asarray(Image.open(os.path.join(d, 'slvl4-skyonly.png')).convert('RGB')).astype(np.int16)
H, W = sky.shape[:2]

tops = {}
for n in names:
    a = np.asarray(Image.open(os.path.join(d, n + '.png')).convert('RGB')).astype(np.int16)
    m = np.abs(a - sky).max(axis=2) > tol
    t = np.full(W, -1, dtype=np.int32)
    for x in range(W):
        ys = np.where(m[:, x])[0]
        if len(ys):
            t[x] = ys.min()
    tops[n] = t

# 每列：天际线依次由哪一层抬高
print('每列「最上方非天空像素的行号」（-1 = 该状态此列无遮挡，全是天空）')
print('%-14s %s' % ('状态', '  '.join('x%-4d' % x for x in range(40, W, 100))))
for n in names:
    t = tops[n]
    print('%-14s %s' % (n, '  '.join(('%4d ' % t[x]) for x in range(40, W, 100))))

print()
print('== 各层「抬高天际线」的贡献（行数，越大=挡天空越多）==')
for i, (n, label) in enumerate([('slvl1-no3400', '3400(最远)'),
                                ('slvl2-no2950', '2950'),
                                ('slvl3-noall',  '2200(最近)')]):
    pass
prev = tops['slvl0-all']
for n, label in [('slvl1-no3400', '隐藏3400 → 天际线下移'),
                 ('slvl2-no2950', '再隐藏2950 → 天际线下移'),
                 ('slvl3-noall',  '再隐藏2200 → 天际线下移')]:
    cur = tops[n]
    both = (prev >= 0) & (cur >= 0)
    diff = np.where(both, cur - prev, 0)
    both_any = (prev >= 0) | (cur >= 0)
    up = int((diff > 0).sum())
    print('%-28s 有变化列数=%4d/%d  平均下移=%5.1fpx  最大下移=%3dpx'
          % (label, up, int(both_any.sum()), diff[both_any].mean() if both_any.any() else 0,
             diff.max() if both_any.any() else 0))
    prev = cur
