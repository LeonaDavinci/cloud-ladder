# -*- coding: utf-8 -*-
"""生成「云端之梯 → 小红书小工具 zip」的打包对照预览图。

排版（两行两列）：
   第 1 行：源码（ES module）  ｜  产物（经典脚本 + 内联数据）
   第 2 行：产物用 file:// 打开 ｜ 右侧留白写「为什么值得信这组数字」

三张底图来自 tools/minitool-frozen-bar2.json（固定随机种子 + 冻结时钟 +
禁用 CSS 动画），所以三张之间是**可以逐像素比**的：
   shots/_d-src.png        源码 index.html（走 importmap + type=module）
   shots/_d-dist-http.png  dist-minitool/index.html（走 http）
   shots/_d-dist-file.png  dist-minitool/index.html（走 file://，离线真实路径）
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = lambda *p: os.path.join(ROOT, 'shots', *p)
OUT = os.path.join(ROOT, 'preview-云端之梯-小工具打包.png')

CELL_W = 620                 # 每格图缩到多宽
HDR, BAR, GAP, ROWGAP = 36, 30, 12, 12


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
    ('读数逐项相同', (255, 214, 130)),
    ('scene.children 23 · bed 网格 11（两条路都成功）', (215, 215, 225)),
    ('云片 360 · 梯长 12.9 · 无草区 4.83 × 3.66', (215, 215, 225)),
    ('曲目 3 首 · window.__errs 为空', (215, 215, 225)),
    ('三张图两两逐像素相同（差异像素 0）', (150, 255, 190)),
    ('', None),
    ('资源这次是「原样进包」', (255, 214, 130)),
    ('models/bed2.glb.xml 进包 → via "file"', (215, 215, 225)),
    ('audio/*.mp3.xml 三首，文件名一个字符没改', (215, 215, 225)),
    ('bgm-1 33.3s / bgm-2 13.24s / bgm-3 194s 全可播', (215, 215, 225)),
    ('file:// 下 fetch 被拒 → 自动退回内联副本', (150, 255, 190)),
    ('（via "inline" · Failed to fetch · 画面仍是 0 差异）', (150, 255, 190)),
    ('两条路世界尺寸都是 4.7 × 2.25 × 3.4', (215, 215, 225)),
    ('', None),
    ('为什么敢说「一致」', (255, 214, 130)),
    ('JS 侧只做机械改造：ESM→IIFE+注册表、', (215, 215, 225)),
    ('fetch→内联常量、audio crossOrigin 去掉；', (215, 215, 225)),
    ('模型这次是「文件优先、内联兜底」，', (215, 215, 225)),
    ('渲染路径一行没动。脚本对每处预期片段', (215, 215, 225)),
    ('都带断言，找不到就 BUILD FAIL。', (215, 215, 225)),
    ('', None),
    ('未达标项（见审计报告）', (255, 160, 160)),
    ('· zip 3.88 MiB，超建议值 2 MiB（未超 10 MiB）', (255, 190, 190)),
    ('  音频 2.46 MiB=63% + 模型 0.59 MiB +', (255, 190, 190)),
    ('  内联兜底 0.78 MiB（确认容器可读本地文件', (255, 190, 190)),
    ('  后可用 --no-bed-fallback 省掉）', (255, 190, 190)),
    ('· 只有一次性机型降档，缺运行时逐级降档', (255, 190, 190)),
    ('· Chrome 61 真机未实测', (255, 190, 190)),
]

src = load(S('_d-src.png'), CELL_W)
dhttp = load(S('_d-dist-http.png'), CELL_W)
dfile = load(S('_d-dist-file.png'), CELL_W)

CH = src.height
W = CELL_W * 2 + GAP
LINE_H = 19
NOTE_H = len(notes) * LINE_H + 30      # +30 = 顶部 8 + 末行基线余量
ROW2_H = max(BAR + CH, NOTE_H)          # 第 2 行右侧要放得下整段说明
H = HDR + (BAR + CH) + ROWGAP + ROW2_H + ROWGAP
canvas = Image.new('RGB', (W, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)

d.rectangle([0, 0, W, HDR], fill=(34, 30, 48))
d.text((12, 9), '云端之梯 → 小红书小工具：产物与原版逐像素一致（1264×625，固定种子 + 冻结时钟 + 禁动画）',
       fill=(255, 226, 150), font=F)

# ---------- 第 1 行 ----------
y = HDR
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '原版：importmap + type=module + 6 个 ES 模块 + fetch(scene.json)', fill=(170, 225, 255), font=FS)
canvas.paste(src, (0, y + BAR))
d.rectangle([CELL_W + GAP, y, W, y + BAR], fill=(26, 26, 34))
d.text((CELL_W + GAP + 10, y + 8), '产物：9 个经典 <script src>，数据内联，模型/音频原样进包', fill=(150, 255, 190), font=FS)
canvas.paste(dhttp, (CELL_W + GAP, y + BAR))

# ---------- 第 2 行 ----------
y += BAR + CH + ROWGAP
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '产物：file:// 直接打开（容器离线加载的真实路径）', fill=(170, 225, 255), font=FS)
canvas.paste(dfile, (0, y + BAR))

tx = CELL_W + GAP + 10
ny = y + BAR + 8
for text, color in notes:
    if color:
        d.text((tx, ny), text, fill=color, font=FS)
    ny += LINE_H

canvas.save(OUT)
print('->', OUT, canvas.size)
