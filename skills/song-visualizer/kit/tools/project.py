"""The project's settings, read by every tool: visualizer.json at the project root.

  {
    "slug": "my-song",                  file names: final/my-song.mp4, assets/my-song.m4a
    "title": "my song",                 the end card and the page titles
    "artist": "the artist",
    "song": "audio/my-song.wav",        the master WAV (relative to the project, or absolute)
    "bg": "#0b0d12",                    the page colour behind the canvas
    "gpu": "software",                  "hardware" renders on the host GPU (--browser-gpu): for a scene SwiftShader
                                        cannot run; prove determinism first (render-and-qa.md) and give it the GPU alone
    "scenes": ["scenes/main.js"],       scene scripts, in load order (after the engine, features and cues)
    "lib": [],                          extra lib scripts a scene needs (e.g. "lib/endtype.js" is added on its own)
    "fonts": {
      "endcard": "fonts/MyFont.ttf",    any TTF/OTF; variable fonts take "endcardWeight"
      "endcardWeight": 300,
      "thumbnail": "fonts/MyFont-Bold.otf"
    }
  }
"""
import json, pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / "visualizer.json"
FPS = 24
HYPERFRAMES = "hyperframes@0.8.77"  # pinned: the render contract this kit was proven on


def load():
    if not CONFIG.exists():
        sys.exit(f"no {CONFIG.name} in {ROOT}: run the new-project script first")
    c = json.loads(CONFIG.read_text(encoding="utf-8"))
    c.setdefault("bg", "#0b0d12")
    c.setdefault("scenes", ["scenes/main.js"])
    c.setdefault("lib", [])
    c.setdefault("fonts", {})
    c.setdefault("artist", "")
    return c


def path(p):
    """A path from visualizer.json: relative to the project unless absolute."""
    p = pathlib.Path(p).expanduser()
    return p if p.is_absolute() else ROOT / p


def song(c=None):
    c = c or load()
    s = path(c["song"])
    if not s.exists():
        sys.exit(f"song not found: {s}")
    return s


def duration(wav):
    """The song's length in seconds (ffprobe)."""
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(wav)],
                       capture_output=True, text=True, check=True)
    return round(float(p.stdout.strip()), 3)


def font(size, bold=False):
    """A label font for contact sheets and boards: whatever this machine has."""
    from PIL import ImageFont
    names = ["arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf"]
    dirs = ["C:/Windows/Fonts", "/Library/Fonts", "/System/Library/Fonts/Supplemental", "/usr/share/fonts/truetype/dejavu"]
    for d in dirs:
        for n in names:
            f = pathlib.Path(d) / n
            if f.exists():
                return ImageFont.truetype(str(f), size)
    return ImageFont.load_default()


def pnpm():
    """The command that runs HyperFrames (npx breaks on some npm versions; pnpm dlx is the proven path)."""
    for exe in ("pnpm", "pnpm.cmd"):
        if shutil.which(exe):
            return [shutil.which(exe), "dlx", HYPERFRAMES]
    sys.exit("pnpm not found: install it (npm i -g pnpm) and try again")
