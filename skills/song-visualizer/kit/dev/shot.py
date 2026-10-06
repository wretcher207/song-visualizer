"""Render frames of this visualizer with headless Chrome (run from anywhere).

  python dev/shot.py --out NAME 12.0 60 200              one full-res PNG per time
  python dev/shot.py --out NAME --strip 12.0 13.0 12     motion strip: 12 frames over 12.0-13.0 s, 4 columns
      --crop x,y,w,h                                   each tile shows that region of the frame (a walk cycle)
  python dev/shot.py --out NAME --sheet 0 60 5           contact sheet: one frame every 5 s from 0 to 60, 6 columns
  python dev/shot.py --perf 10 20 40                     ms per frame (whole frame, flushed), prints the GPU
  options: --aspect v (1080x1920)   --gpu sw|hw (SwiftShader, the render default | the hardware GPU)
           --q "fig=hood&x=1" (extra query for the scene: review variants)
           --small 640 (also write a copy scaled to that width, for the 640 px read test)
Outputs go to dev/out/NAME/.
"""
import argparse, pathlib, re, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent  # the project folder
HOME = pathlib.Path.home()
# The same headless shell HyperFrames renders with comes first, so dev stills match the render; then any other
# headless shell, then a desktop Chrome or Chromium.
SHELLS = ["chrome-headless-shell.exe", "chrome-headless-shell"]
CHROME = []
for cache in (HOME / ".cache/hyperframes/chrome/chrome-headless-shell", HOME / ".cache/puppeteer/chrome-headless-shell"):
    for name in SHELLS:
        CHROME += sorted(cache.glob(f"*/*/{name}"), reverse=True)
CHROME += [pathlib.Path(p) for p in (
    r"C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)]
for name in ("google-chrome", "chromium", "chromium-browser"):
    if shutil.which(name):
        CHROME.append(pathlib.Path(shutil.which(name)))
HW_ANGLE = {"win32": "d3d11", "darwin": "metal"}.get(sys.platform, "gl")
GPU_FLAGS = {
    "sw": ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    "hw": ["--use-gl=angle", f"--use-angle={HW_ANGLE}", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--enable-gpu"],
}


def chrome():
    for c in CHROME:
        if c.exists():
            return str(c)
    sys.exit("no headless Chrome found: run one HyperFrames render (it downloads its own), or install Chrome")


def shoot(query, out_png, w, h, gpu, dump=False):
    tmp = tempfile.mkdtemp(prefix="visualizer_chrome_")
    url = (ROOT / "dev" / "frame.html").as_uri() + "?" + query
    try:
        cmd = [chrome(), "--headless", "--hide-scrollbars", "--force-device-scale-factor=1", f"--window-size={w},{h}",
               "--virtual-time-budget=120000", "--run-all-compositor-stages-before-draw", f"--user-data-dir={tmp}",
               "--allow-file-access-from-files", "--enable-logging=stderr", "--v=0"] + GPU_FLAGS[gpu]
        cmd += ["--dump-dom"] if dump else [f"--screenshot={out_png}"]
        p = subprocess.run(cmd + [url], capture_output=True, text=True, timeout=900)
        for line in (p.stderr or "").splitlines():
            if ("CONSOLE" in line or "Uncaught" in line) and "GL Driver Message" not in line:
                print("  [page]", line.strip()[:400])
        return p.stdout
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def small_copy(png, width):
    from PIL import Image
    im = Image.open(png)
    s = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out = png.with_name(png.stem + f"_{width}.png")
    s.save(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="perf")
    ap.add_argument("--strip", action="store_true")
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--perf", action="store_true")
    ap.add_argument("--aspect", default="h", choices=["h", "v"])
    ap.add_argument("--gpu", default="sw", choices=["sw", "hw"])
    ap.add_argument("--cols", type=int, default=0)
    ap.add_argument("--small", type=int, default=0)
    ap.add_argument("--clean", action="store_true", help="no time labels on strips and sheets")
    ap.add_argument("--split", action="store_true", help="with --perf: time each stage (FILM.mark)")
    ap.add_argument("--crop", default=None, help="with --strip: x,y,w,h of the frame shown in each tile")
    ap.add_argument("--q", default="", help="extra query for the scene (review variants), e.g. fig=hood")
    ap.add_argument("times", nargs="+", help="song times in seconds, or f<N> for rendered frame N (frame_<N>.png: t = (N - 1) / 24)")
    a = ap.parse_args()
    # A frame's time must reach the scene as the exact double the render used ((N - 1) / 24, the hf-seek path): a time
    # rounded to six decimals draws a frame that differs by a level in a few hundred pixels. f<N> gives it exactly.
    a.times = [(int(x[1:]) - 1) / 24 if x.startswith("f") else float(x) for x in a.times]
    vert = a.aspect == "v"
    W, H = (1080, 1920) if vert else (1920, 1080)
    asp = ("&aspect=v" if vert else "") + (("&" + a.q) if a.q else "")
    out = ROOT / "dev" / "out" / a.out
    out.mkdir(parents=True, exist_ok=True)
    if a.perf:
        t0, t1, n = a.times
        dom = shoot(f"perf={t0},{t1},{int(n)}{asp}{'&split' if a.split else ''}", None, W, H, a.gpu, dump=True)
        m = re.search(r"<pre id=\"perf\">([^<]*)", dom or "")
        e = re.search(r"<pre id=\"errors\"[^>]*>([^<]*)", dom or "")
        print(m.group(1) if m else "no perf output", ("\n" + e.group(1)) if e else "")
    elif a.strip or a.sheet:
        t0, t1, n = a.times
        if a.sheet:
            step = n
            n = int(round((t1 - t0) / step)) + 1
        n = int(n)
        cols = a.cols or (4 if a.strip else 6)
        if vert and not a.cols:
            cols = 6 if a.strip else 8
        cw = 1920 // cols
        ch = round(cw * H / W)
        if a.crop:
            cx, cy, cwid, chei = map(int, a.crop.split(","))
            ch = round(cw * chei / cwid)
        rows = -(-n // cols)
        kind = "strip" if a.strip else "sheet"
        png = out / f"{kind}_{a.aspect}_{t0:07.3f}_{t1:07.3f}.png"
        t1q = t0 + (n - 1) * (a.times[2] if a.sheet else (t1 - t0) / max(1, n - 1)) if a.sheet else t1
        crop = f"&crop={a.crop}" if a.crop else ""
        shoot(f"strip={t0},{t1q},{n},{cols}{asp}{'&clean' if a.clean else ''}{crop}", str(png), 1920, ch * rows, a.gpu)
        print(png)
        if a.small:
            print(small_copy(png, a.small))
    else:
        for t in a.times:
            png = out / f"frame_{a.aspect}_{t:07.3f}.png"
            shoot(f"t={t!r}{asp}", str(png), W, H, a.gpu)  # full precision: a frame time like 232/24 rounded to six places drew a different frame
            print(png)
            if a.small:
                print(small_copy(png, a.small))


if __name__ == "__main__":
    main()
