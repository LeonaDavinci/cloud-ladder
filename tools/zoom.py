"""把截图的一个相对区域最近邻放大，用来核对「画面里那到底是什么」。

用法: python tools/zoom.py <src.png> <dst.png> x0,y0,x1,y1 [倍率]
box 用**相对坐标**（0~1），顺序是 x0,y0,x1,y1 —— 与 png-stats.py 的 --diff 一致，
和 make-ab.py 的 crop(y0,y1,x0,x1) 正好相反，别记混。

（不 import make-ab.py —— 它末尾无条件调 main()，import 会拿本进程的 argv 去解析。）
"""
import sys, zlib, struct
from importlib.machinery import SourceFileLoader

_here = __file__.replace('\\', '/')
_p = SourceFileLoader('pngstats', _here.replace('zoom.py', 'png-stats.py')).load_module()
load_png = _p.load_png


def write_png(path, buf, w, h, nch=3):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += buf[y * w * nch:(y + 1) * w * nch]

    def chunk(typ, body):
        return (struct.pack('>I', len(body)) + typ + body
                + struct.pack('>I', zlib.crc32(typ + body) & 0xffffffff))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2 if nch == 3 else 6, 0, 0, 0)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                           + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))


def zoom(src, dst, box, k):
    buf, w, h, nch = load_png(src)
    x0, x1 = max(0, int(box[0] * w)), min(w, int(box[2] * w))
    y0, y1 = max(0, int(box[1] * h)), min(h, int(box[3] * h))
    cw, ch = x1 - x0, y1 - y0
    ow, oh = cw * k, ch * k
    out = bytearray(ow * oh * nch)
    for y in range(oh):
        row = (y0 + y // k) * w * nch
        drow = y * ow * nch
        for x in range(ow):
            si = row + (x0 + x // k) * nch
            di = drow + x * nch
            out[di:di + nch] = buf[si:si + nch]
    write_png(dst, bytes(out), ow, oh, nch)
    print('%s  %dx%d  (from %s, x%d)' % (dst, ow, oh, src, k))


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    b = [float(v) for v in sys.argv[3].split(',')]
    kk = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    zoom(sys.argv[1], sys.argv[2], b, kk)
