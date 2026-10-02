"""Thumbnails and vertical covers from a frame of the film: the frame (a gentle punch-in, at most 1.15x, never a crop
that cuts the subject), the title in big type on the darkest side, a small label under it, and a soft halo behind the
type so it holds over snow, sky or fog.

  python tools/thumbnail.py 34.5 "BIG" "TITLE" [--punch 1.12] [--size 176] [--name NAME] [--label VISUALIZER]
      renders that frame through the dev harness if it isn't there (dev/out/thumb/), writes NAME.jpg and .png (1280x720)
      with phone-size and 12 % copies in dev/out/thumb/; --final writes final/<slug>-thumbnail.jpg
  --vertical: the 9:16 cover (1080x1920) from the vertical layout, no punch-in, the title left-aligned, clear of the
      right-hand buttons and the bottom caption area of Shorts and Reels; --final writes final/<slug>-vertical-cover.jpg
  --ink dark: charcoal type in a pale halo with a deeper amber label, for a pale frame (fog, snow, paper)
  The font is fonts.thumbnail in visualizer.json (a bold condensed face reads best at phone size).
  Look at the -phone and -12pct copies: that's the size most people will see it at.
"""
import argparse, pathlib, subprocess, sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
CFG = project.load()
if not CFG["fonts"].get("thumbnail"):
    sys.exit("set fonts.thumbnail in visualizer.json to a TTF or OTF file first (a bold condensed face)")
FONT = str(project.path(CFG["fonts"]["thumbnail"]))
CREAM = (246, 239, 216, 255)
AMBER = (255, 176, 84, 255)

ap = argparse.ArgumentParser()
ap.add_argument("--label", default="VISUALIZER")
ap.add_argument("time", type=float)
ap.add_argument("lines", nargs="+")
ap.add_argument("--punch", type=float, default=1.12)
ap.add_argument("--size", type=int, default=176)
ap.add_argument("--right", type=int, default=1830)
ap.add_argument("--top", type=int, default=250)
ap.add_argument("--name", default=None)
ap.add_argument("--final", action="store_true")
ap.add_argument("--vertical", action="store_true")
ap.add_argument("--ink", choices=["light", "dark"], default="light")
a = ap.parse_args()
if a.ink == "dark":
    CREAM, AMBER, HALO = (40, 42, 50, 255), (186, 104, 28, 255), (250, 248, 242, 190)
else:
    HALO = (4, 6, 14, 200)
assert a.punch <= 1.15, "no punch-in past 1.15x"
track = ROOT
a.slug = CFG["slug"]
if a.vertical:
    frame = track / "dev/out/thumb" / f"frame_v_{a.time:07.3f}.png"
    if not frame.exists():
        subprocess.run([sys.executable, "dev/shot.py", "--out", "thumb", "--aspect", "v", str(a.time)], cwd=track, check=True)
    img = Image.open(frame).convert("RGB")
    big = ImageFont.truetype(FONT, a.size)
    small = ImageFont.truetype(FONT, round(a.size * 0.3))
    x0 = 84
    ys = [a.top + i * round(a.size * 0.88) for i in range(len(a.lines))]
    lab_y = ys[-1] + round(a.size * 1.12)

    def draw_v(d, fill, off=(0, 0)):
        for ln, y in zip(a.lines, ys):
            d.text((x0 + off[0], y + off[1]), ln, font=big, fill=fill)
        d.text((x0 + off[0], lab_y + off[1]), a.label, font=small, fill=fill if fill[3] < 255 else AMBER)

    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_v(ImageDraw.Draw(shadow), HALO, (0, 6))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base = Image.alpha_composite(img.convert("RGBA"), shadow)
    txt = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_v(ImageDraw.Draw(txt), CREAM)
    out = Image.alpha_composite(base, txt).convert("RGB")
    name = f"{a.slug}-vertical-cover" if a.final else (a.name or f"cand-v-{a.time:07.3f}")
    dst = track / ("final" if a.final else "dev/out/thumb")
    dst.mkdir(parents=True, exist_ok=True)
    out.save(dst / f"{name}.jpg", quality=92)
    out.resize((180, 320), Image.LANCZOS).save(track / "dev/out/thumb" / f"{name}-phone.png")
    print(dst / f"{name}.jpg")
    sys.exit(0)
frame = track / "dev/out/thumb" / f"frame_h_{a.time:07.3f}.png"
if not frame.exists():
    subprocess.run([sys.executable, "dev/shot.py", "--out", "thumb", str(a.time)], cwd=track, check=True)
src = Image.open(frame).convert("RGB")
W, H = src.size
# punch in toward the picture, as far left as the frame allows, so the title has the dark glass on the right
cw, ch = int(W / a.punch), int(H / a.punch)
x0 = W - cw
img = src.crop((x0, 0, x0 + cw, ch)).resize((1920, 1080), Image.LANCZOS)

big = ImageFont.truetype(FONT, a.size)
small = ImageFont.truetype(FONT, round(a.size * 0.3))
step = round(a.size * 0.88)
ys = [a.top + i * step for i in range(len(a.lines))]
lab_y = ys[-1] + round(a.size * 1.12)


def draw_text(d, fill, off=(0, 0)):
    for ln, y in zip(a.lines, ys):
        w = d.textlength(ln, font=big)
        d.text((a.right - w + off[0], y + off[1]), ln, font=big, fill=fill)
    w = d.textlength(a.label, font=small)
    d.text((a.right - w + off[0], lab_y + off[1]), a.label, font=small, fill=fill if fill[3] < 255 else AMBER)


shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
draw_text(ImageDraw.Draw(shadow), HALO, (0, 6))
shadow = shadow.filter(ImageFilter.GaussianBlur(18))
base = Image.alpha_composite(img.convert("RGBA"), shadow)
txt = Image.new("RGBA", img.size, (0, 0, 0, 0))
draw_text(ImageDraw.Draw(txt), CREAM)
out = Image.alpha_composite(base, txt).convert("RGB").resize((1280, 720), Image.LANCZOS)
name = f"{a.slug}-thumbnail" if a.final else (a.name or f"cand-{a.time:07.3f}")
dst = track / ("final" if a.final else "dev/out/thumb")
dst.mkdir(parents=True, exist_ok=True)
out.save(dst / f"{name}.png")
out.save(dst / f"{name}.jpg", quality=92)
out.resize((320, 180), Image.LANCZOS).save(track / "dev/out/thumb" / f"{name}-phone.png")
out.resize((154, 87), Image.LANCZOS).save(track / "dev/out/thumb" / f"{name}-12pct.png")
print(dst / f"{name}.jpg")
