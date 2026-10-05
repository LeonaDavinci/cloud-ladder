# -*- coding: utf-8 -*-
"""给小红书笔记出 3:4 配图（1080×1440）。

三张：
  1-封面.png      下午档原图 + 底部渐变 + 主标题
  2-四档时相.png   2×2 网格，每格带档位标签
  3-夜景.png      夜间档 + 底部一行小字

素材是 headless-interact.mjs 截的竖版原图（VP_W=1080 VP_H=1440 视口、
?ui=0 收起 UI）。原图底部中央有个「显示 UI」按钮，统一用渐变或裁切处理掉。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")
OUT = os.path.join(ROOT, "xhs")
os.makedirs(OUT, exist_ok=True)

W, H = 1080, 1440
BOLD = "C:/Windows/Fonts/msyhbd.ttc"
REG = "C:/Windows/Fonts/msyh.ttc"
INK = (18, 12, 36)          # 渐变底色（夜紫黑）


def font(size, bold=True):
    return ImageFont.truetype(BOLD if bold else REG, size)


def load(name):
    return Image.open(os.path.join(SHOTS, name)).convert("RGB")


def vgrad(img, y0, y1, color=INK, a0=0.0, a1=0.94):
    """从 y0 到 y1 竖直渐变（透明→color，a1 为终值不透明度）"""
    a = np.asarray(img).astype(np.float32)
    h = a.shape[0]
    t = np.clip((np.arange(h, dtype=np.float32) - y0) / max(1.0, y1 - y0), 0, 1)
    alpha = (a0 + (a1 - a0) * t)[:, None, None]
    col = np.array(color, np.float32)[None, None, :]
    return Image.fromarray((a * (1 - alpha) + col * alpha).clip(0, 255).astype(np.uint8))


def text(d, xy, s, f, fill, spacing=0):
    """带可选字距的绘制（中文大标题加一点字距更好看）"""
    x, y = xy
    if not spacing:
        d.text((x, y), s, font=f, fill=fill)
        return
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + spacing


def cover():
    img = load("_xhs-1-afternoon.png")
    # 底部：930→1010 快速过渡到 92% 深色，1000 以下保持恒定。
    # （缓渐变会在草地上留下一片发灰的雾，白字压上去像没擦干净；
    #   而且原图底部中央那个「显示 UI」按钮必须被 92% 的深色压掉。）
    img = vgrad(img, 930, 1010, a0=0.0, a1=0.92)
    d = ImageDraw.Draw(img)
    x = 76
    text(d, (x, 1022), "小红书 vibecoding 大赛 · vibe art 赛道", font(24, False), (206, 176, 244))
    text(d, (x, 1066), "我把一张床", font(62), (255, 255, 255), spacing=2)
    text(d, (x, 1138), "搬到了云边上", font(62), (255, 236, 250), spacing=2)
    text(d, (x, 1230), "床边架了一架 12.9 米的梯子", font(29, False), (226, 214, 244))
    text(d, (x, 1274), "一直伸进云里", font(29, False), (226, 214, 244))
    text(d, (x, 1358), "《云端之梯 · 梦核》", font(27), (255, 214, 236), spacing=1)
    img.save(os.path.join(OUT, "1-封面.png"))
    print("1-封面.png")


def four_phases():
    """2×2：每格 540×720 = 图 540×646 + 标签带 540×74"""
    CW, CH, LBL = 540, 646, 74
    items = [("_xhs-1-afternoon.png", "① 下午 · 云是粉紫色的"),
             ("_xhs-2-dawn.png", "② 清晨 · 大雾，太阳在雾里"),
             ("_xhs-3-sunset.png", "③ 日落 · 暖粉，光从左边斜进来"),
             ("_xhs-4-night.png", "④ 夜间 · 深蓝星空 + 月亮")]
    canvas = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(canvas)
    for i, (fn, label) in enumerate(items):
        img = load(fn).crop((0, 0, W, 1440 - 190)).resize((CW, CH), Image.LANCZOS)
        cx, cy = (i % 2) * CW, (i // 2) * (CH + LBL)
        canvas.paste(img, (cx, cy))
        d.rectangle([cx, cy + CH, cx + CW, cy + CH + LBL], fill=INK)
        d.text((cx + 22, cy + CH + 22), label, font=font(23, False), fill=(232, 220, 248))
    # 四格之间留一道细线，别糊成一片
    d.rectangle([CW - 2, 0, CW, H], fill=(60, 44, 92))
    d.rectangle([0, CH + LBL - 2, W, CH + LBL], fill=(60, 44, 92))
    canvas.save(os.path.join(OUT, "2-四档时相.png"))
    print("2-四档时相.png")


def night():
    img = load("_xhs-4-night.png")
    # 夜图本来就暗，但要盖掉底部的「显示 UI」按钮，还是得把最后 250px 压到 95%
    img = vgrad(img, 1150, 1260, a0=0.0, a1=0.95)
    d = ImageDraw.Draw(img)
    text(d, (76, 1288), "夜里云会自己亮起来，像吸饱了月光", font(29, False), (232, 224, 250))
    text(d, (76, 1338), "《云端之梯 · 梦核》", font(25), (255, 214, 236), spacing=1)
    img.save(os.path.join(OUT, "3-夜景.png"))
    print("3-夜景.png")


def workflow():
    """白模 / 线框 / 成品 三段并置 —— 讲「这是代码渲染的场景」，不是一张画。

    上排一格 540×720，下排一格 1080×720（成品图裁中间 720 高，床和云都在里面）。
    """
    canvas = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(canvas)
    # 上排：白模 | 线框
    for i, fn in enumerate(["_xhs-6-clay.png", "_xhs-7-wire.png"]):
        canvas.paste(load(fn).resize((540, 720), Image.LANCZOS), (i * 540, 0))
    # 下排：成品（下午档，裁掉上下各 360）
    canvas.paste(load("_xhs-1-afternoon.png").crop((0, 360, W, 1080)), (0, 720))
    tag = font(24)
    for (x, y), s in [((28, 28), "① 白模 · 搭形体"), ((568, 28), "② 线框 · 理布线"),
                      ((28, 748), "③ 上色 / 光 / 雾 / 云 —— 全部由代码算出")]:
        tw = d.textlength(s, font=tag)
        d.rounded_rectangle([x - 14, y - 10, x + tw + 14, y + 38], radius=14, fill=(12, 8, 26))
        d.text((x, y), s, font=tag, fill=(240, 232, 252))
    canvas.save(os.path.join(OUT, "4-白模线框成品.png"))
    print("4-白模线框成品.png")


if __name__ == "__main__":
    cover()
    four_phases()
    night()
    workflow()
    for f in sorted(os.listdir(OUT)):
        print("  ", f, os.path.getsize(os.path.join(OUT, f)) // 1024, "KiB")
