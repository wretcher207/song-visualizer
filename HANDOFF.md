# Song Visualizer: handoff

Status (2026-10-02): first working version, local only. Not on GitHub yet, not submitted to the plugin directory.
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

- Not run end to end through a full-length render in a project made by the kit (the full-render path is the same
  code that rendered the an elegy films, wrapped; the window and patch paths are tested).
- Not tested on macOS or Linux (paths and Chrome lookup are written for them).
- No GitHub repo yet: creating it public is publishing, so it waits for David's go. Then the plugin directory
  submission (see `second-brain/knowledge/claude-plugin-directory-submission.md`: repo root as the plugin, files under
  256 KiB, every userConfig with a default; there's no userConfig here).
- No icon (`.claude-plugin/icon.svg`, as Reaper Daemon has).
- A real worked example in the README (a short clip or still) once there's one to show.
