# -*- coding: utf-8 -*-
"""生成「底部正中新增『切换 UI』开关」的预览图。

排版（两行，每行一条横幅说明 + 图）：
   第 1 行：桌面 1264×625 的「点击前 / 点击后」并排
   第 2 行：窄屏 500×749 的「步行(可见) / 收起」并排，右侧留白写测量结论

四张底图分别来自：
   tools/ui-hide-check.json   —— 同一次加载内「可见 → 收起 → 还原」，各拍一张
                                 （跨图有草的摆动，只作视觉说明，不是逐像素对照）
   tools/ui-hide-mobile.json  —— CHROME_ARGS_EXTRA="--window-size=390,844" 触发 max-width:520px 断点
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = lambda *p: os.path.join(ROOT, 'shots', *p)
OUT = os.path.join(ROOT, 'preview-云端之梯-隐藏UI.png')

DESK_W = 620                 # 桌面图缩到多宽
MOB_W = 300                  # 窄屏图缩到多宽
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


def fitw(im, w):
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


def load(p, w):
    return fitw(Image.open(p).convert('RGB'), w)


d_before = load(S('ui-hide-1-visible.png'), DESK_W)
d_after  = load(S('ui-hide-2-hidden.png'), DESK_W)
m_before = load(S('ui-hide-m2-walk.png'), MOB_W)
m_after  = load(S('ui-hide-m3-hidden.png'), MOB_W)

CH1 = d_before.height            # 第 1 行图高
CH2 = m_before.height            # 第 2 行图高
W = DESK_W * 2 + GAP
H = HDR + (BAR + CH1) + ROWGAP + (BAR + CH2) + ROWGAP
canvas = Image.new('RGB', (W, H), (14, 14, 18))
d = ImageDraw.Draw(canvas)

d.rectangle([0, 0, W, HDR], fill=(34, 30, 48))
d.text((12, 9), '云端之梯 · 底部正中新增「切换 UI」：一键收起 / 还原界面上除标题外的所有按钮',
       fill=(255, 226, 150), font=F)

# ---------- 第 1 行：桌面 ----------
y = HDR
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '点击前（桌面 1264×625）：四角各就各位，正中新增「隐藏 UI」',
       fill=(170, 225, 255), font=FS)
canvas.paste(d_before, (0, y + BAR))
d.rectangle([DESK_W + GAP, y, W, y + BAR], fill=(26, 26, 34))
d.text((DESK_W + GAP + 10, y + 8), '点击后：只剩「云端之梯 #梦核」与开关本身，'
                                   '开关文案变成「显示 UI」并压暗到 40%', fill=(150, 255, 190), font=FS)
canvas.paste(d_after, (DESK_W + GAP, y + BAR))

# ---------- 第 2 行：窄屏 ----------
y += BAR + CH1 + ROWGAP
d.rectangle([0, y, W, y + BAR], fill=(26, 26, 34))
d.text((10, y + 8), '窄屏 500×749（步行模式）：开关 [212,708,288,737] 与「跳」[412,657,484,729] '
                    '竖直重叠、横向 288<412 完全让开', fill=(170, 225, 255), font=FS)
canvas.paste(m_before, (0, y + BAR))
d.rectangle([MOB_W + GAP, y, W, y + BAR], fill=(26, 26, 34))
d.text((MOB_W + GAP + 10, y + 8), '窄屏收起后：同样只剩标题与开关（断点、三排面板、摇杆层一起收干净）',
       fill=(150, 255, 190), font=FS)
canvas.paste(m_after, (MOB_W + GAP, y + BAR))

# 第 2 行右侧留白：写测量结论
tx = MOB_W * 2 + GAP * 2 + 16
notes = [
    ('怎么实现的', (255, 214, 130)),
    ('给 <body> 挂一个 .ui-hidden 类，CSS 一次性覆盖', (215, 215, 225)),
    ('#modes / #scene-ui / #jump-btn / #bgm / #mode-hint', (215, 215, 225)),
    ('/ #sticks / 标题下那行小字 —— 一律 display:none。', (215, 215, 225)),
    ('不逐个改 style.display：那些元素的显隐各有各的主', (215, 215, 225)),
    ('（#jump-btn 靠 .on、#mode-hint 靠内联 opacity、按钮靠', (215, 215, 225)),
    (' .active），直接写 display 会跟它们打架。挂类则逻辑', (215, 215, 225)),
    ('照旧切、状态不丢，摘掉就是原样。', (215, 215, 225)),
    ('', None),
    ('还留了三条路', (255, 214, 130)),
    ('· 快捷键 H 开关；收起后 1–4 / 5–9 / F / 空格仍有效', (215, 215, 225)),
    ('  （隐藏的是显示，不是能力）', (215, 215, 225)),
    ('· URL ?ui=0 开场即收起，方便截图与分享', (215, 215, 225)),
    ('· 开关自己不隐藏，只压暗 —— 否则没有恢复的入口', (215, 215, 225)),
    ('', None),
    ('实测：收起↔还原后所有 display 值与收起前逐项相同，', (150, 255, 190)),
    ('漫游下 #jump-btn 走 grid → none → grid，window.__errs 为空。', (150, 255, 190)),
]
ny = y + BAR + 10
for text, color in notes:
    if color:
        d.text((tx, ny), text, fill=color, font=FS)
    ny += 20

canvas.save(OUT)
print('->', OUT, canvas.size)
