#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成夜间投影用的 dreamcore 循环短片 video/night.mp4。

用法：
    python tools/make-night-video.py
产出：
    video/night.mp4  （8 秒、16fps、512×288、H.264、无音频）
"""

import os, math
import numpy as np
import imageio.v3 as iio

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'video', 'night.mp4')
W, H = 512, 288
FPS = 16
DUR = 8
FRAMES = FPS * DUR

# 中文字体：优先用系统自带，Windows 上 SimHei 基本一定有
FONTS = [
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
]
FONT = None
for f in FONTS:
    if os.path.exists(f):
        FONT = f
        break

# Pillow 只在需要字体时 import
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    raise SystemExit('需要 Pillow：pip install Pillow')

if FONT:
    font = ImageFont.truetype(FONT, 36)
    font_small = ImageFont.truetype(FONT, 16)
else:
    font = ImageFont.load_default()
    font_small = ImageFont.load_default()


def make_frame(t):
    """t 单位为秒，返回 RGB uint8 数组。"""
    # 在 RGBA 上画，每层用 alpha 混合，最后转 RGB
    base = Image.new('RGBA', (W, H), (11, 11, 24, 255))

    # 背景渐变
    grad = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(H):
        k = y / H
        r = int(11 + (19 - 11) * k)
        g = int(11 + (20 - 11) * k)
        b = int(24 + (16 - 24) * k)
        gdraw.line([(0, y), (W, y)], fill=(r, g, b, 255))
    base = Image.alpha_composite(base, grad)

    flicker = 0.88 + 0.12 * math.sin(t * 7.3) + 0.07 * math.sin(t * 13.7)

    # 中央柔光色块
    cx = W / 2 + W * 0.12 * math.sin(t * 0.42)
    cy = H / 2 + H * 0.09 * math.cos(t * 0.55)
    rr = min(W, H) * (0.30 + 0.03 * math.sin(t * 0.8))

    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(int(rr), 0, -2):
        alpha = int(200 * (1 - i / rr) * flicker * 0.35)
        if alpha < 2:
            continue
        # 中心暖紫，边缘冷蓝
        rr_c = int(210 * (1 - i / rr))
        gg_c = int(180 * (1 - i / rr))
        bb_c = int(255 * (1 - i / rr))
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(rr_c, gg_c, bb_c, alpha))
    base = Image.alpha_composite(base, glow)

    # 漂移文字
    txt = "梦 核 电 影"
    tmp = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    bbox = td.textbbox((0, 0), txt, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = W / 2 - tw / 2
    ty = H / 2 + H * 0.16 - th / 2 + int(3 * math.sin(t * 0.7))
    td.text((tx + 2, ty + 2), txt, font=font, fill=(40, 35, 60, int(120 * flicker)))
    td.text((tx, ty), txt, font=font, fill=(235, 225, 255, int(150 * flicker)))
    base = Image.alpha_composite(base, tmp)

    # 扫描线
    scan = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scan)
    for y in range(0, H, 3):
        sd.line([(0, y), (W, y)], fill=(0, 0, 0, int(18 * flicker)))
    base = Image.alpha_composite(base, scan)

    # 胶片颗粒
    np.random.seed(int(t * 1000) % (2**31))
    noise = np.random.rand(H, W)
    mask = noise > (1 - 0.12 * flicker)
    ys, xs = np.where(mask)
    grain = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd2 = ImageDraw.Draw(grain)
    for x, y in zip(xs, ys):
        a = int(noise[y, x] * 45 * flicker)
        gd2.point((int(x), int(y)), fill=(255, 255, 255, a))
    base = Image.alpha_composite(base, grain)

    # 暗角
    vig = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vig)
    for i in range(int(W * 0.78), int(W * 0.30), -4):
        alpha = int(255 * max(0, (i - W * 0.30) / (W * 0.48)))
        vd.ellipse([W / 2 - i, H / 2 - i, W / 2 + i, H / 2 + i],
                   outline=(0, 0, 0, min(alpha, 210)))
    base = Image.alpha_composite(base, vig)

    # 底部状态栏小字
    info = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    idraw = ImageDraw.Draw(info)
    st = "PLAY ▶  NIGHT  00:{:02d}".format(int(t) % 60)
    idraw.text((W - 155, H - 28), st, font=font_small, fill=(200, 200, 220, 140))
    base = Image.alpha_composite(base, info)

    # 转 RGB
    rgb = base.convert('RGB')
    return np.array(rgb)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    frames = []
    print(f"生成 {FRAMES} 帧 {W}×{H} @ {FPS}fps ...")
    for i in range(FRAMES):
        t = i / FPS
        frames.append(make_frame(t))
    print(f"写入 {OUT} ...")
    # imageio v3 写 mp4：用 imageio-ffmpeg 插件
    iio.imwrite(OUT, frames, fps=FPS, codec='libx264', quality=7)
    size = os.path.getsize(OUT)
    print(f"完成：{OUT}  {size / 1024:.1f} KB")


if __name__ == '__main__':
    main()
