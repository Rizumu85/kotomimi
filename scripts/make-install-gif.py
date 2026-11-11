"""Fork: the picture the Windows installer shows while it installs (`loadingGif` in forge.config.js).

    python scripts/make-install-gif.py

Squirrel shows it at its own size, in a borderless window that lets its transparent pixels through. The card is the
app's dark scheme (`src/styles/theme.scss`): the icon breathing, the name, and the accent's bars moving as a voice
heard does. Written to assets/install.gif.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 360, 200
S = 3  # drawn at three times the size, then reduced, for smooth edges
RADIUS = 14
BG = (26, 26, 26)          # bg-base
BORDER = (46, 46, 46)
TEXT = (255, 255, 255)     # text-primary
ACCENT = (15, 187, 143)    # primary
DIM = (52, 70, 64)
FRAMES = 36
FRAME_MS = 50
BARS = 17
BAR_W, BAR_GAP = 3, 4
FONT = pathlib.Path('C:/Windows/Fonts/seguisb.ttf')

icon = Image.open(ROOT / 'assets' / 'icon.png').convert('RGBA')
font = ImageFont.truetype(str(FONT), 22 * S)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def frame(i):
    t = i / FRAMES
    big = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle((0, 0, W * S - 1, H * S - 1), RADIUS * S, fill=BG + (255,), outline=BORDER + (255,), width=S)

    # The icon, breathing: a little taller and narrower, then back, its foot kept where it stands.
    breath = math.sin(2 * math.pi * t)
    size = 64 * S
    w = round(size * (1 - 0.015 * breath))
    h = round(size * (1 + 0.025 * breath))
    foot = 100 * S
    big.alpha_composite(icon.resize((w, h), Image.LANCZOS), ((W * S - w) // 2, foot - h))

    name = 'Kotomimi'
    box = d.textbbox((0, 0), name, font=font)
    d.text(((W * S - (box[2] - box[0])) // 2 - box[0], 112 * S - box[1]), name, font=font, fill=TEXT + (255,))

    # The bars: a wave passing along them, highest in the middle of the row.
    total = BARS * BAR_W + (BARS - 1) * BAR_GAP
    left = (W - total) / 2
    mid = 166
    for b in range(BARS):
        x = left + b * (BAR_W + BAR_GAP)
        place = b / (BARS - 1)
        envelope = math.exp(-((place - 0.5) ** 2) / 0.08)
        # Two waves, at whole turns a loop so it joins: one passing along, one back, as speech rises and falls.
        wave = 0.5 + 0.3 * math.sin(2 * math.pi * (t * 2 - place * 1.5)) + 0.2 * math.sin(2 * math.pi * (t * 3 + place * 2.3))
        lift = envelope * (0.35 + 0.65 * wave)
        half = 2 + 9 * lift
        colour = mix(DIM, ACCENT, min(1, 0.25 + lift))
        d.rounded_rectangle((x * S, (mid - half) * S, (x + BAR_W) * S, (mid + half) * S), BAR_W * S / 2, fill=colour + (255,))

    small = big.resize((W, H), Image.LANCZOS)
    # One bit of transparency: the corners' half-covered pixels take the card's colour, the rest are cut away.
    alpha = small.getchannel('A')
    solid = Image.new('RGBA', (W, H), BG + (255,))
    solid.alpha_composite(small)
    solid.putalpha(alpha.point(lambda a: 255 if a >= 96 else 0))
    return solid


def main():
    frames = [frame(i) for i in range(FRAMES)]
    # One palette for every frame, so nothing flickers; index 255 is the transparent one.
    sheet = Image.new('RGB', (W, H * 4))
    for k, f in enumerate(frames[:: FRAMES // 4][:4]):
        sheet.paste(f.convert('RGB'), (0, H * k))
    palette = sheet.quantize(colors=255, method=Image.MEDIANCUT)
    out = []
    for f in frames:
        q = f.convert('RGB').quantize(palette=palette, dither=Image.NONE)
        q.paste(255, mask=f.getchannel('A').point(lambda a: 255 if a == 0 else 0))
        out.append(q)
    target = ROOT / 'assets' / 'install.gif'
    out[0].save(target, save_all=True, append_images=out[1:], duration=FRAME_MS, loop=0, transparency=255, disposal=2, optimize=False)
    print(target, target.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
