"""Render with HyperFrames, wait for it properly, and patch a few frames without re-rendering the film.

  python tools/render.py check [--vertical]
        HyperFrames' own check of the page (lint, layout, motion): run before every full render
  python tools/render.py window START LEN [--vertical] [--name NAME] [--set k=v ...] [--workers 4]
        a stretch of the song for real: renders/NAME-frames/, then dev/out/NAME.mp4 with the song from START.
        Gate B previews, motion tests, anything you want to watch with sound before an hour-long render
  python tools/render.py chunks [--len 54] [--vertical] [--workers 4] [--no-encode]
        the whole song as consecutive windows assembled into the full frames directory, for a drive that cannot hold
        HyperFrames' temporary copy of every frame at once (it refuses to start a long render otherwise); resumes
  python tools/render.py full [--vertical] [--workers 4] [--no-encode]
        the whole song: renders/<slug>[-vertical]-frames/, then final/<slug>[-vertical].mp4 (CRF 14, the WAV as AAC)
  python tools/render.py patch START LEN [--vertical] [--force]
        after a fix to a short stretch: renders that window on 1 worker, compares it with the full render frame by
        frame, copies in only the frames that changed (the old ones go to renders/patch-backup/), and reports how many
        matched to the pixel. If frames outside the fix changed too, it stops and says so: the fix reached further
        than you thought. Re-encode afterwards: python tools/render.py encode [--vertical]
  python tools/render.py encode [--vertical]
        re-encode final/<slug>[-vertical].mp4 from the frames on disk
  --detach  (with full or window) start the job as its own process and return at once. Agents' background commands
        can be stopped after a time limit (30 minutes was seen), and a stopped parent cancels a HyperFrames render, so
        hour-long renders run detached. The job's output goes to renders/job-<mode>[-vertical].out.
  python tools/render.py status        every detached job: running or finished, its progress, its last lines
  python tools/render.py wait [--minutes 25]
        wait until no detached job is running, up to that long; exit 0 when they're done, 2 if one is still running
        (call it again). Keep the wait under the agent's background time limit.

Why PNG frames and a separate encode: HyperFrames' own MP4 path captures JPEGs, which darken every level by a few
steps and smear fine grain; PNG capture is exact. Why it waits on the process and counts frames: a render's log
says "0 error(s)" long before it finishes, so watching the log for "error" starts the next job too early.
A full 1080p render of a scene at 100 to 200 ms a frame ran 20 to 27 seconds per second of song on 4 CPU workers (a
4-minute song: about 70 to 80 minutes per aspect); more workers rarely help.
"""
import argparse, json, math, pathlib, re, shutil, subprocess, sys, time

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
        # no input, ever: pnpm asks questions on a fresh install when it can (it hangs a detached job forever)
        p = subprocess.run(project.pnpm() + ["render"] + args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=fh,
                           stderr=subprocess.STDOUT)
    took = time.time() - t0
    got = len(list(out.glob("*.png"))) if out.exists() else 0
    if p.returncode != 0 or got != want:
        sys.exit(f"render FAILED (exit {p.returncode}, {got} of {want} frames): see {log}")
    print(f"rendered {got} frames in {took / 60:.1f} min -> {out.relative_to(ROOT)}")
    return took


def page_args(out, workers, comp=None):
    # visualizer.json "gpu": "hardware" renders on the host GPU (the water shader needs it: SwiftShader has no WebGL2
    # context at 1080p here, and the shader would take seconds a frame on it); the default is the software GPU
    gpu = project.load().get("gpu", "software")
    flag = "--browser-gpu" if gpu == "hardware" else "--no-browser-gpu"
    a = (["-c", comp] if comp else []) + ["-o", str(out), "--format", "png-sequence", "--fps", str(FPS),
                                          "-w", str(workers), flag]
    return a


def build(*extra):
    subprocess.run([sys.executable, str(ROOT / "tools" / "build.py"), *extra], check=True)


def encode(frames, out, start=0.0, crf=14):
    subprocess.run([sys.executable, str(ROOT / "tools" / "encode.py"), str(frames), str(out), "--start", str(start),
                    "--crf", str(crf)], check=True)


def window(c, start, length, vertical, name, sets, workers, preview=True):
    pv = ROOT / "preview.html"
    build("--preview", str(start), str(length), *(["--vertical"] if vertical else []), *sum((["--set", s] for s in sets), []))
    out = frames_dir(c, vertical, name)
    try:
        run_render(page_args(out, workers, "preview.html"), ROOT, ROOT / "renders" / f"{name}.log",
                   expected(min(length, project.duration(project.song(c)) - start)), out)
    finally:
        pv.unlink(missing_ok=True)  # a second root fails HyperFrames' check; never leave it behind
    if not preview:
        return out, None
    mp4 = ROOT / "dev" / "out" / f"{name}.mp4"
    mp4.parent.mkdir(parents=True, exist_ok=True)
    encode(out, mp4, start, crf=18)
    return out, mp4


def chunks(c, length, vertical, workers):
    """The whole song as consecutive windows of `length` seconds, assembled into the full frames directory with the
    numbering a full render would give (frame_000001.png at 0 s). HyperFrames keeps every captured frame of a render in
    temporary storage before it writes the sequence and refuses to start when the drive could not hold all of them at
    their uncompressed size (8.3 MB a frame at 1080p), so a long song on a tight drive renders in windows. Each window
    is rendered exactly as `window` renders it (the same page, offset), and renders here are deterministic across runs
    and worker counts (proven on this project: 139 to 141 s, four runs, every frame identical), so the seams are
    exact. A window whose frames are already complete is skipped, so a stopped job resumes."""
    dur = project.duration(project.song(c))
    full = frames_dir(c, vertical)
    tag = "-vertical" if vertical else ""
    n = math.ceil(dur / length - 1e-9)
    done = []
    for i in range(n):
        start = i * length
        ln = min(length, dur - start)
        name = f"chunk{tag}-{i:02d}"
        out = frames_dir(c, vertical, name)
        want = expected(ln)
        if out.exists() and len(list(out.glob("*.png"))) == want:
            print(f"{name}: {want} frames already there, skipped")
        else:
            window(c, start, ln, vertical, name, [], workers, preview=False)
        done.append((start, out))
    full.mkdir(parents=True, exist_ok=True)
    moved = 0
    for start, out in done:
        f0 = round(start * FPS)
        for k, png in enumerate(sorted(out.glob("*.png"))):
            dst = full / f"frame_{f0 + k + 1:06d}.png"
            png.replace(dst)
            moved += 1
        shutil.rmtree(out, ignore_errors=True)
    got = len(list(full.glob("*.png")))
    want = expected(dur)
    if got != want:
        sys.exit(f"assembled {got} frames, expected {want}: see renders/chunk{tag}-*.log")
    print(f"assembled {got} frames from {n} windows -> {full.relative_to(ROOT)}")
    return full


def alive(pid):
    if sys.platform == "win32":
        # tasklist's filter has come back empty for a live process here; ask PowerShell when it does
        p = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True)
        if str(pid) in p.stdout:
            return True
        q = subprocess.run(["powershell", "-NoProfile", "-Command", f"(Get-Process -Id {pid} -ErrorAction SilentlyContinue) -ne $null"],
                           capture_output=True, text=True)
        return q.stdout.strip().lower() == "true"
    try:
        import os
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def detach(argv, job):
    """Start `python tools/render.py argv` as its own process, outside this one's process tree and console, so it
    survives the agent's command ending. On Windows that's WMI (a child of this process would go down with it); on
    macOS and Linux a new session."""
    out = ROOT / "renders" / f"job-{job}.out"
    meta = ROOT / "renders" / f"job-{job}.json"
    args = [sys.executable, str(ROOT / "tools" / "render.py"), *argv]
    # HyperFrames watches every process above it and cancels the render if one exits ("parent_exited"); a detached job's
    # launcher always exits (on Windows the WMI host does, about a minute and a half in), so turn that watch off for it
    if sys.platform == "win32":
        # cmd /c gives the job a console of its own (pnpm's shim exits at once without one); ShowWindow 0 hides it
        cmdline = ("cmd /c \"set HYPERFRAMES_RENDER_DETACHED=1&& " + " ".join(f'"{x}"' for x in args)
                   + f' > "{out}" 2>&1"')
        ps = ("$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0; "
              "CreateFlags=[uint32]16}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments "
              "@{CommandLine=$env:VIS_CMD; CurrentDirectory=$env:VIS_DIR; ProcessStartupInformation=$si}; "
              "Write-Output \"$($r.ReturnValue) $($r.ProcessId)\"")
        env = {**__import__("os").environ, "VIS_CMD": cmdline, "VIS_DIR": str(ROOT)}
        p = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, env=env)
        rv, pid = (p.stdout.split() + ["1", "0"])[:2]
        if rv != "0":
            sys.exit(f"couldn't start the detached job: {p.stdout} {p.stderr}")
        pid = int(pid)
    else:
        fh = open(out, "w")
        env = {**__import__("os").environ, "HYPERFRAMES_RENDER_DETACHED": "1"}
        pid = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
                               start_new_session=True, env=env).pid
    meta.write_text(json.dumps({"pid": pid, "args": argv, "started": time.strftime("%Y-%m-%d %H:%M:%S")}), encoding="utf-8")
    print(f"started {job} as its own process (pid {pid}); output in renders/job-{job}.out")
    print("check it with python tools/render.py status, or python tools/render.py wait --minutes 25")


def progress():
    """The newest HyperFrames log's last 'Capturing frame N/M'."""
    logs = sorted((ROOT / "renders").glob("*.log"), key=lambda p: p.stat().st_mtime)
    if not logs:
        return ""
    tail = logs[-1].read_bytes()[-4000:].decode("utf-8", "replace")
    m = re.findall(r"Capturing frame (\d+)/(\d+)", tail)
    return f"{logs[-1].name}: frame {m[-1][0]} of {m[-1][1]}" if m else f"{logs[-1].name}: {tail.strip().splitlines()[-1][:120] if tail.strip() else ''}"


def jobs():
    out = []
    for meta in sorted((ROOT / "renders").glob("job-*.json")):
        j = json.loads(meta.read_text(encoding="utf-8"))
        log = meta.with_suffix(".out")
        last = [ln for ln in (log.read_text(encoding="utf-8", errors="replace").splitlines() if log.exists() else [])
                if "Capturing" not in ln and ln.strip()][-3:]
        out.append((meta.stem[4:], alive(j["pid"]), j, last))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["check", "window", "full", "chunks", "patch", "encode", "status", "wait"])
    ap.add_argument("--len", type=float, default=54, help="chunks: seconds per window (default 54)")
    ap.add_argument("--detach", action="store_true")
    ap.add_argument("--minutes", type=float, default=25)
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

    if a.detach and a.mode in ("full", "window", "chunks"):
        argv = [x for x in sys.argv[1:] if x != "--detach"]
        job = a.mode + tag + (f"-{a.times[0]:g}" if a.mode == "window" else "")
        detach(argv, job)
        return

    if a.mode in ("status", "wait"):
        deadline = time.time() + a.minutes * 60
        while True:
            js = jobs()
            running = [j for j in js if j[1]]
            if a.mode == "status" or not running or time.time() >= deadline:
                break
            time.sleep(30)
        if not js:
            print("no detached jobs")
        for name, run, j, last in js:
            print(f"{name}: {'RUNNING' if run else 'finished'} (pid {j['pid']}, started {j['started']})")
            for ln in last:
                print("   ", ln[:200])
        if running:
            print("   ", progress())
        sys.exit(2 if (a.mode == "wait" and running) else 0)

    if a.mode == "check":
        (ROOT / "preview.html").unlink(missing_ok=True)
        build()
        p = subprocess.run(project.pnpm() + ["check", "--timeout", "90000"], cwd=cwd, stdin=subprocess.DEVNULL)
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

    if a.mode == "chunks":
        (ROOT / "preview.html").unlink(missing_ok=True)
        build()
        out = chunks(c, a.len, a.vertical, a.workers)
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
