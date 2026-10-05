# -*- coding: utf-8 -*-
"""逐像素比对两批图（重构回归用）。

重构（拆文件/搬代码）的正确性判据是「画面一模一样」，不是「看起来差不多」。
所以这里给三个数：
  mean  平均绝对差（0~255）—— 0 就是完全一致
  bad%  差值 > tol 的像素占比
  max   最坏像素
纯搬迁导致的渲染差异只能是 0；非 0 就说明行为变了，别放过。
"""
import sys, os, io
from PIL import Image
import numpy as np

A, B = sys.argv[1], sys.argv[2]
tol = int(sys.argv[3]) if len(sys.argv) > 3 else 2

names = sorted(f for f in os.listdir(A) if f.endswith(".png"))
worst = []
print("%-22s %8s %8s %6s" % ("file", "mean", "bad%", "max"))
for n in names:
    pa, pb = os.path.join(A, n), os.path.join(B, n)
    if not os.path.exists(pb):
        print("%-22s  (缺少对照)" % n); continue
    a = np.asarray(Image.open(pa).convert("RGB")).astype(np.int16)
    b = np.asarray(Image.open(pb).convert("RGB")).astype(np.int16)
    if a.shape != b.shape:
        print("%-22s  尺寸不同 %s vs %s" % (n, a.shape, b.shape)); continue
    d = np.abs(a - b).max(axis=2)
    mean = d.mean()
    bad = 100.0 * (d > tol).mean()
    print("%-22s %8.3f %7.2f%% %6d" % (n, mean, bad, d.max()))
    worst.append((bad, n))

if worst:
    worst.sort(reverse=True)
    print("\n最差: %s  (bad %.2f%%)" % (worst[0][1], worst[0][0]))
