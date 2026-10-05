# -*- coding: utf-8 -*-
"""「云端之梯」换床对照图：同一机位、同一床头朝向的 旧模型 / 新模型。

四张底图都是 tools/bed-look.json（新）与 tools/bed-look-old.json（旧）在同一次
headless 里拍的，只有 scene.json 的 bed.model 段不同：
  行 1：3/4 视角    左=旧 bed.glb.xml   右=新 bed2.glb
  行 2：俯视        左=旧              右=新

为什么旧模型要重拍：换模型前的原始配置 rotationY=-1.5708 会把床头摆在梯子那一侧，
跟新床（床头在 -X、梯子在脚端）不是同一端 —— 直接拿历史截图并排会让人以为
「换模型把床头也换了」。所以旧模型也按 rotationY=+1.5708 重拍一次，
两边床头同端，比的才是「模型本身」。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = lambda *p: os.path.join(ROOT, 'shots', *p)
OUT = os.path.join(ROOT, 'preview-云端之梯-换床模型-改前改后.png')

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


notes = [
    ('配置只改了 bed.model 一段', (255, 214, 130)),
    ('url  bed.glb.xml → bed2.glb', (215, 215, 225)),
    ('rotationY  -1.5708 → 1.5708（床头仍在 -X）', (215, 215, 225)),
    ('topFrac    0.58 → 0.64（实测的被面分位）', (215, 215, 225)),
    ('smoothAngle  55 → 0（新模型自带法线+法线贴图）', (215, 215, 225)),
    ('', None),
    ('尺寸与落点（局部，未乘 bed.scale=1.2）', (255, 214, 130)),
    ('旧：2.25×1.05×1.5 原始 → 摆成 4.7×2.48×3.4', (215, 215, 225)),
    ('新：2.00×0.65×1.82 原始 → 摆成 4.7×2.25×3.4', (215, 215, 225)),
    ('两者被面都落在 surfaceY=1.44 → 梯顶/上床高度不动', (215, 215, 225)),
    ('', None),
    ('被面高度是打射线量出来的，不是猜的', (255, 214, 130)),
    ('11×11 网格竖直向下打射线，取命中高度的众数：', (215, 215, 225)),
    ('目标 1.728（=surfaceY×1.2），实测众数 1.70、中位 1.717', (215, 215, 225)),
    ('', None),
    ('顺手修掉一个一直存在的老 bug', (255, 214, 130)),
    ('缩放比与旋转写在同一个物体上时，scale 比 rotation', (215, 215, 225)),
    ('先作用 → 按「旋转后包围盒」算出来的比例落到了旋转前的', (215, 215, 225)),
    ('轴上。旧床原本想摆 4.7×3.4、实际是 5.1×3.13，', (215, 215, 225)),
    ('而可站立矩形一直按 4.7/3.4 算 → 人从床沿掉下去。', (215, 215, 225)),
    ('现在拆成「缩放/朝向/轴修正」三层，两者对齐了。', (150, 255, 190)),
    ('', None),
    ('三角形数', (255, 214, 130)),
    ('旧床 GLB 550 tris（无贴图）→ 新床 7958 tris（3 张内嵌贴图）', (215, 215, 225)),
    ('zip 体积会跟着涨（bed.glb 63 KB → bed2.glb 617 KB）', (255, 190, 190)),
]

src = load(S('bed-look-3q-old.png'), CELL_W)
new = load(S('bednew-3q.png'), CELL_W)
sold = load(S('bed-look-top-old.png'), CELL_W)
snew = load(S('bednew-top.png'), CELL_W)

CH = src.height
W = CELL_W * 2 + GAP
NOTE_H = len(notes) * LINE_H + 24
H = HDR + (BAR + CH) + ROWGAP + (BAR + CH) + ROWGAP + NOTE_H
canvas = Image.new('RGB', (W, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)

d.rectangle([0, 0, W, HDR], fill=(34, 30, 48))
d.text((12, 9), '云端之梯 · 换床模型：同一机位、同一床头朝向（固定种子 + 冻结时钟 + 禁动画）',
       fill=(255, 226, 150), font=F)

y = HDR
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '旧：bed.glb.xml（程序化木框+被面，逐顶层）', fill=(255, 170, 170), font=FS)
d.rectangle([CELL_W + GAP, y, W, y + BAR], fill=(26, 26, 34))
d.text((CELL_W + GAP + 10, y + 8), '新：bed2.glb（木框+床垫+被+枕，带贴图）', fill=(150, 255, 190), font=FS)
canvas.paste(src, (0, y + BAR))
canvas.paste(new, (CELL_W + GAP, y + BAR))

y += BAR + CH + ROWGAP
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '俯视 · 旧', fill=(255, 170, 170), font=FS)
d.rectangle([CELL_W + GAP, y, W, y + BAR], fill=(26, 26, 34))
d.text((CELL_W + GAP + 10, y + 8), '俯视 · 新', fill=(150, 255, 190), font=FS)
canvas.paste(sold, (0, y + BAR))
canvas.paste(snew, (CELL_W + GAP, y + BAR))

y += BAR + CH + ROWGAP
d.rectangle([0, y, W, y + 26], fill=(26, 26, 34))
d.text((10, y + 6), '这次动了什么 / 怎么验的', fill=(255, 214, 130), font=FS)
ny = y + 32
for text, color in notes:
    if ny > H - 16:
        break
    if color:
        d.text((10, ny), text, fill=color, font=FS)
    ny += LINE_H

canvas.save(OUT)
print('->', OUT, canvas.size)
