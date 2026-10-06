# The engine

A project draws one canvas per frame. HyperFrames seeks a timeline, the page calls `FILM.render(t)`, and the scene
draws the whole frame for that time. The same code draws 1920x1080 (`index.html`) and 1080x1920
(`vertical/index.html`); the frame size comes from the canvas.

Load order (written by `tools/build.py`): `lib/look.js`, `engine.js`, `media.js`, `snow.js`, `endcard.js`,
`features.js`, `cues.js`, `endtype.js` (if made), any `lib` entries from `visualizer.json`, `timeline.js`, then the
scenes. Each library's header comment is its full API reference: read it before using it.

## The scene contract

```js
FILM.scene("name", {
  layout(env) { ... return positions for env.W x env.H (env.vertical) },   // once
  init(env, lay) { ... bake canvases, build geometry, make clocks },        // once, after assets load
  draw(ctx, t, env, lay) { ... draw the whole frame for song time t },     // every frame
});
```

`timeline.js` says which scene owns each moment: `FILM.timeline = [{ name, start, end, grain }]` (grain: the engine's
film grain, default 0.12; set 0 if the scene lays its own). One scene for the whole song is normal; switch scenes for
hard cuts. A scene can draw another inside it: `env.drawScene("other", ctx, t)`.

`env`: `W`, `H`, `vertical`, `t`, `f` (frame number), `b` (boil index: changes every second frame, for hand-drawn line
wobble on twos), `at(table, t)` (sample a per-frame table such as `FEAT.energy`).

## The libraries

- **LOOK** (`look.js`): seeded randomness (`rng(seed)`, `hash(a, b, c)`), noise (`noise1`, `noise2`, `fbm2`), easing
  (`ease.sineIO` and friends), colour (`hex`, `mix`, `css`), canvases (`canvas(w, h)`), hand-drawn ink (`boil`,
  `stroke`, `fill`, `taperedLine`, `hatch`), `glow`, grain.
- **SNOW** (`snow.js`): tens of thousands of marks in 3D on WebGL2 (snow, dust, ash, sparks), each position closed-form
  in a clock, so any frame is exact. `camera()`, `clock(n, fps, speed(i), wind(i))` (a freeze is speed 0; a gust is a
  bump in the wind), `field({ shells })`, `field.render({...})`: depth of field, streaks from a 180-degree shutter,
  ink mode (charcoal and chalk marks over a pale frame), an attractor (marks drift to a point), shadows, a projector
  that throws a picture onto the flakes. Draw it with `FILM.blit(ctx, field.gl, "screen")` (light) or source-over (ink).
- **MEDIA** (`media.js`): toned paper and its tooth, graphite and coloured pencil, charcoal, chalk, hatching that
  only accumulates, erasure ghosts, and a GPU field for strokes that grow by the tens of thousands (frost).
- **ENDCARD** (`endcard.js`): the artist and title from outlines baked by `tools/endcard_type.py` (set
  `fonts.endcard` in `visualizer.json`).
- **FEAT** (`features.js`, from `tools/analyze.py`): per-frame tables (`energy`, `low`, `mid`, `high`, `on_low`,
  `on_mid`, `on_high`, `rms`, `centroid`, `grow`, `beat`, `downbeat`, `barpos`, `phase`) plus `beats`, `downbeats`,
  `bpm`, `duration`.
- **CUE** (`cues.js`): named times. Scenes read names (`CUE.hatsOut`), never magic numbers.

## Rules that keep every frame exact

HyperFrames renders frames out of order on several workers, and a fix gets patched in by re-rendering a short window
on one worker. Both only work if a frame depends on nothing but its time.

- **No clocks, no `Math.random`, no state carried between frames.** Seed everything (`LOOK.rng(seed)`). Anything that
  accumulates over time (a snow clock, growth) is a table built once in `init` and sampled at `t`.
- **Hard edges on whole pixels.** A fill that stops at y = 669.6 leaves a half-covered row, and the first frames after
  a page loads blend that row slightly differently from later ones. A patch window then won't match the full render.
  `Math.round` layout edges.
- **Check a shape is in front of the camera before you draw it.** Testing only a shape's centre lets a corner behind
  the camera project into a huge shape across the frame for a frame or two while the camera turns. Test every corner
  of its bounds (`cam.project(p)[2] > near`). QA's one-frame spike check catches this; better not to need it.
- **Draw WebGL into the frame with `FILM.blit`**, never `ctx.drawImage(gl.canvas)`: the first time a 2D canvas draws a
  WebGL canvas, Chrome moves it to the GPU path, every later 2D call gets 5 to 50 times slower on the software GPU, and
  that first frame rounds differently.
- **Load images with `FILM.asset(url)`**: it holds the render until they arrive.
- **A frame's time is the exact double (N - 1) / 24.** A render's first draw of frame N comes through the `hf-seek`
  handler at that value (the GSAP tween's value, rounded to a microsecond, arrives second and hits the redraw guard).
  A dev still shot at a time rounded to six decimals can differ from the render by a level in a few hundred pixels
  of fast-moving detail. `dev/shot.py f<N>` shoots rendered frame N at its exact time; compare it with
  `renders/<slug>-frames/frame_<N>.png` and expect zero difference.
- **Test order independence:** `dev/frame.html?seq=90,30` renders 90 s then 30 s and shows the last; compare it with a
  plain 30 s still.

## Speed

Renders use the software GPU (SwiftShader), so time frames there: `python dev/shot.py --perf T0 T1 40`. Budget 250 ms
a frame at 1080p; `--split` times each stage marked with `FILM.mark("name", flush)`. What costs most: full-frame blurs
and composites (do them at half or quarter size and scale up), reading pixels back, and per-stroke 2D calls in the
tens of thousands (move those to the GPU). Bake anything still once in `init`.

## Things learned the hard way

- Flakes a metre or two from the lens render as big grey capsules. Push the nearest shell back (start it at 3 to 4 m)
  and fade the nearest (`flake.nearFade: [from, to]`).
- A fine texture over the frame (paper tooth, grain) needs real strength to show at all; at a quarter of what reads,
  it moves the frame by one level. Check it in a full-size crop.
- A radial gradient over a large area bands into rings at 8 bits. Lay grain over it to dither.
- At phone width, what reads is big shapes and contrast. A detail that only reads at full size doesn't exist for
  most viewers: check stills at 640 px wide (`--small 640`).
- Layouts are per aspect. Place the subject for 9:16 on purpose; don't crop the 16:9.
