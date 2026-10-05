# -*- coding: utf-8 -*-
"""生成「加载提示 + 床逐轴放大」的对照预览图。

底图来自**产物包**（dist-minitool/index.html，走 http）：
   shots/boot-early.png    首屏那一帧：提示「梦境加载中，稍候。」还在
   shots/boot-late.png     场景就绪之后：提示 display:none
   shots/bed-look-top.png  床俯视（XZ 各 +50%）
   shots/bed-look-3q.png   床三分之四视图（Y +20%，被面抬高）

排版：第 1 行 = 提示的前后两帧；第 2 行 = 床的俯视 / 三分之四；
第 3 行 = 说明（两列，整幅宽）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = lambda *p: os.path.join(ROOT, 'shots', *p)
OUT = os.path.join(ROOT, 'preview-云端之梯-加载提示与放大床.png')

CELL_W = 620
HDR, BAR, GAP, ROWGAP = 36, 30, 12, 12
LINE_H = 19


def font(size):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


F, FS = font(17), font(13)


def load(p, w):
    im = Image.open(p).convert('RGB')
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


# (行, 列) -> 标题
TITLES = {
    (0, 0): ('提示在场：梦境加载中，稍候。', (255, 226, 150)),
    (0, 1): ('场景就绪：提示已退场（display:none / opacity:0）', (150, 255, 190)),
    (1, 0): ('床俯视：X / Z 各 ×1.5（无草区一并外推）', (170, 225, 255)),
    (1, 1): ('床三分之四：Y ×1.44，被面抬到 2.0736', (170, 225, 255)),
}
IMG = [
    [load(S('boot-early.png'), CELL_W), load(S('boot-late.png'), CELL_W)],
    [load(S('bed-look-top.png'), CELL_W), load(S('bed-look-3q.png'), CELL_W)],
]

notes = [
    ('加载提示（本轮新增）', (255, 214, 130)),
    ('文本「梦境加载中，稍候。」写在 index.html 里，', (215, 215, 225)),
    ('CSS 随 head 一起进产物 —— 产物 head 是构建模板，', (215, 215, 225)),
    ('不是源码 head，样式不搬过去小工具里就是一行裸字。', (215, 215, 225)),
    ('退场条件：首帧已上屏 且 所有登记任务都回调过，', (215, 215, 225)),
    ('再满足 420ms 最短显示（避免一闪而过像抖动）。', (215, 215, 225)),
    ('床 GLB 也登记成一个任务 ⇒ 床到位前提示不会撤。', (215, 215, 225)),
    ('', None),
    ('床逐轴放大', (255, 214, 130)),
    ('sizes.bedScale 从标量升级成 [x,y,z]，缩放原点仍是', (215, 215, 225)),
    ('床底中心 ⇒ 底面照旧贴地，只往外、往上长。', (215, 215, 225)),
    ('无草区 / 蝴蝶航线 / 床边花簇按同一组系数外推，', (215, 215, 225)),
    ('避免「床变大了，草还长在床里」。', (215, 215, 225)),
    ('被面锚点 surfaceY 2.0736（= 1.44 × 1.44），', (215, 215, 225)),
    ('射线实测众数 2.05，差 2.4 cm。', (215, 215, 225)),
    ('', None),
    ('实测读数', (255, 214, 130)),
    ('boot {hidden:true, reason:"ready", visible:false}', (215, 215, 225)),
    ('bedGroupScale [1.8, 1.44, 1.8] · avoidHalf 4.83×3.66', (215, 215, 225)),
    ('爬梯上床 foot 2.928 = bedTop 2.928（差 0）', (215, 215, 225)),
    ('复位 posErr 0 · window.__errs []', (215, 215, 225)),
]

CH = IMG[0][0].height
W = CELL_W * 2 + GAP
NCOL = 2
NROW = (len(notes) + NCOL - 1) // NCOL
NOTE_H = NROW * LINE_H + 30 + BAR
H = HDR + (BAR + CH) * 2 + ROWGAP * 2 + NOTE_H
canvas = Image.new('RGB', (W, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)

d.rectangle([0, 0, W, HDR], fill=(34, 30, 48))
d.text((12, 9), '云端之梯 · 加载提示与床逐轴放大（底图全部来自 dist-minitool 产物包）',
       fill=(255, 226, 150), font=F)

y = HDR
for r in range(2):
    for c in range(2):
        x = c * (CELL_W + GAP)
        d.rectangle([x, y, x + CELL_W, y + BAR], fill=(26, 26, 34))
        d.text((x + 10, y + 8), TITLES[(r, c)][0], fill=TITLES[(r, c)][1], font=FS)
        canvas.paste(IMG[r][c], (x, y + BAR))
    y += BAR + CH + ROWGAP

y += -ROWGAP + ROWGAP
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '说明', fill=(255, 226, 150), font=FS)
y += BAR
COLW = W // NCOL
for i, (text, color) in enumerate(notes):
    cx = (i // NROW) * COLW + 12
    cy = y + 8 + (i % NROW) * LINE_H
    if color:
        d.text((cx, cy), text, fill=color, font=FS)

canvas.save(OUT)
print('->', OUT, canvas.size)
