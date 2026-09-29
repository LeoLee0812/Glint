# 生成 macOS 菜单栏小图标（template 图：只有黑色 + 透明度，系统按深浅色菜单栏自动反色）
# 用法：python3 scripts/make-tray-icon.py  → resources/tray/*.png
# 造型：杏仁眼 + 实心瞳孔，瞳孔右上角抠出一颗四角星高光，就是「Glint」那一下闪光
import math
from PIL import Image, ImageDraw

SS = 16  # 超采样倍数，画大了再缩，边缘才平滑
OUT = 'resources/tray'


def star(cx, cy, r, inner):
    pts = []
    for i in range(8):
        a = math.pi / 4 * i - math.pi / 2
        rr = r if i % 2 == 0 else inner
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def lid(sign, x0, x1, cy, h, n=64):
    return [(x0 + (x1 - x0) * t, cy + sign * h * math.sin(math.pi * t)) for t in (i / n for i in range(n + 1))]


def draw(size, kind):
    s = size * SS
    u = s / 18  # 以 18pt 为设计网格
    im = Image.new('L', (s, s), 0)
    d = ImageDraw.Draw(im)
    w = round(1.6 * u)
    if kind == 'on':
        top = lid(-1, 1.2 * u, 16.8 * u, 9 * u, 6.2 * u)
        bot = lid(1, 1.2 * u, 16.8 * u, 9 * u, 6.2 * u)
        d.line(top, fill=255, width=w, joint='curve')
        d.line(bot, fill=255, width=w, joint='curve')
        for p in (top[0], top[-1]):
            d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=255)
        r = 3.6 * u
        d.ellipse([9 * u - r, 9 * u - r, 9 * u + r, 9 * u + r], fill=255)
        d.polygon(star(10.3 * u, 7.7 * u, 2.1 * u, 0.55 * u), fill=0)
    else:
        # 闭眼：一道下弧 + 三根睫毛，表示眼动暂停
        arc = lid(1, 1.8 * u, 16.2 * u, 7.5 * u, 4.2 * u)
        d.line(arc, fill=255, width=w, joint='curve')
        for p in (arc[0], arc[-1]):
            d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=255)
        for t, dx in ((0.25, -1.2), (0.5, 0), (0.75, 1.2)):
            x = 1.8 * u + 14.4 * u * t
            y = 7.5 * u + 4.2 * u * math.sin(math.pi * t)
            d.line([(x, y), (x + dx * u, y + 2.6 * u)], fill=255, width=w)
    a = im.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.putalpha(a)
    return out


for kind, name in (('on', 'trayTemplate'), ('off', 'trayOffTemplate')):
    draw(18, kind).save(f'{OUT}/{name}.png')
    draw(36, kind).save(f'{OUT}/{name}@2x.png')
print('ok')
