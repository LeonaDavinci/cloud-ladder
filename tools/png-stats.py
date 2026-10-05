"""纯标准库 PNG 取样：给截图算「指定区域的平均颜色 / 平均亮度 / 主色」。
用法:
  python tools/png-stats.py a.png                 # 全图
  python tools/png-stats.py a.png 0.3,0.5,1,0.75  # 区域 x0,y0,x1,y1（0~1 相对坐标）
  python tools/png-stats.py a.png R b.png R       # 同区域 A/B 对比
  python tools/png-stats.py --diff a.png b.png [x0,y0,x1,y1]   # 逐像素差异

⚠ 区域顺序是 **x0,y0,x1,y1**，和 make-ab.py / cloud-mass.py 的 **y0,y1,x0,x1** 相反。
  传错顺序不会报错，只会默默统计到画面另一处 —— 本文件里踩过一次：
  想统计云的区域，结果量到左下角草地，三组对照的读数一模一样才发现。
"""
import sys, zlib, struct


def load_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos, idat, w, h, bd, ct = 8, [], 0, 0, 0, 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat.append(body)
        elif typ == b'IEND':
            break
        pos += 12 + ln
    assert bd == 8 and ct in (2, 6), f'unsupported bd={bd} ct={ct}'
    nch = 3 if ct == 2 else 4
    raw = zlib.decompress(b''.join(idat))
    stride = w * nch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out, w, h, nch


def region_stats(path, box=None, step=2):
    buf, w, h, nch = load_png(path)
    x0, y0, x1, y1 = 0.0, 0.0, 1.0, 1.0
    if box:
        x0, y0, x1, y1 = box
    X0, Y0 = int(x0 * w), int(y0 * h)
    X1, Y1 = int(x1 * w), int(y1 * h)
    n = 0
    sr = sg = sb = 0
    lum = 0
    for y in range(Y0, Y1, step):
        row = y * w * nch
        for x in range(X0, X1, step):
            i = row + x * nch
            r, g, b = buf[i], buf[i + 1], buf[i + 2]
            sr += r; sg += g; sb += b
            lum += 0.2126 * r + 0.7152 * g + 0.0722 * b
            n += 1
    if not n:
        return None
    sr, sg, sb, lum = sr / n, sg / n, sb / n, lum / n
    mx, mn = max(sr, sg, sb), min(sr, sg, sb)
    sat = 0 if mx == 0 else (mx - mn) / mx
    return dict(rgb=(round(sr), round(sg), round(sb)),
                hex='#%02x%02x%02x' % (int(sr), int(sg), int(sb)),
                lum=round(lum, 1), sat=round(sat, 3), n=n)


def parse_box(s):
    return tuple(float(v) for v in s.split(','))


def diff_stats(path_a, path_b, box=None, thr=12, step=1):
    """两张同尺寸图逐像素比：把「变了的像素」单独统计。
    典型用途：同一机位「有草丛 / 无草丛」两张图 → 差值像素就是草丛本身。"""
    A, w, h, nch = load_png(path_a)
    B, w2, h2, _ = load_png(path_b)
    assert (w, h) == (w2, h2), 'size mismatch'
    x0, y0, x1, y1 = box or (0.0, 0.0, 1.0, 1.0)
    X0, Y0, X1, Y1 = int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)
    na = [0, 0, 0]
    nb = [0, 0, 0]
    n = 0
    tot = 0
    for y in range(Y0, Y1, step):
        row = y * w * nch
        for x in range(X0, X1, step):
            i = row + x * nch
            d = max(abs(A[i] - B[i]), abs(A[i + 1] - B[i + 1]), abs(A[i + 2] - B[i + 2]))
            tot += 1
            if d < thr:
                continue
            n += 1
            for c in range(3):
                na[c] += A[i + c]
                nb[c] += B[i + c]
    if not n:
        return None
    ma = [v / n for v in na]
    mb = [v / n for v in nb]
    f = lambda m: '#%02x%02x%02x' % (int(m[0]), int(m[1]), int(m[2]))
    L = lambda m: round(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2], 1)
    return dict(changed=n, fraction=round(n / tot, 3), a=f(ma), b=f(mb), lumA=L(ma), lumB=L(mb))


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--diff':
        a, b = args[1], args[2]
        box = parse_box(args[3]) if len(args) > 3 else None
        s = diff_stats(a, b, box)
        if s is None:
            # 一张像素都没变（对照实验里这正是想要的结论，别在这里崩）
            print(f'{a}  vs  {b}\n  差异像素 0 (0.0%) —— 两张图在统计区内逐像素一致')
            raise SystemExit
        print(f'{a}  vs  {b}\n  差异像素 {s["changed"]} ({s["fraction"]*100:.1f}%)\n'
              f'  A 侧均值 {s["a"]}  lum={s["lumA"]}\n  B 侧均值 {s["b"]}  lum={s["lumB"]}\n'
              f'  亮度变化 {(s["lumB"]-s["lumA"])/max(s["lumA"],1)*100:+.1f}%')
        raise SystemExit
    pairs = []
    i = 0
    while i < len(args):
        f = args[i]
        box = None
        if i + 1 < len(args) and not args[i + 1].endswith('.png'):
            box = parse_box(args[i + 1]); i += 1
        pairs.append((f, box)); i += 1
    for f, box in pairs:
        s = region_stats(f, box)
        print(f'{f}  box={box or "full"}  ->  {s["hex"]}  lum={s["lum"]}  sat={s["sat"]}  px={s["n"]}')
