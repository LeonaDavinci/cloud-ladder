"""把 shots/g-*.png 拼成对照预览图（带中文标签）。
字体从 Windows 字体目录挑一个可用的中文字体。"""
import os
from PIL import Image, ImageDraw, ImageFont

SH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'shots')
OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FONTS = [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\msyhbd.ttc',
         r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\Deng.ttf',
         r'C:\Windows\Fonts\simsun.ttc']


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                pass
    return ImageFont.load_default()


def grid(items, cols, cw, ch, label_h, title, path, bg=(18, 14, 30)):
    rows = (len(items) + cols - 1) // cols
    W = cols * cw + (cols + 1) * 12
    H = 64 + rows * (ch + label_h + 12) + 12
    canvas = Image.new('RGB', (W, H), bg)
    d = ImageDraw.Draw(canvas)
    d.text((20, 18), title, font=font(26), fill=(255, 232, 248))
    for i, (name, cap) in enumerate(items):
        r, c = divmod(i, cols)
        x = 12 + c * (cw + 12)
        y = 64 + r * (ch + label_h + 12)
        im = Image.open(os.path.join(SH, 'g-%s.png' % name)).convert('RGB')
        im = im.resize((cw, ch), Image.LANCZOS)
        canvas.paste(im, (x, y))
        d.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(90, 70, 130), width=1)
        d.text((x + 2, y + ch + 6), cap, font=font(19), fill=(240, 220, 245))
    canvas.save(os.path.join(OUT, path))
    print('wrote', path, canvas.size)


# ① 时相四档（都用「梦境柔光」滤镜）
grid([('afternoon-dream', '① 下午 · 原样（回归基准）'),
      ('dawn-dream',      '② 清晨 · 大雾 + 低垂的太阳'),
      ('sunset-dream',    '③ 日落 · 暖粉天 + 左上山脊落日'),
      ('night-dream',     '④ 夜间 · 深蓝星空 + 月亮')],
     2, 620, 307, 30, '云端之梯 · 时相四档', 'preview-云端之梯-时相四档.png')

# ② 梦核滤镜（都在「下午」档下比较，bloom 在亮场景里最看得出来）
grid([('afternoon-dream', '梦境柔光 dream'),
      ('liminal',         '阈限泳池 liminal'),
      ('vhs',             '模糊录像带 vhs'),
      ('white',           '过曝白梦 white'),
      ('off',             '原片 off（旁路 composer）'),
      ('fog-heavy',       '外加：日落 + 超大雾「啪一下」')],
     3, 480, 237, 30, '云端之梯 · 梦核滤镜五档 + 雾档', 'preview-云端之梯-梦核滤镜.png', bg=(16, 12, 26))
