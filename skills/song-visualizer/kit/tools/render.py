"""Render with HyperFrames, wait for it properly, and patch a few frames without re-rendering the film.

  python tools/render.py check [--vertical]
        HyperFrames' own check of the page (lint, layout, motion): run before every full render
  python tools/render.py window START LEN [--vertical] [--name NAME] [--set k=v ...] [--workers 4]
        a stretch of the song for real: renders/NAME-frames/, then dev/out/NAME.mp4 with the song from START.
        Gate B previews, motion tests, anything you want to watch with sound before an hour-long render
  python tools/render.py full [--vertical] [--workers 4] [--no-encode]
        the whole song: renders/<slug>[-vertical]-frames/, then final/<slug>[-vertical].mp4 (CRF 14, the WAV as AAC)
  python tools/render.py patch START LEN [--vertical] [--force]
        after a fix to a short stretch: renders that window on 1 worker, compares it with the full render frame by
        frame, copies in only the frames that changed (the old ones go to renders/patch-backup/), and reports how many
        matched to the pixel. If frames outside the fix changed too, it stops and says so: the fix reached further
        than you thought. Re-encode afterwards: python tools/render.py encode [--vertical]
  python tools/render.py encode [--vertical]
        re-encode final/<slug>[-vertical].mp4 from the frames on disk

Why PNG frames and a separate encode: HyperFrames' own MP4 path captures JPEGs, which darken every level by a few
steps and smear fine grain; PNG capture is exact. Why it waits on the process and counts frames: a render's log
says "0 error(s)" long before it finishes, so watching the log for "error" starts the next job too early.
A full 1080p render of a scene at 100 to 200 ms a frame ran 20 to 27 seconds per second of song on 4 CPU workers (a
4-minute song: about 70 to 80 minutes per aspect); more workers rarely help.
"""
import argparse, math, pathlib, shutil, subprocess, sys, time

import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
FPS = project.FPS


def frames_dir(c, vertical, name=None):
    return ROOT / "renders" / f"{name or c['slug'] + ('-vertical' if vertical else '')}-frames"


def expected(seconds):
    return math.ceil(seconds * FPS - 1e-9)


def run_render(args, cwd, log, want, out):
    """Run a HyperFrames render to completion; fail loudly unless the frame count is right."""
    if out.exists():
        shutil.rmtree(out)
    t0 = time.time()
    with open(log, "w", encoding="utf-8", errors="replace") as fh:
        p = subprocess.run(project.pnpm() + ["render"] + args, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT)
    took = time.time() - t0
    got = len(list(out.glob("*.png"))) if out.exists() else 0
    if p.returncode != 0 or got != want:
        sys.exit(f"render FAILED (exit {p.returncode}, {got} of {want} frames): see {log}")
    print(f"rendered {got} frames in {took / 60:.1f} min -> {out.relative_to(ROOT)}")
    return took


def page_args(out, workers, comp=None):
    a = (["-c", comp] if comp else []) + ["-o", str(out), "--format", "png-sequence", "--fps", str(FPS),
                                          "-w", str(workers), "--no-browser-gpu"]
    return a


def build(*extra):
    subprocess.run([sys.executable, str(ROOT / "tools" / "build.py"), *extra], check=True)


def encode(frames, out, start=0.0, crf=14):
    subprocess.run([sys.executable, str(ROOT / "tools" / "encode.py"), str(frames), str(out), "--start", str(start),
                    "--crf", str(crf)], check=True)


def window(c, start, length, vertical, name, sets, workers):
    pv = ROOT / "preview.html"
    build("--preview", str(start), str(length), *(["--vertical"] if vertical else []), *sum((["--set", s] for s in sets), []))
    out = frames_dir(c, vertical, name)
    try:
        run_render(page_args(out, workers, "preview.html"), ROOT, ROOT / "renders" / f"{name}.log",
                   expected(min(length, project.duration(project.song(c)) - start)), out)
    finally:
        pv.unlink(missing_ok=True)  # a second root fails HyperFrames' check; never leave it behind
    mp4 = ROOT / "dev" / "out" / f"{name}.mp4"
    mp4.parent.mkdir(parents=True, exist_ok=True)
    encode(out, mp4, start, crf=18)
    return out, mp4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["check", "window", "full", "patch", "encode"])
    ap.add_argument("times", nargs="*", type=float)
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--name", default=None)
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--no-encode", action="store_true")
    ap.add_argument("--force", action="store_true", help="patch: copy changed frames even when they come in separate runs")
    a = ap.parse_args()
    c = project.load()
    (ROOT / "renders").mkdir(exist_ok=True)
    cwd = ROOT / "vertical" if a.vertical else ROOT
    tag = "-vertical" if a.vertical else ""
    final = ROOT / "final" / f"{c['slug']}{tag}.mp4"

    if a.mode == "check":
        (ROOT / "preview.html").unlink(missing_ok=True)
        build()
        p = subprocess.run(project.pnpm() + ["check", "--timeout", "90000"], cwd=cwd)
        sys.exit(p.returncode)

    if a.mode == "window":
        start, length = a.times
        name = a.name or f"window{tag}-{start:g}-{start + length:g}s"
        out, mp4 = window(c, start, length, a.vertical, name, a.set, a.workers)
        print(f"{mp4.relative_to(ROOT)}: QA it with python tools/qa.py {mp4.relative_to(ROOT)} --start {start}")
        return

    if a.mode == "full":
        (ROOT / "preview.html").unlink(missing_ok=True)
        build()
        dur = project.duration(project.song(c))
        out = frames_dir(c, a.vertical)
        run_render(page_args(out, a.workers), cwd, ROOT / "renders" / f"full{tag}.log", expected(dur), out)
        if not a.no_encode:
            final.parent.mkdir(exist_ok=True)
            encode(out, final)
            print(f"{final.relative_to(ROOT)}: QA it with python tools/qa.py {final.relative_to(ROOT)}")
        return

    if a.mode == "encode":
        encode(frames_dir(c, a.vertical), final)
        return

    # patch
    start, length = a.times
    full = frames_dir(c, a.vertical)
    if not full.exists():
        sys.exit(f"no full render at {full}: patch works on an existing one")
    name = f"patch{tag}-{start:g}"
    win, _ = window(c, start, length, a.vertical, name, [], 1)
    f0 = round(start * FPS)
    pngs = sorted(win.glob("*.png"))
    changed, same = [], 0
    for k, p in enumerate(pngs):
        g = f0 + k
        old = full / f"frame_{g + 1:06d}.png"
        if not old.exists():
            continue
        d = np.abs(np.asarray(Image.open(p).convert("RGB"), np.int16) - np.asarray(Image.open(old).convert("RGB"), np.int16)).max()
        if d == 0:
            same += 1
        else:
            changed.append((g, p, old, int(d)))
    print(f"window {start:g} to {start + length:g} s: {same} frames identical to the full render, {len(changed)} changed")
    faint = [g for g, _, _, d in changed if d <= 40]
    if faint and len(faint) < len(changed):
        print(f"  frames {faint[0]} to {faint[-1]} differ only faintly (40 levels or less): usually a hard edge on a "
              "fractional pixel, which the first frames after a page loads blend differently. Put layout edges on whole "
              "pixels (Math.round) and re-render the full film once; see references/engine.md")
    if not changed:
        print("nothing to patch: the fix doesn't touch this window")
        return
    # changed frames should be one run; anything scattered means the fix reaches beyond what was intended
    runs = np.split(np.array([g for g, *_ in changed]), np.where(np.diff([g for g, *_ in changed]) != 1)[0] + 1)
    if len(runs) > 1:
        print("changed frames come in separate runs: " + ", ".join(f"{r[0]}-{r[-1]}" for r in runs))
        print("check the fix only touches what you meant before copying; to copy anyway, rerun with --force")
        if not a.force:
            sys.exit(1)
    backup = ROOT / "renders" / "patch-backup" / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}"
    backup.mkdir(parents=True)
    for g, p, old, d in changed:
        shutil.copy2(old, backup / old.name)
        shutil.copy2(p, old)
    print(f"patched frames {changed[0][0]} to {changed[-1][0]} (largest difference {max(d for *_, d in changed)} levels); "
          f"the old frames are in {backup.relative_to(ROOT)}")
    print(f"now: python tools/render.py encode{' --vertical' if a.vertical else ''}, then QA the new file")


if __name__ == "__main__":
    main()
