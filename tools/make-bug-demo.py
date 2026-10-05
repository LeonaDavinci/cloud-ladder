# -*- coding: utf-8 -*-
"""拼「切时相」复现三联图：下午 → 夜间 → 切回下午。
   复现用户的报障路径：点完夜间再切回下午，看云有没有跟着回来。"""
import io, os, sys
from PIL import Image, ImageDraw, ImageFont

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FONTS = [r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\msyh.ttc',
         r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\Deng.ttf']

def font(size):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                pass
    return ImageFont.load_default()

PANELS = [
    ('shots/bug-1-afternoon.png',        '① 下午（基准：粉云 · 暖光 · 蓝天）'),
    ('shots/bug-2-night.png',            '② 点「夜间」：云被洗成薰衣草紫 · 深蓝星空 · 亮月'),
    ('shots/bug-3-back-to-afternoon.png','③ 再点回「下午」：云/雾/天空/灯光/曝光/bloom 全部复原'),
]

ims = [(Image.open(p).convert('RGB'), c) for p, c in PANELS]
W, H = ims[0][0].size
SCALE = 0.52
w, h = int(W * SCALE), int(H * SCALE)
TITLE_H, CAP_H, PAD = 62, 40, 14

outW = w * 3 + PAD * 4
outH = TITLE_H + h + CAP_H + PAD * 2
canvas = Image.new('RGB', (outW, outH), (16, 14, 24))
d = ImageDraw.Draw(canvas)

d.text((PAD + 8, 16), '云端之梯 · 时相切换完整性复现（点夜间 → 切回下午）',
       font=font(26), fill=(255, 226, 244))

for i, (im, cap) in enumerate(ims):
    x = PAD + i * (w + PAD)
    y = TITLE_H
    canvas.paste(im.resize((w, h), Image.LANCZOS), (x, y))
    d.rectangle([x - 1, y - 1, x + w, y + h], outline=(120, 96, 140), width=2)
    d.text((x + 4, y + h + 10), cap, font=font(17), fill=(236, 216, 240))

out = 'preview-云端之梯-时相切换复原.png'
canvas.save(out)
print('saved', out, canvas.size)
