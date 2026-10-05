# -*- coding: utf-8 -*-
"""生成「远景环山降低」的前后对比图（2×2：整幅在左/右，天际线放大在下）。

为什么用两组冻结截图（shots/slvl = 改动前，shots/slvl3 = 改动后）：
两组都注入了同一个随机种子 + 冻结时钟，除了环山高度以外**没有任何变量**，
所以左右两幅的差异可以完全归因于这次改动；否则草/云/蝴蝶的随机布局
会盖过山脊那几十个像素的差别，看图的人根本分不出哪里变了。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BEFORE = os.path.join(ROOT, 'shots', 'slvl', 'slvl0-all.png')
AFTER = os.path.join(ROOT, 'shots', 'slvl3', 'slvl0-all.png')
SKY_BEFORE = os.path.join(ROOT, 'shots', 'slvl', 'slvl4-skyonly.png')
SKY_AFTER = os.path.join(ROOT, 'shots', 'slvl3', 'slvl4-skyonly.png')
OUT = os.path.join(ROOT, 'preview-云端之梯-远景环山降低.png')

COL = 632                 # 单列宽度
CROP = (0, 190, 632, 340)  # 天际线左段（山最高、变化最明显）
HDR = 34
BAR = 30


def font(size):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def sky_ratio(frame, sky):
    a = np.asarray(Image.open(frame).convert('RGB')).astype(np.int16)
    s = np.asarray(Image.open(sky).convert('RGB')).astype(np.int16)
    return 100.0 * (np.abs(a - s).max(axis=2) <= 6).mean()


r0 = sky_ratio(BEFORE, SKY_BEFORE)
r1 = sky_ratio(AFTER, SKY_AFTER)

full = [Image.open(p).convert('RGB') for p in (BEFORE, AFTER)]
fullS = [im.resize((COL, round(im.height * COL / im.width)), Image.LANCZOS) for im in full]
zoom = [im.crop(CROP) for im in full]
FH, ZH = fullS[0].height, zoom[0].height

canvas = Image.new('RGB', (COL * 2 + 8, HDR + BAR + FH + BAR + ZH + BAR), (14, 14, 18))
d = ImageDraw.Draw(canvas)
F17, F16 = font(17), font(15)


def band(y, x0, x1, text, color, f=F16):
    d.rectangle([x0, y, x1, y + BAR], fill=(26, 26, 34))
    d.text((x0 + 12, y + (BAR - f.size) // 2), text, fill=color, font=f)
    return y + BAR


d.rectangle([0, 0, canvas.width, HDR], fill=(34, 30, 48))
d.text((12, 8), '云端之梯 · 远景环山降低（画面天空占比 %.2f%% → %.2f%%）' % (r0, r1),
       fill=(255, 226, 150), font=F17)

y = HDR
y1 = band(y, 0, COL, '改动前  峰顶 ~9.7° / 11.7° / 13.1°（近 / 中 / 最远）', (255, 210, 170))
band(y, COL + 8, canvas.width, '改动后  峰顶 ~7.6° / 9.4° / 10.8°', (150, 255, 190))
canvas.paste(fullS[0], (0, y1)); canvas.paste(fullS[1], (COL + 8, y1))

y2 = y1 + FH
y3 = band(y2, 0, canvas.width,
          '天际线 1:1 原始像素（= 上图左半段放大 2×）—— 三层环山不再相互完全遮挡，层峦叠嶂仍在',
          (170, 225, 255))
canvas.paste(zoom[0], (0, y3)); canvas.paste(zoom[1], (COL + 8, y3))

canvas.save(OUT)
print('->', OUT, canvas.size)
