# -*- coding: utf-8 -*-
"""生成「控制面板从顶部移到左下」的前后对比 + 桌面/移动端双尺寸预览。

布局（左列桌面、右列移动端）：左列上下叠「改动前 / 改动后」两张同机位同尺寸图，
右列一张移动断点的整屏图。三张都是同一场景，只有面板位置不同。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BEFORE = os.path.join(ROOT, 'shots', 'ridge-before.png')
DESK = os.path.join(ROOT, 'shots', 'ui', 'ui-bottom-下午.png')
MOB = os.path.join(ROOT, 'shots', 'ui-m', 'ui-bottom-下午.png')
OUT = os.path.join(ROOT, 'preview-云端之梯-面板下移.png')

LW = 620          # 左列宽度（桌面两张）
RH = 560          # 右列高度（移动端）
HDR, BAR, GAP = 36, 30, 10


def font(size):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


F, FS = font(17), font(13)


def fitw(im, w):
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


def fith(im, h):
    return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)


desk = [fitw(Image.open(p).convert('RGB'), LW) for p in (BEFORE, DESK)]
mob = fith(Image.open(MOB).convert('RGB'), RH)
DH = desk[0].height
RW = mob.width

W = LW + GAP + RW
H = HDR + 2 * (BAR + DH) + GAP
canvas = Image.new('RGB', (W, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)

d.rectangle([0, 0, W, HDR], fill=(34, 30, 48))
d.text((12, 9), '云端之梯 · 时相 / 滤镜 / 雾档 面板：顶部 → 界面左下角', fill=(255, 226, 150), font=F)

left = ['改动前：面板压在左上角，正好盖住天空与远云的交接处',
        '改动后：桌面 1264×625 —— 顶部只剩 BGM 与模式按钮，面板落在左下草地上']
y = HDR
for i in (0, 1):
    d.rectangle([0, y, LW, y + BAR], fill=(26, 26, 34))
    d.text((10, y + 8), left[i], fill=(170, 225, 255), font=FS)
    canvas.paste(desk[i], (0, y + BAR))
    y += BAR + DH + (GAP if i == 0 else 0)

ry = HDR
d.rectangle([LW + GAP, ry, W, ry + BAR], fill=(26, 26, 34))
d.text((LW + GAP + 10, ry + 8), '移动断点 500×844：面板自动上移', fill=(170, 225, 255), font=FS)
canvas.paste(mob, (LW + GAP, ry + BAR))
d.text((LW + GAP + 10, ry + BAR + RH + 6),
       '底部安全区抬到 104px，不与标题 / 跳按钮 / 提示条重叠', fill=(150, 255, 190), font=FS)

canvas.save(OUT)
print('->', OUT, canvas.size)
