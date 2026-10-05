# -*- coding: utf-8 -*-
"""生成「相机焦点 + 漫游跳床 + 底部按钮下移」三合一的交付预览图。

三行：
  ① 默认焦点从「云里的一个点」改成「梯子中点」—— 两张整幅，画十字准星在正中心，
     一眼能看出准星是否落在梯子上。
  ② 漫游的跳床三帧（起跳 / 空中 / 落床），来自 tools/roam-leap.json 的实拍。
  ③ 左下角面板的前后裁剪（bottom 10 → 6px + 把快捷键小字挪到按钮上面）。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAM  = os.path.join(ROOT, 'shots', 'cam')
FIX  = os.path.join(ROOT, 'shots', 'fix')
LEAP = os.path.join(ROOT, 'shots', 'leap3')
OUT  = os.path.join(ROOT, 'preview-云端之梯-焦点与跳床与底部按钮.png')

BEFORE = os.path.join(CAM, 'cam-bed-free.png')          # 焦点 (1.5,11.5,-2)，面板 bottom:10
AFTER  = os.path.join(FIX, 'fix-1-自由-下午.png')        # 焦点 = ladderMid，面板 bottom:6

PANELS = [
    (os.path.join(LEAP, 'leap3-1-刚起跳.png'),  '起跳  u=0.28   竖直初速 +4.6 m/s，先上窜半米'),
    (os.path.join(LEAP, 'leap3-2-空中.png'),    '空中  u=0.63   vy −11.6 m/s，正对床面落下'),
    (os.path.join(LEAP, 'leap3-4-落在床上.png'), '落地  站在床垫上（foot = 床面 2.582），停留 2.6 秒'),
]

W   = 1360
GAP = 8
HDR, BAR, LBL = 44, 30, 26


def font(size):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


F18, F15, F13 = font(18), font(15), font(13)


def fit(im, w):
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


def crosshair(im, color=(255, 70, 140), r=22, arm=34):
    """在画面正中心画准星 —— 「焦点」到底是什么位置，这一下就看明白了。"""
    d = ImageDraw.Draw(im)
    cx, cy = im.width // 2, im.height // 2
    d.line([(cx - arm, cy), (cx + arm, cy)], fill=color, width=2)
    d.line([(cx, cy - arm), (cx, cy + arm)], fill=color, width=2)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=2)
    return im


canvas_w = W
H_TOP    = round(625 * ((W - GAP) / 2) / 1264)     # 两张整幅的高度
H_LEAP   = round(625 * ((W - 2 * GAP) / 3) / 1264)
CROP     = (0, 450, 400, 625)                      # 左下角面板那一片
CW       = (W - GAP) // 2
CH       = round((CROP[3] - CROP[1]) * CW / (CROP[2] - CROP[0]))

H = HDR + BAR + H_TOP + LBL + BAR + H_LEAP + LBL + BAR + CH + LBL + 10
canvas = Image.new('RGB', (canvas_w, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)


def bar(y, text, color, f=F15, bg=(26, 26, 34)):
    d.rectangle([0, y, canvas_w, y + BAR], fill=bg)
    d.text((12, y + (BAR - f.size) // 2), text, fill=color, font=f)
    return y + BAR


d.rectangle([0, 0, canvas_w, HDR], fill=(34, 30, 48))
d.text((12, 11), '云端之梯 · 默认焦点对准梯子中点 ＋ 漫游跳到床上 ＋ 底部按钮再下移',
       fill=(255, 226, 150), font=F18)

# ---- ① 焦点 ----
y = bar(0 + HDR, '① 默认相机的焦点：原来盯着梯子上方云里的一个点，现在盯着**梯子中点**（画面正中＝梯子中点）',
        (170, 225, 255))
b = crosshair(fit(Image.open(BEFORE).convert('RGB'), (W - GAP) // 2))
a = crosshair(fit(Image.open(AFTER).convert('RGB'), (W - GAP) // 2))
canvas.paste(b, (0, y))
canvas.paste(a, ((W - GAP) // 2 + GAP, y))
d.rectangle([0, y + H_TOP, W, y + H_TOP + LBL], fill=(20, 20, 26))
d.text((10, y + H_TOP + 6), '改动前  焦点 (1.5, 11.5, −2)：准星落在云里，梯子偏在准星左下', fill=(230, 200, 200), font=F13)
d.text(((W - GAP) // 2 + GAP + 10, y + H_TOP + 6), '改动后  焦点 "ladderMid" (0.975, 8.24, 1.55)：准星正好落在梯子中点',
       fill=(200, 240, 210), font=F13)
y += H_TOP + LBL

# ---- ② 跳床 ----
y = bar(y, '② 漫游：爬到梯顶 → 点右下「跳」 → 一条抛物线落到床上（原来停在顶端不动）', (150, 255, 190))
pw = (W - 2 * GAP) // 3
for i, (fn, cap) in enumerate(PANELS):
    x = i * (pw + GAP)
    canvas.paste(fit(Image.open(fn).convert('RGB'), pw), (x, y))
    d.rectangle([x, y + H_LEAP, x + pw, y + H_LEAP + LBL], fill=(20, 20, 26))
    d.text((x + 8, y + H_LEAP + 6), cap, fill=(214, 214, 226), font=F13)
y += H_LEAP + LBL

# ---- ③ 底部按钮 ----
y = bar(y, '③ 时相 / 滤镜 / 雾 三排按钮再往下压：bottom 10 → 6px，快捷键那行小字移到按钮上面（原来它在最底下，按钮被它顶着一行）',
        (255, 214, 150))
cb = fit(Image.open(BEFORE).convert('RGB').crop(CROP), CW)
ca = fit(Image.open(AFTER).convert('RGB').crop(CROP), CW)
canvas.paste(cb, (0, y))
canvas.paste(ca, (CW + GAP, y))
d.rectangle([0, y + CH, W, y + CH + LBL], fill=(20, 20, 26))
d.text((10, y + CH + 6), '改动前  bottom:10px —— 最底下一行是小字「1–4 时相 · 5–9 滤镜…」，按钮悬在它上面',
       fill=(230, 200, 200), font=F13)
d.text((CW + GAP + 10, y + CH + 6), '改动后  bottom:6px —— 最底下一行就是「雾」那一排按钮，小字挂到三排上面当图例',
       fill=(200, 240, 210), font=F13)

canvas.save(OUT)
print('->', OUT, canvas.size)
