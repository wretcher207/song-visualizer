# The full build, renders and QA

## Before the render

1. **Motion strips across every cue:** `python dev/shot.py --out strips --strip T-1 T+2 12` for each cue in
   `lib/cues.js`. Things move on the cue, nothing pops, nothing jumps. Contrast-stretch a strip if a gradient might be
   banding.
2. **Frame time:** `python dev/shot.py --perf` across the heaviest stretch. Under 250 ms a frame.
3. **Order:** `python dev/shot.py --order 90 30` draws 30 s after 90 s on one page load and 30 s twice on another, and
   compares each with a plain 30 s still. Every count must be 0. Run it at a few points across the song: at least one
   in each scene and one in each stretch where a layer comes and goes, and in the vertical too (`--aspect v`). A
   failure means a frame keeps something from the draw before it: see "Rules that keep every frame exact" in
   `engine.md`.
4. **Check:** `python tools/render.py check` (and `--vertical`). Passes, no errors.

## Rendering

A render on the host GPU (`--browser-gpu`, for a scene that needs it) must have the GPU to itself: a run that overlapped
dev-harness stills came out with a uniform two-level tone shift on every frame and nothing in its log to show for it,
while three clean runs matched the dev still to the pixel. Shoot nothing while it renders, and afterwards diff a few
rendered frames against fresh dev stills at the same times (all must match exactly) and plot mean luma per frame for
steps or a sawtooth.

```bash
python tools/render.py full --detach                # renders/<slug>-frames/, then final/<slug>.mp4
python tools/render.py wait --minutes 25            # repeat until it exits 0; it prints progress each time
python tools/render.py full --vertical --detach     # then the vertical, the same way
python tools/render.py chunks --detach              # the same film as consecutive 54 s windows, assembled: for a drive
                                                    # that cannot hold HyperFrames' temporary copy of every frame (it
                                                    # refuses to start otherwise); resumes a stopped job; seams exact
```

`visualizer.json` `"gpu": "hardware"` makes every render use the host GPU, for a scene SwiftShader cannot run (a
WebGL2 water shader, say). Prove it first: render a short window twice with different worker counts and require every
frame identical, and compare a rendered frame with `dev/shot.py --gpu hw f<N>`.

Always `--detach` a full render. An agent's background commands can be stopped after a time limit (30 minutes was
seen), a full render runs an hour or more, and when a render's parent process is stopped, HyperFrames cancels the
render. A detached job is its own process; `status` and `wait` check on it, and `wait` keeps each check under the
limit. Run the two aspects one after the other, never together: rendering is CPU-bound, and two at once take longer
than one after the other. A 4-minute song is roughly 70 to 80 minutes per aspect on 4 workers; more workers rarely
help. Disk: 8 to 16 GB of PNG frames per aspect. The job counts the frames and fails loudly on a short render; never
judge a render finished from a word in its log.

## QA: every frame, every time

```bash
python tools/qa.py final/<slug>.mp4
```

The report lists black frames, freezes, the flash check (WCAG 2.3.1), one-frame spikes, and writes contact sheets of
every frame. Then:

1. **Read the report.** Any one-frame spike is a bug even if the flash check passed: something drew for a frame that
   shouldn't have (a shape behind the camera, a layer missing). Find it with the frame numbers, fix the scene, patch.
2. **Look at every contact sheet**, start to finish. You're looking for a cut-off subject, a pop, a frame that
   doesn't belong, anything readable that shouldn't be, the end card clipped. Write down what each stretch shows;
   that's your evidence that you looked.
3. Do it again for the vertical.

## Fixing without re-rendering

A fix to a stretch of the film doesn't need the whole render again:

```bash
python tools/render.py patch START LEN      # LEN covering the frames the fix changes, plus a little either side
python tools/render.py encode               # then QA the new master again
```

It renders that window on one worker, compares it with the full render frame by frame, copies in only the frames that
changed (backing up the old ones), and tells you how many matched to the pixel. Expect the frames you meant to change
and no others. If frames outside the fix changed, or changed only faintly, see "Rules that keep every frame exact"
in `engine.md`. Patch the vertical the same way (`--vertical`); its changed frames can differ from the 16:9's.

If the fix landed while a render was already running, that render has the old code: let it finish, then patch it.

When the frames are gone (cleared after QA), splice instead of rendering the film again. Find the master's keyframes
(`ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 final/<slug>.mp4`, the rows with `K`;
frame = round(pts_time × 24)), pick the last keyframe at or before the first changed frame (and, for a fix mid-film,
the first keyframe after the last changed one), render exactly that stretch, and splice it in:

```bash
python tools/render.py window 147.5 9.74 --name endfix          # START = keyframe / 24, to the end of the song
python tools/splice.py --seg 3540:end:renders/endfix-frames     # or START:END for a stretch mid-film; --vertical
```

The kept stretches are stream-copied, so they stay the master's own frames; the tool proves it with per-frame MD5s,
checks the frame numbers run on with no gap at a join, and checks the new stretch lines up with its PNGs (offset 0, not
one frame off). It writes `final/<slug>.spliced.mp4`; QA that, look at the changed stretch's contact sheets, then move
the old master to `final/superseded/` and the spliced one into its place. Before trusting a window, compare its first
frames (before the fix shows) with the old master: they should differ only by the encode.

## Deliverables

```bash
python tools/deliver.py                     # final/<slug>-share.mp4 (full size, 9 Mbps) and -phone.mp4 (under 29 MB)
python tools/deliver.py --vertical
python tools/thumbnail.py 190 "THE" "TITLE" --final
python tools/thumbnail.py 190 "THE TITLE" --vertical --size 130 --top 170 --final
```

- Look at the phone copy at full pixel size in a few busy frames (grain and snow block first).
- Thumbnails: `--font path.ttf` tries a face without changing `visualizer.json` (`--wght` for a variable font's weight,
  `--step` for the line spacing of a loose handwriting face). Render three or four faces and look at them at the
  `-phone` size before settling; a clean geometric sans over a dark picture reads as a label.
- Thumbnails: pick a frame that reads at the size a feed shows it (look at the `-12pct` and `-phone` copies). Never
  crop the subject to fill the frame; at most a 1.15x punch-in. On a pale frame use `--ink dark`. The vertical cover
  keeps its title clear of the right-hand buttons and the bottom caption area; `--left` moves its title off a frame
  edge (a window frame, a door), and `--gap` drops the small label line clear of a deep descender (an italic g).

## The cut page and cleanup

Build the cut page (see `gates.md`): both films streamed, stills of each part, the thumbnail and cover. When the person
accepts it, ask before clearing `renders/` (the frames are the only way to patch without a full re-render, so they go
only once the cut is accepted, and to the Recycle Bin or Trash rather than a hard delete).
