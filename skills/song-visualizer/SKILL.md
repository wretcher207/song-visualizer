---
name: song-visualizer
description: Make a music visualizer for a song, drawn entirely in code and cued to the song's measured hits, rendered to video with HyperFrames. Takes a WAV and a short brief, measures the audio, writes the cue sheet, and walks through key frames, a short preview, the full 16:9 and vertical renders, a check of every frame, the upload copies, thumbnails and a review page for each stage. Use when someone wants a visualizer, lyric-free music video, animated loop or "something like those code-drawn videos" for a song, or wants to resume or re-render a project made this way (a folder with visualizer.json, timeline.js and tools/render.py).
---

# Song visualizer

This is the workflow behind a set of code-drawn music videos: every frame drawn in JavaScript on canvas and WebGL,
rendered frame by frame with HyperFrames, no AI image or video generation, timed to the song to the frame. It works
because of three habits, and the tools here exist to make them cheap:

1. **Measure, don't eyeball.** Every cue comes from the audio file: where the bass comes in, where the hats stop, the
   hit that isn't there. A picture that moves on the exact frame its sound starts is what people notice.
2. **Gates before hours.** Key frames as stills, then a 10 to 15 second preview with sound, then the full render. The
   person reviews each on a page and marks every card "ok" or "work". Nothing renders for an hour until the stretch
   that's hardest has passed.
3. **Look at every frame.** Every export gets a full check (black, freezes, flashes, one-frame glitches) and contact
   sheets of every frame, and you look at every sheet. Sampled checks are not checks.

Files this skill refers to are relative to this skill's base directory. The person's project is its own folder with
its own copy of the tools; run every project command from the project folder.

## 0. Set up

```bash
python <skill>/scripts/new_project.py <project-dir> --song <song.wav> --title "the title" --artist "the artist"
cd <project-dir>
python tools/check_setup.py --render
```

`check_setup.py` names anything missing (Python packages, ffmpeg, Node, pnpm, a headless Chrome) with the command that
fixes it. HyperFrames runs through `pnpm dlx hyperframes@0.8.77`, pinned; the first run downloads it and its Chrome.
Tell the person up front what this costs in machine time: on a 4-core CPU a full render took 20 to 27 seconds per
second of song per aspect for scenes at 100 to 200 ms a frame (a 4-minute song: about 70 to 80 minutes for 16:9 and
again for 9:16). A lighter scene renders faster; time it with `dev/shot.py --perf` and scale.

## 1. The brief (before any drawing)

Fill `BRIEF.md` with the person. Read `references/brief.md` for the questions to ask and what a good answer looks
like. The brief's rules (things true on every frame) and its intent sentence are what every later choice is checked
against. Words that will appear on screen or in captions go through the person's own voice or style guide if they
have one.

## 2. Measure the song

```bash
python tools/analyze.py                        # lib/features.js (per-frame tables) and a starter lib/cues.js
python tools/analyze.py --scan 124 142         # every onset, gap and dropout per band in a window
python tools/analyze.py --probe 39.9:low       # the exact onset nearest a time, to the frame
```

The starter cues are rough (where a band steps up or down by 9 dB or more). Rename each to what happens there
(`bassIn`, `hatsOut`), check each with `--scan`, pin it, and mark it "onset" in the comment. A drop's real cue is often
the first hit that doesn't come: if the hats land every 0.34 s and the last one is at 130.56, the cue is 131.25.
Fill the brief's cue sheet from these.

## 3. Build the world

The starter scene (`scenes/main.js`: snow falling toward a light, gusting on the kick) renders on day one. Replace it
with the brief's world. `references/engine.md` has the scene contract, the drawing libraries (LOOK, SNOW, MEDIA,
ENDCARD) and the rules that keep frames identical however they're rendered. After any change to `lib/`, `scenes/`,
`timeline.js` or `visualizer.json`, run `python tools/build.py`.

```bash
python dev/shot.py --out look 12 60 130            # full-size stills (add --aspect v for 9:16, --small 640)
python dev/shot.py --out walk --strip 39 41 12     # a motion strip across a cue
python dev/shot.py --perf 120 128 40               # ms per frame on the software GPU renders use; budget 250 ms
```

Look at what you draw, at full size and at phone width, in both aspects. Ask a fresh agent with no context what it
sees in a still (neutral file name, no hints) when something has to read as a specific thing.

## 4. Gate A: key frames

Stills at the brief's key-frame times, 16:9 and 9:16, on a review page. `references/gates.md` covers building the
page (`tools/review.py`), publishing it, and reading the marks back. Apply every "work" note before moving on.

## 5. Gate B: the preview

The hardest 10 to 15 seconds, rendered for real with sound:

```bash
python tools/render.py window 126 12 --name gateb
python tools/qa.py dev/out/gateb.mp4 --start 126
```

Look at every contact sheet, then put it on a page with any calls you made. Apply the marks.

## 6. The full build

`references/render-and-qa.md` is the checklist: motion strips across every cue, `render.py check`, the 16:9 then the
vertical (one at a time: two renders at once only slow both), QA on every frame of both, fixes patched in with
`render.py patch` instead of a re-render, `deliver.py` for the share and phone copies, `thumbnail.py` for the
thumbnail and vertical cover, and a cut page with both films. Leave the rendered frames on disk until the person
accepts the cut, then ask before deleting them (they're large: 8 to 16 GB per aspect).

## Rules that hold everywhere

- A frame is a pure function of its time: no clocks, no `Math.random`, nothing carried over from the frame before.
  Seeded randomness (`LOOK.rng`, `LOOK.hash`) and per-frame tables only.
- Never report a check you didn't run. QA means every frame and every sheet looked at; say exactly what was checked.
- Never wait for a render by watching its log for a word: a log says "0 error(s)" long before it's done. `render.py`
  waits on the process and counts the frames.
- Don't render while another render runs, and don't edit a scene a render has loaded and expect the render to see it:
  a fix after the render started is a patch.
- Keep one current version of each deliverable in `final/`. Superseded cuts go in `final/superseded/`.
- Ask before deleting anything the person might want back (render frames, old cuts). The Recycle Bin or Trash beats
  a hard delete.
