"""Write the project's HyperFrames pages from visualizer.json, so the 16:9 and 9:16 never drift apart.

  python tools/build.py                 index.html (1920x1080), vertical/index.html (1080x1920, a project of its own:
                                        HyperFrames renders one root per folder), dev/frame.html (the dev harness), the
                                        song as assets/<slug>.m4a, and timeline.js if there isn't one
  python tools/build.py --preview 126 12 [--vertical] [--set k=v ...]
                                        preview.html: a window of the song (from 126 s, 12 s long) for Gate B previews,
                                        patch windows and render tests. Render it with `-c preview.html`; delete it
                                        before running `check` (a second root fails lint). --set puts
                                        window.VARIANT = {k: v} before the scripts: a review variant the scene reads
                                        (the dev page takes the same as a query: dev/shot.py --q "k=v")
Run it again after any change to visualizer.json, lib/, scenes/ or timeline.js: it re-mirrors vertical/.
"""
import json, os, pathlib, re, shutil, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
ENGINE = ["lib/look.js", "lib/engine.js", "lib/media.js", "lib/snow.js", "lib/endcard.js"]

TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={W}, height={H}" />
    <title>{title}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }}
      html,
      body {{
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: {bg};
      }}
      #root {{
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }}
      #scene {{
        position: absolute;
        inset: 0;
      }}
      #stage {{
        display: block;
        width: 100%;
        height: 100%;
      }}
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="{dur}"
      data-width="{W}"
      data-height="{H}"
    >
      <div id="scene" class="clip" data-start="0" data-duration="{dur}" data-track-index="0">
        <canvas id="stage" width="{W}" height="{H}"></canvas>
      </div>
      <audio
        id="music"
        src="{audio}"
        data-start="0"{media_start}
        data-duration="{dur}"
        data-track-index="10"
        data-volume="1"
      ></audio>
    </div>
{scripts}
    <script>
      (() => {{
        // The frame size comes from the canvas, so this file and its 16:9 / 9:16 twin share all the code.
        FILM.attach(document.getElementById("stage"));
        // Setter-backed clock: every timeline seek writes clock.t, which renders that exact frame.
        // HyperFrames seeks each frame several times; the redraw guard in lib/engine.js draws it once.
        // The draw waits for the end of the current task (a microtask): HyperFrames' preview runtime (check, the
        // studio) sweeps the whole timeline in 1/60 s steps in one go after the page loads, and drawing every step
        // of that held a heavy scene's page load for minutes. A sweep now draws
        // once, where it stops; a render's seek is drawn before control returns to the capture.
        let now = 0;
        let queued = false;
        const clock = {{}};
        Object.defineProperty(clock, "t", {{
          get() {{
            return now;
          }},
          set(v) {{
            now = v;
            if (queued) return;
            queued = true;
            queueMicrotask(() => {{
              queued = false;
              FILM.render(now);
            }});
          }},
        }});
        const OFF = {off}; // where this file starts in the song (0 except for previews)
        const tl = gsap.timeline({{ paused: true }});
        tl.to(clock, {{ t: OFF + {dur}, duration: {dur}, ease: "none" }}, 0);
        clock.t = OFF;
        window.addEventListener("hf-seek", (e) => FILM.render(OFF + e.detail.time));
        window.__timelines = window.__timelines || {{}};
        window.__timelines["main"] = tl;
      }})();
    </script>
  </body>
</html>
"""


def scripts(c):
    s = list(ENGINE) + ["lib/features.js", "lib/cues.js"]
    if (ROOT / "lib" / "endtype.js").exists():
        s.append("lib/endtype.js")
    return s + [x for x in c["lib"] if x not in s] + ["timeline.js"] + c["scenes"]


def page(c, dur, W, H, off=0.0, win=None, variant=None):
    NL = chr(10)
    tags = NL.join(f'    <script src="{s}"></script>' for s in scripts(c))
    if variant:
        tags = f"    <script>window.VARIANT = {json.dumps(variant)};</script>" + NL + tags
    length = win or dur
    return TEMPLATE.format(
        W=W, H=H, title=c["title"] + (" preview" if win else ""), bg=c["bg"], dur=round(length, 3),
        audio=f"assets/{c['slug']}.m4a", scripts=tags, off=off,
        media_start=(NL + f'        data-media-start="{off}"') if off else "",
    )


def audio(c):
    """The song as AAC for the HyperFrames page (the WAV stays the master: tools/encode.py muxes from it)."""
    wav = project.song(c)
    out = ROOT / "assets" / f"{c['slug']}.m4a"
    out.parent.mkdir(exist_ok=True)
    if not out.exists() or out.stat().st_mtime < wav.stat().st_mtime:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "256k", str(out)], check=True)
    return wav


def frame_html(c):
    tags = chr(10).join(f'    <script src="../{s}"></script>' for s in scripts(c))
    return (ROOT / "dev" / "frame.template.html").read_text(encoding="utf-8").replace("__SCRIPTS__", tags)


def mirror():
    """vertical/ gets the same code; the audio is hard-linked (or copied where links aren't allowed)."""
    v = ROOT / "vertical"
    for sub in ("lib", "scenes"):
        if (v / sub).exists():
            shutil.rmtree(v / sub)
        shutil.copytree(ROOT / sub, v / sub)
    shutil.copyfile(ROOT / "timeline.js", v / "timeline.js")
    (v / "assets").mkdir(exist_ok=True)
    for a in [f for f in (ROOT / "assets").iterdir() if f.is_file()]:
        dst = v / "assets" / a.name
        if dst.exists() and dst.stat().st_size == a.stat().st_size and dst.stat().st_mtime >= a.stat().st_mtime:
            continue
        if dst.exists():
            dst.unlink()
        try:
            os.link(a, dst)
        except OSError:
            shutil.copyfile(a, dst)


def main():
    c = project.load()
    wav = audio(c)
    dur = project.duration(wav)
    for need in ("lib/features.js", "lib/cues.js"):
        if not (ROOT / need).exists():
            sys.exit(f"{need} is missing: run python tools/analyze.py first")
    if "--preview" in sys.argv:
        i = sys.argv.index("--preview")
        off, win = float(sys.argv[i + 1]), float(sys.argv[i + 2])
        win = min(win, dur - off)
        W, H = (1080, 1920) if "--vertical" in sys.argv else (1920, 1080)
        variant = dict(b.split("=", 1) for a, b in zip(sys.argv, sys.argv[1:]) if a == "--set")
        (ROOT / "preview.html").write_text(page(c, dur, W, H, off, win, variant), encoding="utf-8")
        print(f"wrote preview.html: {off} s to {off + win} s at {W}x{H}" + (f", variant {variant}" if variant else ""))
        return
    tl = ROOT / "timeline.js"
    if not tl.exists():
        name = pathlib.Path(c["scenes"][-1]).stem
        tl.write_text(chr(10).join([
            "// One continuous shot for the whole song. The length comes from lib/features.js.",
            "FILM.duration = FEAT.duration;",
            f'FILM.timeline = [{{ name: "{name}", start: 0, end: FEAT.duration }}];',
            "",
        ]), encoding="utf-8")
    (ROOT / "index.html").write_text(page(c, dur, 1920, 1080), encoding="utf-8")
    (ROOT / "vertical").mkdir(exist_ok=True)
    (ROOT / "vertical" / "index.html").write_text(page(c, dur, 1080, 1920), encoding="utf-8")
    (ROOT / "dev" / "frame.html").write_text(frame_html(c), encoding="utf-8")
    mirror()
    print(f"built {c['slug']}: {dur} s, index.html + vertical/index.html + dev/frame.html, {len(scripts(c))} scripts")


if __name__ == "__main__":
    main()
