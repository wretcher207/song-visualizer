// The starter scene: night snow falling toward one warm light on the horizon, driven by the song. It is here so a new
// project renders something real on day one, and as a worked example of the scene contract. Replace it with your own
// world; keep the shape (layout, init, draw) and the rules (a pure function of t: no clocks, no Math.random).
//
// What the music does to it (all from lib/features.js, so it lines up with the song to the frame):
//   - the snow falls faster as the song gets louder (FEAT.energy) and thickens with it
//   - every kick and bass hit (FEAT.on_low) is a gust that pushes the flakes sideways and brightens the light
//   - the last seconds bring up the end card (lib/endtype.js, from tools/endcard_type.py), if there is one
// Cue the big moments by name from lib/cues.js (CUE.s1, or whatever you rename them to), never by magic numbers.
(function () {
  const L = LOOK;
  const FPS = 24;
  let SKY = null; // the backdrop, baked once per frame size
  let FIELD = null; // the snow (WebGL2), drawn into the frame as light
  let CLOCK = null; // the snow's own clock: how far it has fallen and blown by each frame
  let CAM = null;

  FILM.scene("main", {
    // Positions for this frame size: 16:9 and 9:16 share every line of code below.
    layout(env) {
      const { W, H, vertical } = env;
      // hard edges go on whole pixels: a fill that stops at y = 669.6 leaves a half-covered row, and the first frames
      // after a page loads blend that row a level or two differently, so a re-rendered window wouldn't match
      const horizon = Math.round(vertical ? H * 0.58 : H * 0.62);
      return {
        horizon,
        light: [Math.round(vertical ? W * 0.62 : W * 0.66), horizon],
        F: vertical ? 1.15 * W : 0.85 * W, // focal length in px: the vertical sees a narrower slice of the world
        S: Math.min(W, H),
      };
    },

    init(env, lay) {
      const { W, H } = env;
      // the backdrop: a dark sky over a dark snowfield, a haze along the horizon
      SKY = L.canvas(W, H);
      const g = SKY.getContext("2d");
      const sky = g.createLinearGradient(0, 0, 0, lay.horizon);
      sky.addColorStop(0, "#0b1018");
      sky.addColorStop(1, "#27303f");
      g.fillStyle = sky;
      g.fillRect(0, 0, W, lay.horizon);
      const ground = g.createLinearGradient(0, lay.horizon, 0, H);
      ground.addColorStop(0, "#2a313d");
      ground.addColorStop(1, "#0d1016");
      g.fillStyle = ground;
      g.fillRect(0, lay.horizon, W, H - lay.horizon);
      const haze = g.createLinearGradient(0, lay.horizon - 0.08 * H, 0, lay.horizon + 0.05 * H);
      haze.addColorStop(0, "rgba(70,80,96,0)");
      haze.addColorStop(0.7, "rgba(70,80,96,0.55)");
      haze.addColorStop(1, "rgba(70,80,96,0)");
      g.fillStyle = haze;
      g.fillRect(0, Math.round(lay.horizon - 0.08 * H), W, Math.round(0.13 * H));

      // the camera at eye height looking at the horizon; the snow lives in its space
      CAM = SNOW.camera({ pos: [0, 1.6, 0], F: lay.F, W, H, cx: W / 2, cy: lay.horizon, near: 0.05, far: 2000 });
      // the snow clock: the fall speed follows the song's loudness, the wind gusts on the low end's hits
      CLOCK = SNOW.clock(
        FEAT.n,
        FPS,
        (i) => 0.45 + 0.55 * FEAT.energy[i],
        (i) => [-0.25 - 2.2 * FEAT.on_low[i] * (0.3 + 0.7 * FEAT.energy[i]) + 0.2 * L.noise1(11, i / (FPS * 7)), 0, 0],
      );
      // three shells of flakes, near to far, each wide enough to fill the frame at its far edge
      const shell = (z0, z1, count) => {
        const hx = ((W / 2) * z1) / lay.F + 3;
        return { center: [0, 4, (z0 + z1) / 2], size: [hx * 2, 10, z1 - z0], count };
      };
      FIELD = SNOW.field({ W, H, seed: 7, shells: [shell(4, 12, 900), shell(12, 40, 4500), shell(40, 140, 5000)] });
    },

    draw(ctx, t, env, lay) {
      const { W, H } = env;
      const energy = env.at(FEAT.energy, t);
      const hit = env.at(FEAT.on_low, t);
      ctx.drawImage(SKY, 0, 0);

      // the light: steady, a little brighter on every hit, warmer and wider as the song builds
      const [lx, ly] = lay.light;
      const r = lay.S * (0.035 + 0.025 * energy) * (1 + 0.35 * hit);
      L.glow(ctx, lx, ly, r * 6, "255,170,100", 0.18 + 0.2 * energy, "lighter");
      L.glow(ctx, lx, ly, r * 2, "255,196,140", 0.45 + 0.3 * hit, "lighter");
      L.glow(ctx, lx, ly, r * 0.5, "255,236,210", 0.9, "lighter");

      // the snow, with a 180-degree shutter (where each flake was 1/48 s ago gives its streak)
      const now = SNOW.sampleClock(CLOCK, t);
      const prev = SNOW.sampleClock(CLOCK, t - 1 / 48);
      FIELD.render({
        cam: CAM,
        tau: now.tau,
        tauPrev: prev.tau,
        gust: now.gust,
        gustPrev: prev.gust,
        density: 0.35 + 0.65 * energy,
        flake: { size: 0.02, gain: 0.9, ambient: [0.45, 0.5, 0.6], fog: 80, focus: 18, aperture: 0.012, sway: 0.3, curl: 0.4, nearFade: [3, 5.5] },
        seed: env.b,
      });
      FILM.blit(ctx, FIELD.gl, "screen");
      FILM.mark("snow", () => ctx.getImageData(0, 0, 1, 1));

      // a paper tooth over everything, so it reads as drawn rather than rendered
      ctx.save();
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = 0.22;
      ctx.drawImage(MEDIA.tooth(W, H, 3), 0, 0);
      ctx.restore();

      // the end card over the last seconds, if tools/endcard_type.py has made lib/endtype.js
      if (window.ENDTYPE) {
        ENDCARD.draw(ctx, t, env, {
          t0: FEAT.duration - 7,
          fade: 2.2,
          cx: W / 2,
          y: env.vertical ? H * 0.3 : H * 0.34,
          width: W * (env.vertical ? 0.34 : 0.17),
          color: [196, 202, 214],
        });
      }
    },
  });
})();
