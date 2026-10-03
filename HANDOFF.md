# Song Visualizer: handoff

Status (2026-10-02, evening): public at https://github.com/wretcher207/song-visualizer (David approved creating and
pushing it) and submitted to Anthropic's plugin directory (David approved the four compliance statements; contact
wretched207@icloud.com): https://claude.ai/directory/manage/plugins/f54f3cd5-8b8a-4a12-8cad-9f96803bd392 .
Plugin bundle tracking main, auto-publish on, scheduled check (every ~6 h, no webhook). Data handling: no personal
data, nothing sent elsewhere, not retained, not for under-18s. It sits in policy review on a keyword hold
("uses a credential from the user's machine"): the scanner pairs a word that looks like reading the environment with
anything that looks like sending data, one pair at a time. Cleared so far: `env` in engine.js (now `frameInfo`), a
`${k}=${v}` perf label, `pass` in snow.js (now `shadowStep`). Left for the reviewer: page.tail.html's `db...set()`
(saving marks) with film-player.js's `fetch()` (its own video parts); the README's "What it runs and sends" says so.
David chose free and public, a slimmed engine (2026-10-02). Extracted from `workspace/an-elegy` (the shared engine,
dev harness and tools behind the three an elegy visualizers), generalized to one song per project.

## What's in it

- `.claude-plugin/plugin.json` (v0.1.0, MIT, Dead Pixel Design) and `marketplace.json` (the repo is its own
  marketplace: `/plugin marketplace add wretcher207/song-visualizer`, then `/plugin install song-visualizer@song-visualizer`).
  `claude plugin validate .` passes; `claude -p --plugin-dir .` lists the skill as `song-visualizer:song-visualizer`.
- `skills/song-visualizer/SKILL.md`: the workflow (set up, brief, measure, build, Gate A, Gate B, full build) and the
  rules. `references/`: `brief.md` (intake questions), `engine.md` (scene contract, libraries, exactness rules, speed,
  lessons), `gates.md` (review pages, publishing, reading marks), `render-and-qa.md` (render, QA, patch, deliver).
- `skills/song-visualizer/scripts/new_project.py`: copies `kit/` into a project folder and writes `visualizer.json`,
  `BRIEF.md`, `.gitignore`.
- `kit/lib/`: look, engine, media, snow, endcard (from an-elegy's `shared/lib`, comments made generic; the
  buildReady key is `visualizer-assets`). Left out on purpose: `figure.js` (the ayin hara cover's figure: a brand
  asset) and `sedan.js` (slimmed engine).
- `kit/scenes/main.js`: the starter scene (night snow toward one warm light; speed and density follow FEAT.energy,
  gusts and light pulses on FEAT.on_low; paper tooth; end card if lib/endtype.js exists). 60 ms a frame on SwiftShader.
- `kit/dev/`: shot.py (finds HyperFrames' own headless Chrome first, then puppeteer's, then desktop Chrome or Chromium
  on Windows, macOS, Linux; hw ANGLE per platform), compare.py, frame.template.html.
- `kit/tools/`: project.py (visualizer.json, paths, label fonts, pnpm), check_setup.py, analyze.py (rewritten: own
  librosa beat grid; starter cues from per-band level steps; --scan, --probe, --levels), build.py (roots + vertical
  mirror + dev page + the song as m4a + preview windows; `window.VARIANT` from --set), render.py (check, window, full,
  patch, encode; waits on the process and counts frames), encode.py, qa.py (adds one-frame spike detection),
  deliver.py (share at 9 Mbps two-pass, phone sized under 29 MB), thumbnail.py (font from config, --label),
  endcard_type.py (font from config), review.py (pages from a JSON spec; stills, clips, streamed films; publish
  batches; a .local.html with browser-saved marks and "Copy my marks").
- `kit/review/`: page.head.html and page.tail.html (from an-elegy's gate pages, plus the local-marks fallback),
  film-player.js.
- README.md: written through David's voice profile (Register A).

## Verified 2026-10-02 (scratch projects on the-glow.wav and a-long-way-back.wav, local only, nothing shipped)

- new_project, check_setup, analyze, build, stills in both aspects, perf, compare, end card (Jost), thumbnails, and
  `render.py check` pass on both songs.
- `render.py window 0 6`: 144 frames in 2.5 min, encoded, QA clean, preview.html removed afterwards.
- `render.py --detach`, `status`, `wait` (added after a 30-minute background limit stopped a full test render and
  HyperFrames cancelled with "render_cancelled_parent_exited"): a detached 2 s window finished on its own, `wait` exited
  0, preview.html was removed. Windows starts the job through WMI with a hidden console of its own (Start-Process
  children went down with the launching command; a WMI process without a console exits at once in pnpm's shim);
  macOS and Linux use a new session (not tested there). HyperFrames also watches every ancestor process and cancels
  if one exits (`captureRenderAncestors`); under WMI the provider host exits about 88 s in, so detached jobs set
  HYPERFRAMES_RENDER_DETACHED=1, its own switch for this. A detached 10 s window then ran 4.2 min to the end.
  Every pnpm call gets no stdin: when pnpm's dlx cache expires it reinstalls HyperFrames and, given a console, asks
  which packages to build (esbuild) and waits forever (seen: a detached full render hung 25 min on that prompt).
- `render.py patch`: with a test mark planted at 2.2 to 2.5 s, exactly frames 53 to 59 changed and the other 17
  matched to the pixel. (The first try also changed the horizon row in the first frames after the page loaded: the
  horizon sat at y 669.6. Layout edges are rounded now, and the tool warns about faint differences.)
- qa.py's spike check flags the an elegy cabin flashes (two single frames up 0.11) and ignores fades and hard cuts.
- review.py: a page with a still, a clip and a streamed film; served locally, marks, chips, browser storage, "Copy my
  marks" and the Media Source film player all work.
- Starter cues on the-glow land near the measured cues (hats out 131.00 vs 131.25, hats back 174.80 vs 174.89, swells
  within 0.1 s); on a-long-way-back they're looser (one 4 s late on a fading hat line). The skill says to check every
  cue with --scan.

## Not done yet

- Full-length render through the kit (a-long-way-back.wav, starter scene, local scratch project): `render.py full
  --detach` rendered 4,320 frames in 82.1 min and encoded; `qa.py`: no black, no freeze, flash check passed, no
  one-frame spikes (largest change 0.005); all 36 sheets looked at. The vertical: 4,320 frames in 73.6 min, QA clean (largest change 0.006, no spikes), all
  45 sheets looked at. `deliver.py`: share copies 199 MB (9 Mbps), phone copies 28.3 MiB / 29.7 MB at 1,183 kbps,
  checked at full pixel size. The whole path (new project to finished films) is proven on Windows.
- Not tested on macOS or Linux (paths and Chrome lookup are written for them).
- Directory review: check the plugin page for the scan result and the reviewer's decision.
- Icon: `.claude-plugin/icon.svg` (a warm light on a dark horizon, snow), simple placeholder until there's a real still to base it on.
- A real worked example in the README (a short clip or still) once there's one to show.

## Ready on branch v0.1.1-no-shell (not pushed)

2026-10-02: the listing covers the Claude web and mobile apps, where the skill can't run. The branch adds a setup line
telling Claude to say up front that it needs Claude Code on the person's computer, and bumps the version to 0.1.1.
Held off main so the v0.1.0 review isn't disturbed; merge and push after approval. Same day, a fresh project from
590c342 passed check_setup, analyze, build and a starter-scene still.
