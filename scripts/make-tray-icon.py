# 生成 macOS 菜单栏小图标（template 图：只有黑色 + 透明度，系统按深浅色菜单栏自动反色）
# 和 Windows 的托盘图标、应用图标（Windows 任务栏不会给模板图反色，托盘用彩色圆角小方块 + 白色眼睛）
# 用法：python3 scripts/make-tray-icon.py [mac] [win]（不带参数两套都出）
#   mac → resources/tray/*.png；win → resources/tray/win*.ico、resources/icon.ico
# 造型：杏仁眼 + 实心瞳孔，瞳孔右上角抠出一颗四角星高光，就是「Glint」那一下闪光
import math
import sys
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


WHICH = sys.argv[1:] or ['mac', 'win']

if 'mac' in WHICH:
    for kind, name in (('on', 'trayTemplate'), ('off', 'trayOffTemplate')):
        draw(18, kind).save(f'{OUT}/{name}.png')
        draw(36, kind).save(f'{OUT}/{name}@2x.png')

# ---------- Windows ----------
# 托盘：眼动在跑 = Joy-Con 电光蓝方块，停了 = 灰方块；各缩放比例（100%~300%）要的尺寸都放进一个 ico
TILE = {'on': (10, 185, 230), 'off': (142, 142, 147)}
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64]


def win_tray(size, kind):
    s = size * SS
    tile = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, s - 1, s - 1], radius=round(s * 0.24), fill=TILE[kind] + (255,))
    tile = tile.resize((size, size), Image.LANCZOS)
    # 眼睛占方块的八成，白色（draw() 自己超采样，直接按最终像素画）
    g = max(1, round(size * 0.8))
    white = Image.new('RGBA', (g, g), (255, 255, 255, 255))
    white.putalpha(draw(g, kind).getchannel('A'))
    off = (size - g) // 2
    tile.alpha_composite(white, (off, off))
    return tile


if 'win' in WHICH:
    for kind, name in (('on', 'winOn'), ('off', 'winOff')):
        frames = [win_tray(n, kind) for n in ICO_SIZES]
        frames[-1].save(f'{OUT}/{name}.ico', sizes=[(n, n) for n in ICO_SIZES], append_images=frames[:-1])

    # 应用图标：Mac 的 1024 图四周留了一圈透明边（macOS 规范），Windows 图标一般铺满，裁掉多余的边再出各尺寸
    src = Image.open('resources/icon-1024.png').convert('RGBA')
    l, t, r, b = src.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    pad = round((r - l) * 0.03)
    side = max(r - l, b - t) + 2 * pad
    cx, cy = (l + r) // 2, (t + b) // 2
    app = src.crop((cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side))
    app_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    app.resize((256, 256), Image.LANCZOS).save('resources/icon.ico', sizes=[(n, n) for n in app_sizes])
print('ok')
