"""Check this machine has everything the pipeline runs on, and say exactly what's missing.

  python tools/check_setup.py           Python packages, ffmpeg and ffprobe, Node and pnpm, a headless Chrome
  python tools/check_setup.py --render  also fetches the pinned HyperFrames once (the first run downloads it and
                                        its Chrome, a few hundred MB) and prints its version
"""
import importlib, pathlib, shutil, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

PY = {
    "numpy": "numpy",
    "scipy": "scipy",
    "librosa": "librosa",
    "soundfile": "soundfile",
    "PIL": "pillow",
    "fontTools": "fonttools (only for end cards)",
}
ok = True


def say(good, what, fix=""):
    global ok
    print(("  ok   " if good else "  MISSING ") + what + ("" if good else f"\n         fix: {fix}"))
    ok = ok and (good or "only for" in what)


print("Python", sys.version.split()[0])
say(sys.version_info >= (3, 10), "Python 3.10 or newer", "install a current Python 3")
for mod, pkg in PY.items():
    try:
        importlib.import_module(mod)
        say(True, pkg)
    except ImportError:
        say(False, pkg, f"{sys.executable} -m pip install {pkg.split()[0]}")
for exe in ("ffmpeg", "ffprobe"):
    say(bool(shutil.which(exe)), exe, "install ffmpeg (it includes ffprobe) and put it on PATH")
say(bool(shutil.which("node")), "node", "install Node.js 20 or newer")
pn = shutil.which("pnpm") or shutil.which("pnpm.cmd")
say(bool(pn), "pnpm", "npm install -g pnpm")
sys.path.insert(0, str(project.ROOT / "dev"))
try:
    import shot

    c = next((p for p in shot.CHROME if p.exists()), None)
    say(bool(c), f"headless Chrome{' (' + str(c) + ')' if c else ''}",
        "python tools/check_setup.py --render (HyperFrames downloads its own), or install Chrome")
except SystemExit:
    pass
if "--render" in sys.argv and pn:
    p = subprocess.run(project.pnpm() + ["--version"], capture_output=True, text=True)
    say(p.returncode == 0, f"HyperFrames {p.stdout.strip() or p.stderr.strip()[:200]}", "see the error above")
print("\nready" if ok else "\nfix the MISSING lines above, then run this again")
sys.exit(0 if ok else 1)
