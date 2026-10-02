"""Put a frame of this visualizer next to a reference image (a cover or still it should match, any frame check).

  python dev/compare.py --ref PLATE.png --out NAME 0.0      ref | mine at full size and at 640 px, plus a blind
                                                            pair (the two 640 px images in a seeded order, the
                                                            key in key.txt, for the "which is which" test)
  --crop x,y,w,h [x,y,w,h ...]   1:1 crops of each region, scaled up (ref | mine)
  --at x,y [x,y ...]             5x5 mean colour at each point, ref vs mine (8-bit sRGB)
  --rows                         the mean grey of every 20th row, ref vs mine, and the largest gap
  --diff                         |ref - mine| as a heat map, with the mean and the 99th percentile
  --mine FRAME.png               compare an existing frame instead of rendering one
  --aspect v, --gpu sw|hw        as dev/shot.py
Outputs go to dev/out/NAME/.
"""
import argparse, pathlib, sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shot  # noqa: E402  (the same folder: headless Chrome on dev/frame.html)

ROOT = shot.ROOT
sys.path.insert(0, str(ROOT / "tools"))
from project import font  # noqa: E402  (whatever label font this machine has)


def label(im, text):
    d = ImageDraw.Draw(im)
    f = font(20)
    w = d.textlength(text, font=f)
    d.rectangle((0, 0, w + 14, 28), fill=(0, 0, 0))
    d.text((7, 3), text, fill=(255, 255, 0), font=f)
    return im


def pair(a, b, gap=10):
    s = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height)), (20, 20, 20))
    s.paste(a, (0, 0))
    s.paste(b, (a.width + gap, 0))
    return s


def mean_at(arr, x, y, r=2):
    h, w = arr.shape[:2]
    x0, x1 = max(0, x - r), min(w, x + r + 1)
    y0, y1 = max(0, y - r), min(h, y + r + 1)
    return arr[y0:y1, x0:x1].reshape(-1, 3).mean(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", default="compare")
    ap.add_argument("--mine", default=None)
    ap.add_argument("--aspect", default="h", choices=["h", "v"])
    ap.add_argument("--gpu", default="sw", choices=["sw", "hw"])
    ap.add_argument("--crop", nargs="*", default=[])
    ap.add_argument("--at", nargs="*", default=[])
    ap.add_argument("--rows", action="store_true")
    ap.add_argument("--diff", action="store_true")
    ap.add_argument("t", type=float)
    a = ap.parse_args()
    vert = a.aspect == "v"
    W, H = (1080, 1920) if vert else (1920, 1080)
    out = ROOT / "dev" / "out" / a.out
    out.mkdir(parents=True, exist_ok=True)

    ref = Image.open(a.ref).convert("RGB")
    if ref.size != (W, H):
        sys.exit(f"reference is {ref.size[0]}x{ref.size[1]}, the frame is {W}x{H}")
    if a.mine:
        mine_png = pathlib.Path(a.mine)
    else:
        mine_png = out / f"mine_{a.aspect}_{a.t:07.3f}.png"
        shot.shoot(f"t={a.t:.6f}{'&aspect=v' if vert else ''}", str(mine_png), W, H, a.gpu)
    mine = Image.open(mine_png).convert("RGB")
    tag = f"{a.t:07.3f}"

    full = pair(label(ref.copy(), "REF"), label(mine.copy(), f"MINE {a.t:.3f}"))
    full.save(out / f"pair_{tag}.png")
    sw = 640 if not vert else 360
    sh = round(sw * H / W)
    r640 = ref.resize((sw, sh), Image.LANCZOS)
    m640 = mine.resize((sw, sh), Image.LANCZOS)
    pair(label(r640.copy(), "REF"), label(m640.copy(), "MINE")).save(out / f"pair640_{tag}.png")
    # blind: no labels, order from the time, so the key can't be guessed from a pattern
    flip = (int(round(a.t * 24)) * 2654435761 >> 7) & 1
    left, right = (m640, r640) if flip else (r640, m640)
    pair(left, right, gap=16).save(out / f"blind640_{tag}.png")
    (out / f"key_{tag}.txt").write_text(f"left: {'mine' if flip else 'reference'}\nright: {'reference' if flip else 'mine'}\n")
    print(out / f"pair_{tag}.png")
    print(out / f"blind640_{tag}.png", "(key in", out / f"key_{tag}.txt)")

    R = np.asarray(ref, np.float32)
    M = np.asarray(mine, np.float32)
    for i, c in enumerate(a.crop):
        x, y, w, h = map(int, c.split(","))
        k = max(1, min(4, 640 // max(w, h)))
        cr = ref.crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.LANCZOS)
        cm = mine.crop((x, y, x + w, y + h)).resize((w * k, h * k), Image.LANCZOS)
        p = out / f"crop{i}_{tag}_{x}_{y}_{w}x{h}.png"
        pair(label(cr, f"REF {w}x{h} x{k}"), label(cm, "MINE")).save(p)
        print(p)
    for c in a.at:
        x, y = map(int, c.split(","))
        r, m = mean_at(R, x, y), mean_at(M, x, y)
        print(f"at {x},{y}: ref {tuple(int(round(v)) for v in r)}  mine {tuple(int(round(v)) for v in m)}  "
              f"diff {tuple(int(round(v)) for v in m - r)}")
    if a.rows:
        rg = R.mean(axis=(1, 2))
        mg = M.mean(axis=(1, 2))
        for y in range(0, H, 20):
            print(f"row {y:4d}: ref {rg[y]:6.1f}  mine {mg[y]:6.1f}  diff {mg[y] - rg[y]:+5.1f}")
        k = int(np.argmax(np.abs(mg - rg)))
        print(f"largest row gap: row {k}, {mg[k] - rg[k]:+.1f} levels")
    if a.diff:
        d = np.abs(M - R).mean(axis=2)
        print(f"|ref - mine|: mean {d.mean():.2f} levels, 99th percentile {np.percentile(d, 99):.1f}, max {d.max():.0f}")
        heat = np.clip(d * 8, 0, 255).astype(np.uint8)
        Image.fromarray(heat).save(out / f"diff_{tag}.png")
        print(out / f"diff_{tag}.png", "(levels x 8)")


if __name__ == "__main__":
    main()
