"""把两张同尺寸截图按同一区域裁出来，上下拼成一张 A/B 对比图（纯标准库，无 PIL）。
用法:
  python tools/make-ab.py a.png b.png out.png y0,y1,x0,x1
y0,y1,x0,x1 是 0~1 相对坐标，默认 0.44,0.84,0,1（中景草带）。
"""
import sys, zlib, struct

sys.path.insert(0, __file__.rsplit('\\', 1)[0].rsplit('/', 1)[0])
from importlib.machinery import SourceFileLoader
_p = __file__.replace('make-ab.py', 'png-stats.py')
_mod = SourceFileLoader('pngstats', _p).load_module()
load_png = _mod.load_png


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


def crop(path, y0, y1, x0, x1, ytop=None, ybot=None):
    buf, w, h, nch = load_png(path)
    ry0, ry1 = int(h * y0), int(h * y1)
    rx0, rx1 = int(w * x0), int(w * x1)
    out = bytearray()
    for y in range(ry0, ry1):
        for x in range(rx0, rx1):
            i = (y * w + x) * nch
            out += buf[i:i + 3]
    return out, rx1 - rx0, ry1 - ry0


def main():
    a, b, out = sys.argv[1], sys.argv[2], sys.argv[3]
    box = sys.argv[4] if len(sys.argv) > 4 else '0.44,0.84,0,1'
    y0, y1, x0, x1 = [float(v) for v in box.split(',')]
    ba, w, h = crop(a, y0, y1, x0, x1)
    bb, w2, h2 = crop(b, y0, y1, x0, x1)
    assert (w, h) == (w2, h2), '两张图尺寸不一致'
    sep = 6
    W, H = w, h * 2 + sep
    canvas = bytearray(W * H * 3)
    canvas[0:h * W * 3] = ba
    for y in range(h, h + sep):
        for x in range(W):
            i = (y * W + x) * 3
            canvas[i:i + 3] = b'\xff\x00\xff'
    canvas[(h + sep) * W * 3:] = bb
    write_png(out, canvas, W, H)
    print(f'{out}  {W}x{H}  (上=改前 {a} / 下=改后 {b})')


main()
