"""QA for a rendered export, over every frame. Never a sample: a glitch that lasts one frame is still a glitch.

  python tools/qa.py VIDEO [--start S] [--out DIR]
    1. blackdetect and freezedetect over the whole file (ffmpeg); every interval is listed
    2. flashes: relative luminance of the whole frame and of each quarter, every frame; any one-second
       window with more than 3 flashes (opposing swings of 10 % or more, as in WCAG 2.3.1) fails
    3. one-frame spikes: a frame whose brightness jumps and comes straight back (something drawn for one frame
       that shouldn't be: a shape behind the camera projected across the frame, a layer missing for a frame).
       These pass the flash check (one or two a second) and are the glitches people notice
    4. contact sheets of every frame (sheet_NNN.png, frame numbers and song times on them): look at every one
    5. a sheet at one frame per second, and full-size stills at every named cue in lib/cues.js
  --start S: the video is a window of the song starting at S seconds (cue times are song times).
  Writes DIR/report.txt (default DIR: qa_<video stem>/ beside the video).
"""
import argparse, json, pathlib, re, subprocess, sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
font = project.font


def probe(v):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                        "stream=width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json", str(v)],
                       capture_output=True, text=True, check=True)
    j = json.loads(p.stdout)
    s = j["streams"][0]
    num, den = map(int, s["r_frame_rate"].split("/"))
    return {"w": s["width"], "h": s["height"], "fps": num / den, "frames": int(s["nb_read_frames"]),
            "duration": float(j["format"]["duration"])}


def detect(v):
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(v), "-an", "-vf",
                        "blackdetect=d=0:pix_th=0.10,freezedetect=n=-60dB:d=0.5", "-f", "null", "-"],
                       capture_output=True, text=True)
    black = re.findall(r"black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)", p.stderr)
    fs = re.findall(r"freeze_start: ([\d.]+)", p.stderr)
    fe = re.findall(r"freeze_end: ([\d.]+)", p.stderr)
    freeze = [(float(a), float(fe[i]) if i < len(fe) else None) for i, a in enumerate(fs)]
    return [(float(a), float(b)) for a, b, _ in black], freeze


def frames(v, w, h, fps=None):
    """Every frame decoded at w x h RGB, in chunks."""
    vf = (f"fps={fps}," if fps else "") + f"scale={w}:{h}:flags=area"
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(v), "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         stdout=subprocess.PIPE)
    n = w * h * 3
    while True:
        b = p.stdout.read(n)
        if len(b) < n:
            break
        yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    p.wait()


def rel_lum(rgb):
    c = rgb.astype(np.float32) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


def transitions(s, thr=0.1, dark=0.8):
    """Frames where a swing of at least thr in relative luminance completes (zigzag with hysteresis); only
    swings whose darker end is below dark count (WCAG 2.3.1)."""
    out = []
    lo = hi = s[0]
    lo_i = hi_i = 0
    trend = 0
    last = cand = s[0]
    cand_i = 0
    for i in range(1, len(s)):
        v = s[i]
        if trend == 0:
            if v < lo:
                lo, lo_i = v, i
            if v > hi:
                hi, hi_i = v, i
            if v - lo >= thr:
                trend, last, cand, cand_i = 1, lo, v, i
            elif hi - v >= thr:
                trend, last, cand, cand_i = -1, hi, v, i
            continue
        if (v - cand) * trend > 0:
            cand, cand_i = v, i
        elif abs(cand - v) >= thr:
            if min(last, cand) < dark:
                out.append(cand_i)
            last, trend, cand, cand_i = cand, -trend, v, i
    if trend and abs(cand - last) >= thr and min(last, cand) < dark:
        out.append(cand_i)
    return out


def flashes(series, fps):
    """(worst count of flashes in any one-second window, frames where a window holds more than 3).
    A flash is a pair of opposing transitions."""
    tr = transitions(list(series))
    win = int(round(fps))
    worst, bad = 0, []
    for k in range(len(tr)):
        j = k
        while j < len(tr) and tr[j] - tr[k] < win:
            j += 1
        n = (j - k) // 2
        worst = max(worst, n)
        if n > 3:
            bad.append(tr[k])
    return worst, bad


def cues():
    f = ROOT / "lib" / "cues.js"
    if not f.exists():
        return []
    src = f.read_text(encoding="utf-8")
    return [(m.group(1), float(m.group(2))) for m in re.finditer(r"^\s+(\w+): ([\d.]+),", src, re.M)]


def spikes(s, thr=0.02, back=3):
    """Frames where the mean luminance jumps by thr or more and returns to within thr / 2 of where it was inside
    `back` frames: a one-to-three-frame glitch, not a cut or a fade."""
    s = np.asarray(s)
    out = []
    i = 1
    while i < len(s):
        d = s[i] - s[i - 1]
        if abs(d) >= thr:
            for j in range(i + 1, min(len(s), i + back + 1)):
                if abs(s[j] - s[i - 1]) < thr / 2:
                    out.append((i, j - 1, float(d)))
                    i = j
                    break
        i += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    v = pathlib.Path(a.video).resolve()
    out = pathlib.Path(a.out) if a.out else v.parent / f"qa_{v.stem}"
    out.mkdir(parents=True, exist_ok=True)
    info = probe(v)
    fps = info["fps"]
    lines = [f"QA {v.name}: {info['w']}x{info['h']}, {fps:g} fps, {info['frames']} frames, {info['duration']:.3f} s"
             + (f", song time {a.start:.3f} s at frame 0" if a.start else "")]

    black, freeze = detect(v)
    lines.append(f"blackdetect (pix_th 0.10, any length): {len(black)} interval(s)")
    lines += [f"  black {s + a.start:.3f}-{e + a.start:.3f} s (frames {round(s * fps)}-{round(e * fps) - 1})" for s, e in black]
    lines.append(f"freezedetect (-60 dB, 0.5 s): {len(freeze)} interval(s)")
    lines += [f"  frozen from {s + a.start:.3f} s" + (f" to {e + a.start:.3f} s" if e else " to the end") for s, e in freeze]

    # every frame: thumbnails for the sheets, luminance for the flash check
    vert = info["h"] > info["w"]
    tw, th = (90, 160) if vert else (160, 90)
    cols, rows = (16, 6) if vert else (12, 10)
    per = cols * rows
    sheet = None
    k = 0
    lum = {"frame": [], "q0": [], "q1": [], "q2": [], "q3": []}
    f = font(13)
    sheets = []
    for k, fr in enumerate(frames(v, tw, th)):
        Lm = rel_lum(fr)
        hh, ww = Lm.shape[0] // 2, Lm.shape[1] // 2
        lum["frame"].append(float(Lm.mean()))
        for q, (ys, xs) in enumerate([(slice(0, hh), slice(0, ww)), (slice(0, hh), slice(ww, None)),
                                      (slice(hh, None), slice(0, ww)), (slice(hh, None), slice(ww, None))]):
            lum[f"q{q}"].append(float(Lm[ys, xs].mean()))
        i = k % per
        if i == 0:
            if sheet is not None:
                sheets.append(sheet)
            sheet = Image.new("RGB", (cols * tw, rows * (th + 16)), (0, 0, 0))
        im = Image.fromarray(fr)
        x, y = (i % cols) * tw, (i // cols) * (th + 16)
        sheet.paste(im, (x, y + 16))
        ImageDraw.Draw(sheet).text((x + 3, y + 1), f"{k} {k / fps + a.start:.2f}", fill=(255, 255, 0), font=f)
    if sheet is not None:
        sheets.append(sheet)
    for n, s in enumerate(sheets):
        s.save(out / f"sheet_{n:03d}.png")
    lines.append(f"contact sheets: {len(sheets)} (sheet_000.png ...), {per} frames each, every frame of {k + 1}")
    if k + 1 != info["frames"]:
        lines.append(f"  WARNING: decoded {k + 1} frames, ffprobe counts {info['frames']}")

    fails, most = [], 0
    for name, series in lum.items():
        n, bad = flashes(series, fps)
        most = max(most, n)
        if bad:
            fails.append(f"  {name}: more than 3 flashes in a second from frame(s) {bad[:10]}")
    lines.append("flash check (WCAG 2.3.1, whole frame and each quarter): " + ("PASS" if not fails else "FAIL")
                 + f", at most {most} flash(es) in any second")
    lines += fails
    d = np.abs(np.diff(np.array(lum["frame"])))
    if len(d):
        j = int(np.argmax(d))
        lines.append(f"  largest frame-to-frame change in mean luminance: {d[j]:.3f} at frame {j + 1}")
    sp = spikes(lum["frame"])
    lines.append("one-frame spikes (a jump of 0.02 or more that comes straight back): " + ("none" if not sp else "FAIL"))
    lines += [f"  frames {i}-{j} ({i / fps + a.start:.3f} s): {'+' if dv > 0 else ''}{dv:.3f}, back by frame {j + 1}"
              for i, j, dv in sp]

    # one frame per second, and the named cues
    sec = list(frames(v, 320, round(320 * info["h"] / info["w"]), fps=1))
    if sec:
        c2 = 6 if not vert else 10
        cw, ch = sec[0].shape[1], sec[0].shape[0]
        r2 = -(-len(sec) // c2)
        s1 = Image.new("RGB", (c2 * cw, r2 * (ch + 18)), (0, 0, 0))
        for i, fr in enumerate(sec):
            x, y = (i % c2) * cw, (i // c2) * (ch + 18)
            s1.paste(Image.fromarray(fr), (x, y + 18))
            ImageDraw.Draw(s1).text((x + 3, y + 2), f"{i + a.start:.0f} s", fill=(255, 255, 0), font=f)
        s1.save(out / "seconds.png")
        lines.append(f"one frame per second: seconds.png ({len(sec)} frames)")
    cdir = out / "cues"
    cdir.mkdir(exist_ok=True)
    got = []
    for name, t in cues():
        tv = t - a.start
        if tv < 0 or tv >= info["duration"]:
            continue
        fr_n = min(info["frames"] - 1, round(tv * fps))
        png = cdir / f"{name}_{t:07.3f}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(v), "-vf", f"select=eq(n\\,{fr_n})", "-frames:v", "1",
                        str(png)], check=True)
        got.append(f"{name} {t:.2f} s (frame {fr_n})")
    lines.append(f"cue stills: {len(got)} in cues/: " + ", ".join(got))
    (out / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print("wrote", out)


if __name__ == "__main__":
    main()
