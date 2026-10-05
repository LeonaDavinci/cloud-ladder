# -*- coding: utf-8 -*-
"""生成「雾效渐变 + 底部 UI」的交付预览图。

上半：小雾 ⇄ 超大雾 的四个时刻。四张图来自 tools/fog-strip.json ——
      run 时注入了 freeze-pre.js（固定随机种子 + 冻结时钟），并且是靠
      `atmos.update(0.7)` 这种手动步进把动画停在指定的 t 上，所以
      四张图之间除了雾的 near/far 之外没有别的变量，能直接对比。
下半：布局（桌面 + 移动断点）。标题在左上角、底部常驻提示已去掉、
      时相/滤镜/雾 三排按钮从左下角贴底排列。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ST = os.path.join(ROOT, 'shots', 'strip')
OUT = os.path.join(ROOT, 'preview-云端之梯-雾渐变与底部UI.png')

PANELS = [
    ('strip-0-超大雾-t0.png',   't = 0.00s   near 2.6 / far 64    超大雾（白茫茫）'),
    ('strip-1-t0.35.png',       't = 0.70s   near 8.9 / far 1511  雾在退'),
    ('strip-2-t0.65.png',       't = 1.30s   near 18.7 / far 3753 远山回来了'),
    ('strip-3-小雾-t1.png',     't = 2.00s   near 25 / far 5200   小雾（原样）'),
]
DESKTOP = os.path.join(ROOT, 'shots', 'hud', 'hudtl-下午.png')
MOBILE  = os.path.join(ROOT, 'shots', 'hud-m', 'hudtl-下午.png')

PW = 336            # 上半单幅宽
GAP = 8
HDR, BAR, LBL = 42, 30, 24


def font(size):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


F17, F15, F13 = font(17), font(15), font(13)

W = PW * 4 + GAP * 3
panels = []
for fn, cap in PANELS:
    im = Image.open(os.path.join(ST, fn)).convert('RGB')
    panels.append((im.resize((PW, round(im.height * PW / im.width)), Image.LANCZOS), cap))
PH = panels[0][0].height

desk = Image.open(DESKTOP).convert('RGB')
mob = Image.open(MOBILE).convert('RGB')
DW = 900
deskS = desk.resize((DW, round(desk.height * DW / desk.width)), Image.LANCZOS)
mobS = mob.resize((round(mob.width * deskS.height / mob.height), deskS.height), Image.LANCZOS)
DH = deskS.height

H = HDR + BAR + PH + LBL + BAR + DH + 26
canvas = Image.new('RGB', (W, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)


def bar(y, x0, x1, text, color, f=F15, bg=(26, 26, 34)):
    d.rectangle([x0, y, x1, y + BAR], fill=bg)
    d.text((x0 + 12, y + (BAR - f.size) // 2), text, fill=color, font=f)
    return y + BAR


d.rectangle([0, 0, W, HDR], fill=(34, 30, 48))
d.text((12, 10), '云端之梯 · 雾效改成 2 秒渐变（near/far 走 smoothstep）+ 底部 UI 调整',
       fill=(255, 226, 150), font=F17)

y = HDR
y = bar(y, 0, W, '① 点「超大雾 → 小雾」之后：near/far 不再突变，2 秒内走完（四张图只差雾，其余全部冻结）',
        (170, 225, 255))
for i, (im, cap) in enumerate(panels):
    x = i * (PW + GAP)
    canvas.paste(im, (x, y))
    d.rectangle([x, y + PH, x + PW, y + PH + LBL], fill=(20, 20, 26))
    d.text((x + 8, y + PH + 5), cap, fill=(214, 214, 226), font=F13)
y += PH + LBL

y = bar(y, 0, W, '② 底部那条常驻说明（「点击云朵可以戳一下 · 拖动旋转 · 滚轮缩放」）已去掉；'
                 '时相 / 滤镜 / 雾 三排按钮贴到左下角（bottom 78 → 30px）', (150, 255, 190))
canvas.paste(deskS, (0, y))
canvas.paste(mobS, (DW + GAP, y))
d.text((10, y + DH + 6), '桌面 1264×625 —— 左下角按钮贴底、与右下角「跳」同一条基线', fill=(214, 214, 226), font=F13)
d.text((DW + GAP + 10, y + DH + 6), '移动断点 500×605', fill=(214, 214, 226), font=F13)

canvas.save(OUT)
print('->', OUT, canvas.size)
