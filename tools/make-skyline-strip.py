"""把若干张同尺寸截图的天际线区域裁剪出来，纵向拼成对照图。

用法：
  python tools/make-skyline-strip.py out.png y0 y1 label=file.png [label=file.png ...]

用途：调「远处环山高度」时，肉眼判断到底哪一层山在挡天空，
以及改动前后天际线降了多少像素。
顶部会画出 y 刻度线，方便读出天际线所在的像素行。
"""
import sys
from PIL import Image, ImageDraw

out = sys.argv[1]
y0, y1 = int(sys.argv[2]), int(sys.argv[3])
items = []
for a in sys.argv[4:]:
    lab, f = a.split('=', 1)
    items.append((lab, f))

tiles = []
for lab, f in items:
    im = Image.open(f).convert('RGB')
    tiles.append((lab, im.crop((0, y0, im.width, y1))))

W = tiles[0][1].width
H = tiles[0][1].height
PAD = 22
canvas = Image.new('RGB', (W, (H + PAD) * len(tiles)), (18, 18, 22))
d = ImageDraw.Draw(canvas)

for i, (lab, t) in enumerate(tiles):
    oy = i * (H + PAD)
    canvas.paste(t, (0, oy + PAD))
    d.text((6, oy + 5), '%s   (crop y %d..%d)' % (lab, y0, y1), fill=(255, 255, 120))
    # 每 20 像素一条刻度（对应原图绝对 y）
    for yy in range(y0, y1 + 1, 20):
        ry = oy + PAD + (yy - y0)
        d.line([(0, ry), (W, ry)], fill=(255, 255, 255, 0), width=1)
        d.line([(0, ry), (W, ry)], fill=(90, 90, 96), width=1)
        d.text((6, ry + 1), str(yy), fill=(210, 210, 220))

canvas.save(out)
print('->', out, canvas.size)
