"""Start a visualizer project: copy the kit (engine, dev harness, tools, starter scene) into a folder and point it at a song.

  python new_project.py PROJECT_DIR --song SONG.wav --title "my song" [--artist "the artist"] [--slug my-song]

The song stays where it is (visualizer.json points at it); the project gets its own copy of every tool, so it keeps
working whatever happens to the plugin later. Refuses to write into a folder that already has a visualizer.json.
"""
import argparse, json, pathlib, re, shutil, sys

KIT = pathlib.Path(__file__).resolve().parent.parent / "kit"

BRIEF = """# {title}: the brief

Fill this in before any drawing. Every later decision is checked against it, and the review pages quote it.

## Intent
One or two sentences: what the film is about and how it should feel. (an elegy's: "a hometown that makes you feel sick
to your stomach and at home at the same time.")

## Place and world
Where it happens, what's in it, what time of day and weather. Real places are fine; say what is never labelled.

## Rules (true on every frame)
- e.g. no faces; one steady warm light; frame one moves with the sound off; nothing readable.
- A pure function of time: every frame can be drawn on its own, in any order.

## Look
References (painters, films, photos), palette, the media it should feel made in (charcoal, pencil, paint, film).

## Cue sheet
Measured from the song (tools/analyze.py; pin each with --probe or --scan). "section" times are rough until pinned.

| Time | Music | Picture |
| --- | --- | --- |
| 0:00 | | |

## Key frames (Gate A)
Four to seven times that, as stills, prove the film: the opening, the biggest moment, the turn, the ending.

## Preview (Gate B)
One 10 to 15 second window across the hardest change in the song (a drop, a stop, a build), rendered for real.

## Acceptance
What has to be true of the finished cut (reads at phone size, holds in 9:16, nothing cut off, no flashes).
"""

GITIGNORE = """renders/
dev/out/
vertical/
preview.html
final/*.mp4
final/qa_*/
final/superseded/
review/media*/
review/.film-cache/
__pycache__/
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--song", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", default="")
    ap.add_argument("--slug", default=None)
    a = ap.parse_args()
    dst = pathlib.Path(a.project).expanduser().resolve()
    song = pathlib.Path(a.song).expanduser().resolve()
    if not song.exists():
        sys.exit(f"song not found: {song}")
    if (dst / "visualizer.json").exists():
        sys.exit(f"{dst} already has a visualizer.json; not overwriting it")
    slug = a.slug or re.sub(r"[^a-z0-9]+", "-", a.title.lower()).strip("-") or "song"
    dst.mkdir(parents=True, exist_ok=True)
    for sub in ("lib", "dev", "tools", "scenes"):
        shutil.copytree(KIT / sub, dst / sub, dirs_exist_ok=True)
    shutil.copytree(KIT / "review", dst / "review" / "src", dirs_exist_ok=True)
    for sub in ("assets", "final", "renders"):
        (dst / sub).mkdir(exist_ok=True)
    cfg = {"slug": slug, "title": a.title, "artist": a.artist, "song": str(song), "bg": "#0b0d12",
           "scenes": ["scenes/main.js"], "lib": [], "fonts": {}}
    (dst / "visualizer.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    if not (dst / "BRIEF.md").exists():
        (dst / "BRIEF.md").write_text(BRIEF.format(title=a.title), encoding="utf-8")
    if not (dst / ".gitignore").exists():
        (dst / ".gitignore").write_text(GITIGNORE, encoding="utf-8")
    print(f"new project {slug} in {dst}")
    print("next: python tools/check_setup.py, then python tools/analyze.py, then python tools/build.py")


if __name__ == "__main__":
    main()
