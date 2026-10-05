"""比较两张截图的像素差，定位「哪块区域变了」。
用法: python diffbox.py a.png b.png [thresh]
输出: 差异包围盒、每列/每行差异总量最大的位置、以及差异掩码的 ASCII 缩略图。
"""
import sys
from PIL import Image
import numpy as np


def main():
    a, b = sys.argv[1], sys.argv[2]
    th = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    A = np.asarray(Image.open(a).convert('RGB')).astype(np.int16)
    B = np.asarray(Image.open(b).convert('RGB')).astype(np.int16)
    if A.shape != B.shape:
        print('shape mismatch', A.shape, B.shape)
        return
    d = np.abs(A - B).max(axis=2)
    m = d > th
    H, W = m.shape
    print('size %dx%d  thresh=%d  changed px=%d (%.2f%%)' % (W, H, th, m.sum(), 100.0 * m.sum() / (H * W)))
    if m.sum() == 0:
        return
    ys, xs = np.where(m)
    print('bbox  x:%d..%d  y:%d..%d' % (xs.min(), xs.max(), ys.min(), ys.max()))
    colsum = m.sum(axis=0)
    rowsum = m.sum(axis=1)
    # 找出「跳变」的边缘：某列/行差异数相对邻域突变
    def edges(arr, name):
        peak = arr.max()
        if peak == 0:
            return
        idx = np.where(arr > peak * 0.25)[0]
        print('%s>25%%max: %s' % (name, '%d..%d' % (idx.min(), idx.max())))
        # 找最强跳变位置
        dif = np.abs(np.diff(arr.astype(np.int32)))
        top = np.argsort(dif)[::-1][:6]
        print('  %s 跳变 top: %s' % (name, ', '.join('%d(+%d)' % (t, dif[t]) for t in sorted(top))))
    edges(colsum, 'col')
    edges(rowsum, 'row')
    # ASCII 缩略图 60x24（按整除裁一下，W/H 不必是网格整数倍）
    gh, gw = 24, 60
    hh, ww = H // gh, W // gw
    small = m[:hh * gh, :ww * gw].reshape(gh, hh, gw, ww).mean(axis=(1, 3))
    print('--- mask (%d cols x %d rows) ---' % (gw, gh))
    for r in small:
        print(''.join('#' if v > 0.45 else ('+' if v > 0.12 else ('.' if v > 0.02 else ' ')) for v in r))


main()
