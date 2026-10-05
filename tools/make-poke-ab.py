"""三连对照 + 差异高亮：把「静止基线 / 被碰中 / 回弹后」三张同尺寸截图裁同一区域上下拼，
并在中间那张上把「与基线差异 ≥ thr 的像素」涂成品红，让肉眼一眼看到「碰了哪里、回了没」。

用法:
  python tools/make-poke-ab.py before.png poked.png back.png out.png [y0,y1,x0,x1] [thr]

⚠ box 顺序是 **y0,y1,x0,x1**（和 make-ab.py 一致，和 png-stats.py 的 x0,y0,x1,y1 相反）。
"""
import sys, zlib, struct
from importlib.machinery import SourceFileLoader

# 注意：不能直接 import make-ab.py —— 它末尾就是 main()，一加载就执行。
# 所以这里只借 png-stats.py 的 load_png，crop / write_png 自己写一份。
_p = __file__.replace('make-poke-ab.py', 'png-stats.py')
load_png = SourceFileLoader('pngstats', _p).load_module().load_png

SEP = 6
MAG = (255, 0, 255)


def write_png(path, buf, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += buf[y * w * 3:(y + 1) * w * 3]

    def chunk(typ, body):
        return (struct.pack('>I', len(body)) + typ + body
                + struct.pack('>I', zlib.crc32(typ + body) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                           + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))


def crop(path, y0, y1, x0, x1):
    buf, w, h, nch = load_png(path)
    ry0, ry1 = int(h * y0), int(h * y1)
    rx0, rx1 = int(w * x0), int(w * x1)
    out = bytearray()
    for y in range(ry0, ry1):
        for x in range(rx0, rx1):
            i = (y * w + x) * nch
            out += buf[i:i + 3]
    return out, rx1 - rx0, ry1 - ry0


def overlay(a, b, w, h, thr):
    """b 上把「和 a 差 ≥ thr」的像素染成品红，返回新 buffer + 差异像素数。"""
    out = bytearray(b)
    n = 0
    for i in range(0, w * h * 3, 3):
        if max(abs(a[i] - b[i]), abs(a[i + 1] - b[i + 1]), abs(a[i + 2] - b[i + 2])) >= thr:
            out[i:i + 3] = bytes(MAG)
            n += 1
    return out, n


def main():
    a, b, c, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    box = sys.argv[5] if len(sys.argv) > 5 else '0.18,0.66,0.22,0.80'
    thr = int(sys.argv[6]) if len(sys.argv) > 6 else 12
    y0, y1, x0, x1 = [float(v) for v in box.split(',')]
    ba, w, h = crop(a, y0, y1, x0, x1)
    bb, w2, h2 = crop(b, y0, y1, x0, x1)
    bc, w3, h3 = crop(c, y0, y1, x0, x1)
    assert (w, h) == (w2, h2) == (w3, h3), '三张图尺寸不一致'
    bm, npok = overlay(ba, bb, w, h, thr)
    bc2, nbak = overlay(ba, bc, w, h, thr)

    W, H = w, h * 3 + SEP * 2
    canvas = bytearray(W * H * 3)
    canvas[0:h * W * 3] = ba
    canvas[(h + SEP) * W * 3:(h + SEP + h) * W * 3] = bm
    canvas[(h * 2 + SEP * 2) * W * 3:] = bc2
    for y in range(h, h + SEP):
        for x in range(W):
            i = (y * W + x) * 3
            canvas[i:i + 3] = b'\xff\x00\xff'
    for y in range(h * 2 + SEP, h * 2 + SEP * 2):
        for x in range(W):
            i = (y * W + x) * 3
            canvas[i:i + 3] = b'\xff\x00\xff'
    write_png(out, canvas, W, H)
    tot = w * h
    print(f'{out}  {W}x{H}')
    print(f'  上 = 静止基线 {a}')
    print(f'  中 = 被碰中   {b}   差异像素 {npok} ({npok/tot*100:.2f}%)   [品红=差异]')
    print(f'  下 = 回弹后   {c}   差异像素 {nbak} ({nbak/tot*100:.2f}%)   [品红=差异]')


main()
