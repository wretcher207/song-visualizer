// Deterministic 3D snow (or dust, ash, sparks: any small marks in the air), on an offscreen WebGL2 canvas that the scene draws into its
// 2D frame as light (ctx.globalCompositeOperation = "screen"; ctx.drawImage(field.canvas, 0, 0)).
//
// Every flake is one GL point whose position is closed-form in a snow clock tau (never integrated):
//   p = base + fall * tau + gust(tau) + sway(tau) + curl(base, tau), wrapped in its shell box.
// base, fall speed, sway, size and mark all come from an integer hash of the flake id in the shader, so
// seeking is exact and workers can render out of order. tau and the gust offset are per-frame tables the
// scene bakes in init (SNOW.clock): a freeze is the speed going to 0, a gust is a bump in the wind.
//
//   const field = SNOW.field({ W, H, seed, shells: [{ center, size, count, sizeK, gainK, edge }], hazeScale,
//                              ink: false, markStyle: "pencil" | "charcoal" });
//     ink: marks laid over the frame instead of light added to it (charcoal and chalk on fog): the canvas
//     has alpha, premultiplied, and goes in with plain source-over
//   field.render({
//     cam, camPrev,             SNOW.camera(...) now and 1/48 s earlier (180-degree shutter)
//     tau, tauPrev, gust, gustPrev,
//     density,                  0..1 share of flakes in the air (each flake has a fixed threshold)
//     flake: { size, gain, ambient: [r,g,b], fog, focus, aperture, sway, curl, maxStreak (px, default 160),
//              nearFade: [from, to] (metres: flakes nearer than `to` fade out, gone at `from`; default off) },
//     projector: {              optional: a light that throws a picture
//       cam, texture, key,      the projector (SNOW.camera), its frame (a canvas whose alpha is the gate),
//                               and a key that changes only when the frame does (so it uploads only then)
//       pic, coherence,         optional mat3 (SNOW.homography): the picture pinned in screen space, used
//                               for flakes deeper than coherence[0..1] metres (a picture thrown onto falling snow, below)
//       gain, ref, falloff, lod, boothLod, nearDim, leak, weave: [dx, dy, rot] }
//     haze: { gain, lod, falloff, maxT, groundY, leak, picture },   optional (needs a projector); picture (0..1,
//                               default 1): how much of the pinned picture the haze carries (0: the lamp's tint only)
//     vignette: [cx, cy, r0, strength, r1],   optional, px with y down
//     ink: { dark: [r,g,b], light: [r,g,b], chalk: 0..1, gain },  ink fields: the charcoal and chalk colours (0..1),
//                               the share of flakes in chalk, and how dark a mark gets
//     glint: { x, y, r, k },      ink fields: marks seen within about r px of (x, y) (canvas pixels) take on the
//                                 attractor colour, up to k (a light they hang in front of)
//     attractor: { pos: [x,y,z], t, dur, spread, swirl, color },  optional: every flake leaves where it is (after its
//                               own delay, up to spread s) and drifts in to circle pos over about dur s, t s after it
//                               began; ink marks take on color as they near it
//     shadow: { light: [x,y,z], size, k, stretch, color, max, minPx, mode, reach, top, shells },  ink fields: each flake also lays
//                               its shadow on the snow, drawn under all the flakes in the same pass (shells: the
//                               indices of the shells that cast one; all by default)
//                               (y = 0): where the line from the light through it meets the
//                               ground, soft with the light's size (m) the farther it falls, laid out long along the
//                               ground (stretch times the grazing light's own), alpha k times the share of the light
//                               the flake hides, fading with distance and as the flake goes to an attractor. mode
//                               "foot": drawn from the snow under the flake out away from the light (up to reach m);
//                               only flakes below top (m) throw one, fainter the higher they hang
//     exposure, seed,
//   })  -> field.canvas
//
// Marks: an atlas of hand-drawn dabs (columns) at increasing blur (rows), baked once in 2D. Out-of-focus
// flakes pick a blurrier row and spread their light (alpha falls as 1/r^2), so near flakes don't bloom.
// Streaks are the dab swept from p(tauPrev) to p(tau), alpha scaled by size / (size + length).
// Projected texture: each flake runs through the projector's matrices in the vertex shader; outside the
// frustum and gate it is unlit. With the projector 3 m above the eye, colouring each flake by the projector
// ray that hits it smears the picture by hundreds of pixels across depth, so a lit flake instead takes its
// colour from the picture pinned where the beam lands (pic), seen along the camera's own line of sight:
// flakes at every depth line up. Near flakes, off the picture, take the frame's averaged colour, dimmer.
// The haze pass integrates the same beam along each view ray at reduced resolution, masked to the frustum
// in closed form (slab test in projector clip space).
(function (global) {
  const L = global.LOOK;

  // ---------- matrices (column-major, like GL) ----------
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  }
  function invert(m) {
    const inv = new Float32Array(16);
    const a = m;
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  }

  // A pinhole camera in world metres: +x right, +y up, +z forward (yaw about y, then pitch about x, then roll).
  // F is the focal length in pixels of a W x H image whose optical centre is (cx, cy) (y down, like the canvas).
  // clip.w is the camera-space depth, so screen x = cx + F * x / z and y = cy - F * y / z.
  function camera(o) {
    const { pos, yaw = 0, pitch = 0, roll = 0, F, W, H, near = 0.2, far = 600 } = o;
    const cx = o.cx === undefined ? W / 2 : o.cx;
    const cy = o.cy === undefined ? H / 2 : o.cy;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // camera axes in world space
    let fwd = [syw * cp, sp, cyw * cp];
    let right0 = [cyw, 0, -syw];
    let up0 = [-syw * sp, cp, -cyw * sp];
    const right = [right0[0] * cr + up0[0] * sr, right0[1] * cr + up0[1] * sr, right0[2] * cr + up0[2] * sr];
    const up = [up0[0] * cr - right0[0] * sr, up0[1] * cr - right0[1] * sr, up0[2] * cr - right0[2] * sr];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    // view: world -> camera (x right, y up, z forward)
    const view = new Float32Array([
      right[0], up[0], fwd[0], 0,
      right[1], up[1], fwd[1], 0,
      right[2], up[2], fwd[2], 0,
      -dot(right, pos), -dot(up, pos), -dot(fwd, pos), 1,
    ]);
    const a = (far + near) / (far - near);
    const bq = (-2 * far * near) / (far - near);
    const sx = (2 * F) / W;
    const sy = (2 * F) / H;
    const ox = (2 * cx) / W - 1; // optical centre offset in NDC (x right)
    const oy = 1 - (2 * cy) / H; // (y up)
    const proj = new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, ox, oy, a, 1, 0, 0, bq, 0]);
    const viewProj = mul(proj, view);
    const cam = { pos: pos.slice(), fwd, right, up, F, W, H, cx, cy, near, far, view, proj, viewProj };
    cam.invViewProj = invert(viewProj);
    // world -> screen pixels (and depth), for 2D drawing that must sit in the same space as the snow
    cam.project = function (p) {
      const d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
      const z = dot(d, fwd);
      return [cx + (F * dot(d, right)) / z, cy - (F * dot(d, up)) / z, z];
    };
    return cam;
  }

  // Snow clock tables: speed(i) is the fall-speed multiplier at frame i (0 freezes the snow), wind(i) the
  // wind in m/s [x, y, z]. tau and the gust offset are running sums, so any frame reads them directly.
  function clock(n, fps, speed, wind) {
    const tau = new Float32Array(n);
    const gx = new Float32Array(n);
    const gy = new Float32Array(n);
    const gz = new Float32Array(n);
    let t = 0, x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) {
      tau[i] = t;
      gx[i] = x;
      gy[i] = y;
      gz[i] = z;
      const s = speed(i);
      const w = wind(i);
      t += s / fps;
      x += w[0] / fps;
      y += w[1] / fps;
      z += w[2] / fps;
    }
    return { tau, gx, gy, gz, n, fps };
  }
  // sample a clock at time t: { tau, gust: [x, y, z] }
  function sampleClock(ck, t) {
    const x = Math.max(0, Math.min(ck.n - 1.000001, t * ck.fps));
    const i = Math.floor(x);
    const u = x - i;
    const j = Math.min(ck.n - 1, i + 1);
    const lerp = (a) => a[i] + (a[j] - a[i]) * u;
    return { tau: lerp(ck.tau), gust: [lerp(ck.gx), lerp(ck.gy), lerp(ck.gz)] };
  }

  // Homography mapping 4 points src[i] = [x, y] onto dst[i] = [u, v], as a column-major mat3 for GLSL.
  function homography(src, dst) {
    const A = [];
    const bb = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      bb.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      bb.push(v);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      [bb[c], bb[piv]] = [bb[piv], bb[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const k = A[r][c] / A[c][c];
        for (let q = c; q < n; q++) A[r][q] -= k * A[c][q];
        bb[r] -= k * bb[c];
      }
    }
    const h = bb.map((v, i) => v / A[i][i]);
    return new Float32Array([h[0], h[3], h[6], h[1], h[4], h[7], h[2], h[5], 1]);
  }

  // ---------- marks ----------
  // cols dab shapes x rows blur levels, CELL px each. Dabs are white on transparent (the shader tints them).
  const CELL = 64;
  function makeAtlas(seed, cols = 8, rows = 4, style = "pencil") {
    const c = L.canvas(cols * CELL, rows * CELL);
    const g = c.getContext("2d");
    const r = L.rng(seed);
    const dabs = [];
    for (let k = 0; k < cols; k++) {
      // one dab: a few overlapping soft blobs, edges broken up like a pencil or chalk touch
      const d = L.canvas(CELL, CELL);
      const dg = d.getContext("2d");
      const blobs = 3 + r.int(4);
      for (let i = 0; i < blobs; i++) {
        const bx = CELL / 2 + r.range(-7, 7);
        const by = CELL / 2 + r.range(-7, 7);
        const br = r.range(7, 13);
        const gr = dg.createRadialGradient(bx, by, 0, bx, by, br);
        gr.addColorStop(0, "rgba(255,255,255,0.95)");
        gr.addColorStop(style === "charcoal" ? 0.4 : 0.6, "rgba(255,255,255,0.7)");
        gr.addColorStop(1, "rgba(255,255,255,0)");
        dg.fillStyle = gr;
        dg.beginPath();
        dg.arc(bx, by, br, 0, L.TAU);
        dg.fill();
      }
      // tooth: knock grains out so the dab isn't a clean disc
      dg.globalCompositeOperation = "destination-out";
      for (let i = 0; i < 140; i++) {
        const a = r() * L.TAU;
        const rr = Math.pow(r(), 0.6) * 20;
        dg.fillStyle = `rgba(0,0,0,${r.range(0.15, 0.6)})`;
        dg.fillRect(CELL / 2 + Math.cos(a) * rr, CELL / 2 + Math.sin(a) * rr, r.range(1, 2.5), r.range(1, 2.5));
      }
      dg.globalCompositeOperation = "source-over";
      dabs.push(d);
    }
    for (let row = 0; row < rows; row++) {
      // row 0 sharp; higher rows are the same dab out of focus: blurred, flatter, with a faint bokeh rim
      const blur = [0, 3, 7, 12][row] || row * 4;
      for (let k = 0; k < cols; k++) {
        g.save();
        g.beginPath();
        g.rect(k * CELL, row * CELL, CELL, CELL);
        g.clip();
        if (row === 0) {
          g.drawImage(dabs[k], k * CELL, row * CELL);
        } else {
          g.filter = `blur(${blur * 0.5}px)`;
          g.globalAlpha = 0.85;
          g.drawImage(dabs[k], k * CELL, row * CELL);
          g.filter = "none";
          g.globalAlpha = 1;
          if (style === "charcoal") {
            // out of focus, a charcoal mark is a soft irregular smudge: the same dab, blurred more, no lens rim
            g.filter = `blur(${blur * 0.9}px)`;
            g.globalAlpha = 0.6;
            g.drawImage(dabs[(k + 3) % cols], k * CELL + 2, row * CELL - 1);
            g.filter = "none";
            g.globalAlpha = 1;
            g.restore();
            continue;
          }
          const cx = k * CELL + CELL / 2;
          const cy = row * CELL + CELL / 2;
          const rad = 22 + row * 2;
          const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
          const a = 0.35 + 0.12 * row;
          gr.addColorStop(0, `rgba(255,255,255,${a * 0.75})`);
          gr.addColorStop(0.78, `rgba(255,255,255,${a})`);
          gr.addColorStop(0.92, `rgba(255,255,255,${a * 0.6})`);
          gr.addColorStop(1, "rgba(255,255,255,0)");
          g.fillStyle = gr;
          g.beginPath();
          g.arc(cx, cy, rad, 0, L.TAU);
          g.fill();
        }
        g.restore();
      }
    }
    return { canvas: c, cols, rows };
  }

  // ---------- shaders ----------
  // The pipeline is 8-bit and gamma-encoded end to end (half-float targets cost about 3x as much on the
  // software GPU the renders use): the haze is tone-mapped where it is integrated, each flake is tone-mapped
  // once in its vertex shader, and both add into the canvas.
  const HASH = `
  uniform uint uSeed;
  uint hu(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
  float h1(uint id, uint k) { return float(hu(id * 0x9E3779B1u + hu(k + uSeed * 0x632BE5ABu))) * (1.0 / 4294967296.0); }
  `;
  const TONE = `
  vec3 toneGamma(vec3 x) { return pow(1.0 - exp(-max(x, vec3(0.0))), vec3(1.0 / 2.2)); }
  // off the picture, the beam reads as the lamp's warm white at the frame's average brightness
  const vec3 LAMP = vec3(1.0, 0.92, 0.78);
  vec3 lampTint(vec3 avg, float keep) { return mix(vec3(dot(avg, vec3(0.3, 0.55, 0.15))) * LAMP * 1.15, avg, keep); }
  // the frame's vignette, so the scene can bake its own into the layers under and over the snow
  uniform vec4 uVig; // centre x, centre y (px, y down), radius where it starts, strength (0 = none)
  uniform float uVigR1;
  float vignette(vec2 pxDown) {
    if (uVig.w <= 0.0) return 1.0;
    return 1.0 - uVig.w * smoothstep(uVig.z, uVigR1, length(pxDown - uVig.xy));
  }
  `;
  // gate weave: the film moves inside the fixed gate (texture px shift and a small rotation about the centre)
  const WEAVE = `
  uniform vec3 uWeave;
  uniform vec2 uTexSize;
  vec2 weave(vec2 uv) {
    vec2 p = uv * uTexSize - 0.5 * uTexSize - uWeave.xy;
    float c = cos(uWeave.z), s = sin(uWeave.z);
    p = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
    return (p + 0.5 * uTexSize) / uTexSize;
  }
  `;

  const VS_FLAKES = `#version 300 es
  precision highp float;
  precision highp int;
  ${HASH}
  ${TONE}
  ${WEAVE}
  uniform mat4 uVP, uVPPrev;
  uniform vec3 uCenter, uSize;
  uniform float uTau, uTauPrev;
  uniform vec3 uGust, uGustPrev;
  uniform float uDensity;
  uniform vec2 uRes;
  uniform float uFocal, uFlakeSize, uFocus, uAperture, uMaxPoint, uFog, uSway, uCurl, uFlakeGain, uExposure;
  uniform vec3 uAmbient;
  uniform int uProjOn;
  uniform mat4 uProjVP;
  uniform vec3 uProjPos;
  uniform sampler2D uMem;
  uniform float uProjGain, uProjRef, uProjFalloff, uProjLod, uNearDim, uBoothLod, uLeak;
  uniform int uPicOn;
  uniform mat3 uPic;
  uniform vec2 uCoh;
  uniform float uSizeK, uGainK, uEdge, uMaxStreak;
  uniform vec2 uNearFade;
  uniform float uAtlasCols, uAtlasRows;
  uniform int uInk;
  uniform vec3 uInkDark, uInkLight;
  uniform float uChalk, uInkGain;
  uniform int uAttrOn;
  uniform vec3 uAttr;
  uniform float uAttrT, uAttrDur, uAttrSpread, uAttrSwirl;
  uniform vec3 uAttrColor;
  uniform vec3 uGlint;
  uniform float uGlintK;
  uniform int uShadowOn;
  uniform vec3 uShadowL, uShadowCol;
  uniform float uShadowK, uShadowStretch, uShadowMax, uShadowSize, uShadowMinPx, uShadowReach, uShadowTop;
  uniform int uShadowMode;
  out vec3 vColor;
  out float vAlpha;
  out vec2 vDir;
  out float vLen, vDiam, vSprite, vBlur, vMark, vShade;

  vec3 curlField(vec3 p, float t) {
    // divergence-free displacement: curl of a sum-of-sines vector potential (each term a cos(k.p + wt) k x e / |k|)
    vec3 d = vec3(0.0);
    vec3 k; vec3 e; float a;
    k = vec3(0.31, 0.17, 0.23); e = vec3(0.0, 0.0, 1.0); a = cos(dot(k, p) + 0.35 * t + 0.4);
    d += a * cross(k, e) / length(k);
    k = vec3(-0.21, 0.29, 0.13); e = vec3(1.0, 0.0, 0.0); a = cos(dot(k, p) + 0.27 * t + 2.1);
    d += a * cross(k, e) / length(k);
    k = vec3(0.53, -0.41, 0.37); e = vec3(0.0, 1.0, 0.0); a = cos(dot(k, p) + 0.6 * t + 4.4);
    d += 0.5 * a * cross(k, e) / length(k);
    k = vec3(0.11, 0.07, -0.19); e = vec3(0.7071, 0.7071, 0.0); a = cos(dot(k, p) + 0.15 * t + 1.3);
    d += 1.3 * a * cross(k, e) / length(k);
    return d;
  }

  vec3 wrapBox(vec3 p) {
    return uCenter + mod(p - uCenter + 0.5 * uSize, uSize) - 0.5 * uSize;
  }

  void offscreen() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0); vAlpha = 0.0; vDir = vec2(1.0, 0.0); vLen = 0.0; vDiam = 1.0; vSprite = 1.0; vBlur = 0.0; vMark = 0.0; vShade = 0.0;
  }

  void main() {
    uint id = uint(gl_VertexID);
    float vis = clamp((uDensity - h1(id, 10u)) / 0.04, 0.0, 1.0);
    if (vis <= 0.0) { offscreen(); return; }
    vec3 base = uCenter + (vec3(h1(id, 1u), h1(id, 2u), h1(id, 3u)) - 0.5) * uSize;
    float speed = mix(0.7, 1.4, h1(id, 4u));
    float swA = uSway * mix(0.3, 1.0, h1(id, 5u));
    float swF = mix(0.25, 0.8, h1(id, 6u)) * 6.2831853;
    float ph = h1(id, 7u) * 6.2831853;
    float gk = mix(0.8, 1.2, h1(id, 8u));

    vec3 p = base + vec3(0.0, -speed * uTau, 0.0) + uGust * gk;
    p.x += swA * sin(swF * uTau + ph);
    p.z += swA * 0.6 * cos(swF * 0.8 * uTau + ph * 1.3);
    p += uCurl * curlField(base, uTau);
    p = wrapBox(p);
    vec3 q = base + vec3(0.0, -speed * uTauPrev, 0.0) + uGustPrev * gk;
    q.x += swA * sin(swF * uTauPrev + ph);
    q.z += swA * 0.6 * cos(swF * 0.8 * uTauPrev + ph * 1.3);
    q += uCurl * curlField(base, uTauPrev);
    q = wrapBox(q);
    if (distance(p, q) > 0.3 * min(uSize.x, min(uSize.y, uSize.z))) q = p; // wrapped this frame
    if (uEdge > 0.0) {
      // a box that moves with the camera: flakes fade out near its sides instead of popping where they wrap
      // (judged where the flake hangs, before an attractor carries it off)
      vec2 r = abs(p.xz - uCenter.xz) / uSize.xz;
      vis *= 1.0 - smoothstep(0.5 - uEdge, 0.5, max(r.x, r.y));
      if (vis <= 0.0) { offscreen(); return; }
    }
    float attrE = 0.0; // how far along its way to the attractor (0..1)
    if (uAttrOn == 1) {
      // moths: from where it hangs, each flake drifts to the light after its own delay, wandering on the way, and
      // ends circling it in a loose cloud
      // released at random through the spread, more of them early on
      float delay = pow(h1(id, 13u), 1.3) * uAttrSpread;
      float dur = uAttrDur * mix(0.6, 1.5, h1(id, 14u));
      float ph0 = h1(id, 15u) * 6.2831853;
      vec3 start = p;
      vec3 axis = normalize(uAttr - start);
      vec3 side = normalize(cross(axis, vec3(0.0, 1.0, 0.0)) + vec3(1e-4));
      vec3 up = cross(side, axis);
      float rad = uAttrSwirl * mix(0.4, 1.0, h1(id, 16u)) * length(uAttr - start) * 0.04;
      float orbitR = uAttrSwirl * mix(1.5, 7.0, h1(id, 18u));
      // either way round, each its own pace
      float spin = mix(0.2, 0.6, h1(id, 19u)) * (h1(id, 22u) < 0.5 ? -1.0 : 1.0);
      float turns = mix(0.15, 0.45, h1(id, 20u)) * sign(spin);
      for (int k = 0; k < 2; k++) {
        float tt = uAttrT - float(k) / 48.0;
        float u = clamp((tt - delay) / dur, 0.0, 1.0);
        float e = u * u * u * (u * (u * 6.0 - 15.0) + 10.0);
        float ang = ph0 + tt * spin;
        // the cloud round the light: each moth on its own circle facing us, wobbling in depth (a ball, not a disc)
        vec3 oa = side * cos(ang) + up * sin(ang) + axis * 0.5 * sin(ang * 0.7 + ph0);
        // most close in to the light, a few out on wide loops: a swarm thickest at its heart, not an even ball
        vec3 orbit = oa * orbitR * pow(h1(id, 21u), 0.8);
        // on the way in it bends round the line to the light (part of a turn, widest halfway)
        float th = ph0 + 6.2831853 * turns * e;
        vec3 wander = (side * cos(th) + up * sin(th)) * rad * sin(3.14159265 * u);
        // and flutters: small erratic loops, a moth's; the whole field stirs as soon as the snow moves again (a
        // third of the flutter), the full flutter once it lets go
        float live = clamp(uAttrT / 2.0, 0.0, 1.0) * (0.3 + 0.7 * clamp((tt - delay) / 0.8, 0.0, 1.0));
        float fa = uAttrSwirl * mix(0.12, 0.35, h1(id, 23u)) * live;
        vec3 w = vec3(mix(2.6, 5.2, h1(id, 24u)), mix(3.1, 6.3, h1(id, 25u)), mix(1.7, 3.9, h1(id, 26u)));
        vec3 flutter = (side * (sin(w.x * tt + ph0) + 0.45 * sin(2.3 * w.x * tt + 1.7)) +
                        up * (sin(w.y * tt + 2.0 * ph0) + 0.45 * sin(1.9 * w.y * tt + 0.4)) +
                        axis * 0.6 * sin(w.z * tt + 3.0 * ph0)) * fa;
        vec3 r = mix(start, uAttr + orbit, e) + wander + flutter;
        if (k == 0) { p = r; attrE = e; } else q = r;
      }
    }

    if (uShadowOn == 1) {
      // the flake's shadow on the snow: where the line from the light through it meets the ground. The light has a size
      // (uShadowSize), so the shadow blurs with the distance from the flake down to it, and a small
      // flake high up throws only a faint smudge; one hanging low throws a crisp mark. A grazing light lays every
      // shadow out long along the ground, away from it.
      if (p.y >= min(uShadowL.y - 0.05, uShadowTop) || p.y <= 0.0) { offscreen(); return; }
      float sh = uShadowL.y / (uShadowL.y - p.y);
      vec3 gc = uShadowL + sh * (p - uShadowL);
      gc.y = 0.0;
      vec2 away = gc.xz - uShadowL.xz;
      float dl = max(length(away), 1e-3);
      away /= dl;
      float size = uFlakeSize * uSizeK * mix(0.55, 1.6, h1(id, 9u));
      float pen = uShadowSize * (sh - 1.0); // the penumbra's width on the ground, across the light
      float wide = size + pen;
      float cover = min(1.0, (size * size) / (wide * wide)); // how much of the light the flake hides
      vec3 g0;
      vec3 g1;
      if (uShadowMode == 1) {
        // drawn from the snow right under the flake, out along the ground away from the light (the shadow of the flake
        // and of the line down to it, as if it hung on a thread: what makes a hanging thing's shadow read as its own)
        vec2 foot = p.xz;
        vec2 aw = foot - uShadowL.xz;
        float df = max(length(aw), 1e-3);
        aw /= df;
        float run = min(uShadowStretch * df * p.y / (uShadowL.y - p.y), uShadowReach);
        g0 = vec3(foot.x, 0.0, foot.y);
        g1 = g0 + vec3(aw.x, 0.0, aw.y) * run;
        cover *= (1.0 - p.y / uShadowTop) * (1.0 - p.y / uShadowTop);
      } else {
        float hl = 0.5 * wide * dl / uShadowL.y * uShadowStretch; // half its length along the ground
        g0 = gc - vec3(away.x, 0.0, away.y) * hl;
        g1 = gc + vec3(away.x, 0.0, away.y) * hl;
      }
      vec4 c0 = uVP * vec4(g0, 1.0);
      vec4 c1 = uVP * vec4(g1, 1.0);
      if (c0.w < 0.3 || c1.w < 0.3) { offscreen(); return; }
      vec2 a0 = (c0.xy / c0.w * 0.5 + 0.5) * uRes;
      vec2 a1 = (c1.xy / c1.w * 0.5 + 0.5) * uRes;
      float zc = 0.5 * (c0.w + c1.w);
      vec2 dd = a1 - a0;
      float lpx = min(length(dd), uShadowMax);
      vec2 sdir = lpx > 1e-3 ? dd / length(dd) : vec2(1.0, 0.0);
      // never thinner than a soft smudge on screen (spread wider, it gets fainter: the same amount of shadow)
      float sdiam0 = uFocal * wide / zc;
      float sdiam = max(sdiam0, uShadowMinPx);
      cover *= sdiam0 / sdiam;
      float sspr = min(1.4 * sdiam + lpx + 2.0, uMaxPoint);
      vec2 smid = 0.5 * (a0 + a1);
      if (smid.x < -sspr || smid.y < -sspr || smid.x > uRes.x + sspr || smid.y > uRes.y + sspr) { offscreen(); return; }
      vColor = uShadowCol;
      vAlpha = clamp(vis * uShadowK * cover * (1.0 - attrE) * exp(-zc / uFog), 0.0, 1.0);
      if (vAlpha <= 0.003) { offscreen(); return; }
      vDir = vec2(sdir.x, -sdir.y);
      vLen = min(lpx, max(0.0, sspr - 1.4 * sdiam - 2.0));
      vDiam = sdiam;
      vSprite = sspr;
      vShade = 1.0;
      vBlur = uAtlasRows - 1.0; // soft: the blurriest dab
      vMark = floor(h1(id, 12u) * uAtlasCols);
      gl_Position = vec4(smid / uRes * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = sspr;
      return;
    }

    vec4 c = uVP * vec4(p, 1.0);
    float z = c.w;
    if (z < 0.15) { offscreen(); return; }
    vec2 s = (c.xy / z * 0.5 + 0.5) * uRes;
    vec4 cq = uVPPrev * vec4(q, 1.0);
    vec2 sq = cq.w > 0.15 ? (cq.xy / cq.w * 0.5 + 0.5) * uRes : s;
    vec2 d = s - sq;
    float len = min(length(d), uMaxStreak);
    vec2 dir = len > 1e-3 ? d / length(d) : vec2(1.0, 0.0);

    // a flake drawn to the light keeps a few pixels of size however far it goes (it catches the light)
    float caught = attrE * attrE * attrE;
    float core = max(uFocal * uFlakeSize * uSizeK * mix(0.55, 1.6, h1(id, 9u)) / z, caught * mix(1.6, 2.8, h1(id, 9u)));
    float coc = uAperture * uFocal * abs(1.0 / z - 1.0 / uFocus);
    float diam = max(sqrt(core * core + coc * coc), 1.25);
    float energy = min(1.0, (core * core) / (diam * diam)) * (diam / (diam + len));
    // a flake right at the lens is a blur too wide to see (flake.nearFade [from, to] metres; off by default)
    if (uNearFade.y > 0.0) {
      energy *= smoothstep(uNearFade.x, uNearFade.y, z);
      if (energy <= 0.0) { offscreen(); return; }
    }
    float sprite = min(diam + len + 2.0, uMaxPoint);
    vec2 mid = 0.5 * (s + sq);
    if (mid.x < -sprite || mid.y < -sprite || mid.x > uRes.x + sprite || mid.y > uRes.y + sprite) { offscreen(); return; }

    vec3 col = uAmbient * exp(-z / uFog);
    if (uProjOn == 1) {
      // Lit only inside the booth frustum and gate. The colour comes from the picture pinned where the
      // beam lands (uPic maps this flake's screen position to the frame), so flakes at every depth line up.
      // Near flakes sit off the picture: they take the frame's averaged colour, dimmer (the near-flake rule).
      vec4 pc = uProjVP * vec4(p, 1.0);
      if (pc.w > 0.1) {
        vec2 ndc = pc.xy / pc.w;
        vec2 m = smoothstep(vec2(1.0), vec2(0.985), abs(ndc));
        float inside = m.x * m.y;
        if (inside > 0.0) {
          vec2 buv = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
          float gate = textureLod(uMem, buv, 1.0).a;
          vec3 lit = lampTint(pow(textureLod(uMem, weave(buv), uBoothLod).rgb, vec3(2.2)), 0.3);
          float coh = 1.0;
          if (uPicOn == 1) {
            coh = smoothstep(uCoh.x, uCoh.y, z);
            vec3 hp = uPic * vec3(s.x, uRes.y - s.y, 1.0);
            vec3 crisp = pow(textureLod(uMem, weave(hp.xy / hp.z), uProjLod).rgb, vec3(2.2));
            lit = mix(lit, crisp, coh);
          } else {
            lit = pow(textureLod(uMem, weave(buv), uProjLod).rgb, vec3(2.2));
          }
          lit += uLeak * LAMP;
          float dist = length(p - uProjPos);
          float I = uProjGain * pow(uProjRef / dist, uProjFalloff) * mix(uNearDim, 1.0, coh);
          col += lit * I * inside * gate;
        }
      }
    }
    // tone-map the flake's own peak value; its dab shape scales it in the fragment shader
    vColor = toneGamma(col * vis * energy * uFlakeGain * uGainK * mix(0.7, 1.3, h1(id, 11u)) * uExposure) * vignette(vec2(mid.x, uRes.y - mid.y));
    vAlpha = 1.0;
    if (uInk == 1) {
      // a mark on the fog: charcoal, or now and then chalk; it fades into the fog with distance
      bool chalk = h1(id, 17u) < uChalk;
      // near the light, a mark catches its colour and shows through the fog
      vec2 dg = mid - uGlint.xy;
      float glint = uGlintK * exp(-dot(dg, dg) / (uGlint.z * uGlint.z));
      vColor = mix(chalk ? uInkLight : uInkDark, uAttrColor, max(0.85 * mix(attrE, caught, 0.6), glint));
      vAlpha = clamp(vis * energy * uInkGain * uGainK * mix(0.7, 1.3, h1(id, 11u)) * mix(exp(-z / uFog), 0.95, max(caught, 0.45 * glint)) * (chalk ? 0.8 : 1.0), 0.0, 1.0);
      if (vAlpha <= 0.002) { offscreen(); return; }
    }
    vDir = vec2(dir.x, -dir.y); // gl_PointCoord runs y down
    vShade = 0.0;
    vLen = min(len, max(0.0, sprite - diam - 2.0));
    vDiam = diam;
    vSprite = sprite;
    vBlur = clamp(coc / max(diam, 1.0) * 3.3, 0.0, uAtlasRows - 1.0);
    vMark = floor(h1(id, 12u) * uAtlasCols);
    gl_Position = vec4(mid / uRes * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = sprite;
  }`;

  const FS_FLAKES = `#version 300 es
  precision highp float;
  precision highp int;
  in vec3 vColor;
  in float vAlpha;
  in vec2 vDir;
  in float vLen, vDiam, vSprite, vBlur, vMark, vShade;
  uniform sampler2D uAtlas;
  uniform float uAtlasCols, uAtlasRows;
  uniform int uInk;
  out vec4 o;
  void main() {
    vec2 q = (gl_PointCoord - 0.5) * vSprite;
    vec2 n = vec2(-vDir.y, vDir.x);
    float a = dot(q, vDir);
    float b = dot(q, n);
    float h = vLen * 0.5;
    float along = vLen > 0.5 ? clamp((a + h) / vLen, 0.0, 1.0) : 0.5;
    float fadeAlong = 1.0;
    if (vShade > 0.5) {
      // a shadow: darkest where it leaves the snow under its flake, wider and paler toward its end
      b /= mix(0.55, 1.3, along);
      fadeAlong = pow(1.0 - along, 1.3);
    }
    a -= clamp(a, -h, h);
    vec2 uv = vec2(a, b) / vDiam + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    uv = mix(vec2(0.04), vec2(0.96), uv);
    vec2 cell = vec2(1.0 / uAtlasCols, 1.0 / uAtlasRows);
    float l0 = floor(vBlur);
    float l1 = min(l0 + 1.0, uAtlasRows - 1.0);
    float m0 = texture(uAtlas, (vec2(vMark, l0) + uv) * cell).a;
    float m1 = texture(uAtlas, (vec2(vMark, l1) + uv) * cell).a;
    float m = mix(m0, m1, vBlur - l0);
    if (uInk == 1) {
      float a = vAlpha * m * fadeAlong;
      o = vec4(vColor * a, a); // premultiplied, laid over
    } else {
      o = vec4(vColor * m, 1.0);
    }
  }`;

  const VS_QUAD = `#version 300 es
  precision highp float;
  out vec2 vUV;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUV = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FS_HAZE = `#version 300 es
  precision highp float;
  precision highp int;
  ${HASH}
  ${TONE}
  ${WEAVE}
  in vec2 vUV;
  uniform mat4 uInvVP, uProjVP;
  uniform vec3 uCam, uCamFwd, uProjPos;
  uniform sampler2D uMem;
  uniform float uLod, uGain, uRef, uFalloff, uMaxT, uGroundY, uBoothLod, uLeak, uExposure, uHazePic;
  uniform int uPicOn;
  uniform mat3 uPic;
  uniform vec2 uCoh, uRes;
  out vec4 o;
  void clipT(inout float t0, inout float t1, float a, float b) {
    // keep the part of the ray where a + b t >= 0
    if (abs(b) < 1e-7) { if (a < 0.0) t1 = -1.0; return; }
    float t = -a / b;
    if (b > 0.0) t0 = max(t0, t); else t1 = min(t1, t);
  }
  void main() {
    vec2 ndc = vUV * 2.0 - 1.0;
    vec4 wf = uInvVP * vec4(ndc, 1.0, 1.0);
    vec3 dir = normalize(wf.xyz / wf.w - uCam);
    float t0 = 0.3;
    float t1 = uMaxT;
    if (dir.y < -1e-4) t1 = min(t1, (uGroundY - uCam.y) / dir.y);
    vec4 c0 = uProjVP * vec4(uCam, 1.0);
    vec4 c1 = uProjVP * vec4(dir, 0.0);
    clipT(t0, t1, c0.w - c0.x, c1.w - c1.x);
    clipT(t0, t1, c0.w + c0.x, c1.w + c1.x);
    clipT(t0, t1, c0.w - c0.y, c1.w - c1.y);
    clipT(t0, t1, c0.w + c0.y, c1.w + c1.y);
    clipT(t0, t1, c0.w - 0.5, c1.w);
    uvec2 px = uvec2(gl_FragCoord.xy);
    float dither = (h1(px.x * 7919u + px.y * 104729u, 5u) - 0.5) / 255.0;
    if (t1 <= t0) { o = vec4(vec3(max(dither, 0.0)), 1.0); return; }
    // the pinned picture is one colour along this view ray
    vec3 crisp = vec3(0.0);
    if (uPicOn == 1) {
      vec3 hp = uPic * vec3(vUV.x * uRes.x, (1.0 - vUV.y) * uRes.y, 1.0);
      crisp = pow(textureLod(uMem, weave(hp.xy / hp.z), uLod).rgb, vec3(2.2));
    }
    float zd = dot(dir, uCamFwd);
    // interleaved gradient noise (Jimenez): an even spread of sample offsets, so the upscaled haze is smooth
    float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 sum = vec3(0.0);
    const int N = 5;
    for (int i = 0; i < N; i++) {
      float t = mix(t0, t1, (float(i) + j) / float(N));
      vec3 p = uCam + dir * t;
      vec4 pc = uProjVP * vec4(p, 1.0);
      vec2 u = pc.xy / pc.w;
      vec2 m = smoothstep(vec2(1.0), vec2(0.96), abs(u));
      vec2 buv = vec2(u.x * 0.5 + 0.5, 0.5 - u.y * 0.5);
      vec4 avg = textureLod(uMem, buv, uBoothLod);
      float gate = textureLod(uMem, buv, 3.5).a;
      float coh = uPicOn == 1 ? smoothstep(uCoh.x, uCoh.y, t * zd) * uHazePic : 0.0;
      vec3 c = mix(lampTint(pow(avg.rgb, vec3(2.2)), 0.3), crisp, coh) + uLeak * LAMP;
      float d = length(p - uProjPos);
      sum += c * gate * m.x * m.y * pow(uRef / d, uFalloff);
    }
    o = vec4(toneGamma(sum / float(N) * (t1 - t0) * uGain * uExposure) * vignette(vec2(vUV.x, 1.0 - vUV.y) * uRes) + dither, 1.0);
  }`;

  const FS_COPY = `#version 300 es
  precision highp float;
  in vec2 vUV;
  uniform sampler2D uTex;
  out vec4 o;
  void main() { o = vec4(texture(uTex, vUV).rgb, 1.0); }`;

  // four bilinear taps at half-texel offsets: a 4x4 box blur of the reduced-resolution haze
  const FS_BLUR = `#version 300 es
  precision highp float;
  in vec2 vUV;
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  out vec4 o;
  void main() {
    vec3 c = texture(uTex, vUV + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUV + uTexel * vec2(1.0, -1.0)).rgb
           + texture(uTex, vUV + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUV + uTexel * vec2(1.0, 1.0)).rgb;
    o = vec4(c * 0.25, 1.0);
  }`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("snow shader: " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("snow link: " + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  function field(opts) {
    const W = opts.W || L.W;
    const H = opts.H || L.H;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ink = !!opts.ink;
    const gl = canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
      alpha: ink,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: ink,
    });
    if (!gl) throw new Error("snow: WebGL2 unavailable");
    const info = {
      renderer: (() => {
        const e = gl.getExtension("WEBGL_debug_renderer_info");
        return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      })(),
      maxPoint: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1],
    };
    global.SNOW_INFO = info; // the dev harness prints the renderer next to perf numbers
    const progFlakes = compile(gl, VS_FLAKES, FS_FLAKES);
    const progHaze = compile(gl, VS_QUAD, FS_HAZE);
    const progCopy = compile(gl, VS_QUAD, FS_COPY);
    const progBlur = compile(gl, VS_QUAD, FS_BLUR);
    const vao = gl.createVertexArray(); // attribute-less: everything comes from gl_VertexID

    // the haze is soft (a blurred copy of the picture), so it is integrated at reduced resolution
    const hs = opts.hazeScale || 0.25;
    const HW = Math.ceil(W * hs);
    const HH = Math.ceil(H * hs);
    function target() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, HW, HH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { t, f };
    }
    const hazeA = target(); // integrated haze
    const hazeB = target(); // the same, blurred

    const atlas = opts.atlas || makeAtlas((opts.seed || 1) * 31 + 7, 8, 4, opts.markStyle || "pencil");
    const atlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const memTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, memTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let memKey = null;
    let memSize = [1, 1];

    const shells = opts.shells.map((s) => ({
      center: s.center.slice(),
      size: s.size.slice(),
      count: s.count | 0,
      sizeK: s.sizeK || 1,
      gainK: s.gainK === undefined ? 1 : s.gainK,
      edge: s.edge || 0, // fade near the box's sides (a fraction of its size, up to 0.5); for boxes that move
    }));
    let first = 0;
    for (const s of shells) {
      s.first = first;
      first += s.count;
    }
    const total = first;

    // the picture pinned in screen space (projector.pic: a mat3 homography from screen px, y down, to uv)
    function setPicture(P, pr, leak) {
      const on = !!pr.pic;
      gl.uniform1i(P.u.uPicOn, on ? 1 : 0);
      if (on) gl.uniformMatrix3fv(P.u.uPic, false, pr.pic);
      gl.uniform2fv(P.u.uCoh, pr.coherence || [12, 30]);
      gl.uniform1f(P.u.uBoothLod, pr.boothLod === undefined ? 4 : pr.boothLod);
      gl.uniform1f(P.u.uLeak, leak || 0);
      const w = pr.weave || [0, 0, 0];
      gl.uniform3f(P.u.uWeave, w[0], w[1], w[2]);
      gl.uniform2f(P.u.uTexSize, memSize[0], memSize[1]);
    }

    // dev profiling: a 1-pixel read blocks until the GPU is done (gl.finish does not, in Chrome)
    const px1 = new Uint8Array(4);
    function sync() {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
    }

    function setVignette(P, v) {
      const a = v || [0, 0, 0, 0, 1];
      gl.uniform4f(P.u.uVig, a[0], a[1], a[2], a[3]);
      gl.uniform1f(P.u.uVigR1, a[4]);
    }

    function render(fr) {
      const cam = fr.cam;
      const camPrev = fr.camPrev || cam;
      const fl = fr.flake || {};
      const pr = fr.projector || null;
      const hz = fr.haze || null;
      const seed = (fr.seed | 0) >>> 0;
      const exposure = fr.exposure === undefined ? 1 : fr.exposure;

      // memory texture: upload only when its key changes (reels run at 18 fps)
      if (pr && pr.texture) {
        gl.bindTexture(gl.TEXTURE_2D, memTex);
        if (pr.key === undefined || pr.key !== memKey) {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pr.texture);
          gl.generateMipmap(gl.TEXTURE_2D);
          memKey = pr.key === undefined ? null : pr.key;
          memSize = [pr.texture.width, pr.texture.height];
        }
      }
      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      FILM.mark("snow:upload", sync);

      const hazeOn = !!(pr && hz && hz.gain > 0);
      if (hazeOn) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, hazeA.f);
        gl.viewport(0, 0, HW, HH);
        gl.disable(gl.BLEND);
        const P = progHaze;
        gl.useProgram(P.p);
        gl.uniform1ui(P.u.uSeed, seed);
        gl.uniformMatrix4fv(P.u.uInvVP, false, cam.invViewProj);
        gl.uniformMatrix4fv(P.u.uProjVP, false, pr.cam.viewProj);
        gl.uniform3fv(P.u.uCam, cam.pos);
        gl.uniform3fv(P.u.uCamFwd, cam.fwd);
        gl.uniform3fv(P.u.uProjPos, pr.cam.pos);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, memTex);
        gl.uniform1i(P.u.uMem, 0);
        gl.uniform1f(P.u.uLod, hz.lod === undefined ? 2.5 : hz.lod);
        gl.uniform1f(P.u.uGain, hz.gain);
        gl.uniform1f(P.u.uExposure, exposure);
        gl.uniform1f(P.u.uRef, pr.ref || 40);
        gl.uniform1f(P.u.uFalloff, hz.falloff === undefined ? 1.2 : hz.falloff);
        gl.uniform1f(P.u.uMaxT, hz.maxT || 200);
        gl.uniform1f(P.u.uGroundY, hz.groundY === undefined ? 0 : hz.groundY);
        gl.uniform1f(P.u.uHazePic, hz.picture === undefined ? 1 : hz.picture);
        gl.uniform2f(P.u.uRes, W, H);
        setPicture(P, pr, hz.leak);
        setVignette(P, fr.vignette);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, hazeB.f);
        gl.useProgram(progBlur.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, hazeA.t);
        gl.uniform1i(progBlur.u.uTex, 0);
        gl.uniform2f(progBlur.u.uTexel, 1 / HW, 1 / HH);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      FILM.mark("snow:haze", sync);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, ink ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (hazeOn) {
        gl.useProgram(progCopy.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, hazeB.t);
        gl.uniform1i(progCopy.u.uTex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      FILM.mark("snow:hazecopy", sync);

      // flakes add their light
      gl.enable(gl.BLEND);
      if (ink) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else gl.blendFunc(gl.ONE, gl.ONE);
      const P = progFlakes;
      gl.useProgram(P.p);
      gl.uniform1ui(P.u.uSeed, (opts.seed || 1) >>> 0);
      gl.uniformMatrix4fv(P.u.uVP, false, cam.viewProj);
      gl.uniformMatrix4fv(P.u.uVPPrev, false, camPrev.viewProj);
      gl.uniform1f(P.u.uTau, fr.tau);
      gl.uniform1f(P.u.uTauPrev, fr.tauPrev === undefined ? fr.tau : fr.tauPrev);
      gl.uniform3fv(P.u.uGust, fr.gust || [0, 0, 0]);
      gl.uniform3fv(P.u.uGustPrev, fr.gustPrev || fr.gust || [0, 0, 0]);
      gl.uniform1f(P.u.uDensity, fr.density === undefined ? 1 : fr.density);
      gl.uniform2f(P.u.uRes, W, H);
      gl.uniform1f(P.u.uFocal, cam.F);
      gl.uniform1f(P.u.uFlakeSize, fl.size || 0.02);
      gl.uniform1f(P.u.uFocus, fl.focus || 30);
      gl.uniform1f(P.u.uAperture, fl.aperture === undefined ? 0.02 : fl.aperture);
      gl.uniform1f(P.u.uMaxPoint, Math.min(info.maxPoint, 255));
      gl.uniform1f(P.u.uFog, fl.fog || 80);
      gl.uniform1f(P.u.uSway, fl.sway === undefined ? 0.25 : fl.sway);
      gl.uniform1f(P.u.uCurl, fl.curl === undefined ? 0.4 : fl.curl);
      gl.uniform1f(P.u.uFlakeGain, fl.gain === undefined ? 1 : fl.gain);
      gl.uniform1f(P.u.uExposure, exposure);
      gl.uniform3fv(P.u.uAmbient, fl.ambient || [0.02, 0.025, 0.035]);
      gl.uniform1f(P.u.uAtlasCols, atlas.cols);
      gl.uniform1f(P.u.uAtlasRows, atlas.rows);
      gl.uniform1f(P.u.uMaxStreak, fl.maxStreak || 160);
      gl.uniform2f(P.u.uNearFade, fl.nearFade ? fl.nearFade[0] : 0, fl.nearFade ? fl.nearFade[1] : 0);
      const ik = fr.ink || {};
      gl.uniform1i(P.u.uInk, ink ? 1 : 0);
      gl.uniform3fv(P.u.uInkDark, ik.dark || [0.16, 0.17, 0.19]);
      gl.uniform3fv(P.u.uInkLight, ik.light || [0.95, 0.96, 0.97]);
      gl.uniform1f(P.u.uChalk, ik.chalk === undefined ? 0 : ik.chalk);
      gl.uniform1f(P.u.uInkGain, ik.gain === undefined ? 1 : ik.gain);
      const at = fr.attractor;
      gl.uniform1i(P.u.uAttrOn, at ? 1 : 0);
      gl.uniform3fv(P.u.uAttr, at ? at.pos : [0, 0, 0]);
      gl.uniform1f(P.u.uAttrT, at ? at.t : 0);
      gl.uniform1f(P.u.uAttrDur, at ? at.dur || 6 : 1);
      gl.uniform1f(P.u.uAttrSpread, at ? at.spread || 4 : 0);
      gl.uniform1f(P.u.uAttrSwirl, at ? (at.swirl === undefined ? 1 : at.swirl) : 0);
      gl.uniform3fv(P.u.uAttrColor, at && at.color ? at.color : [1, 0.75, 0.42]);
      const gs = fr.glint;
      gl.uniform3fv(P.u.uGlint, gs ? [gs.x, H - gs.y, Math.max(1, gs.r)] : [0, 0, 1]);
      gl.uniform1f(P.u.uGlintK, gs ? gs.k : 0);
      const sw = fr.shadow;
      gl.uniform1i(P.u.uShadowOn, sw ? 1 : 0);
      gl.uniform3fv(P.u.uShadowL, sw ? sw.light : [0, 1, 0]);
      gl.uniform3fv(P.u.uShadowCol, sw && sw.color ? sw.color : [0.3, 0.33, 0.4]);
      gl.uniform1f(P.u.uShadowK, sw ? sw.k : 0);
      gl.uniform1f(P.u.uShadowStretch, sw ? sw.stretch || 1 : 1);
      gl.uniform1f(P.u.uShadowMax, sw ? sw.max || 200 : 200);
      gl.uniform1f(P.u.uShadowSize, sw ? sw.size || 0.3 : 0.3);
      gl.uniform1f(P.u.uShadowMinPx, sw ? sw.minPx || 1.5 : 1.5);
      gl.uniform1f(P.u.uShadowReach, sw ? sw.reach || 6 : 6);
      gl.uniform1f(P.u.uShadowTop, sw && sw.top ? sw.top : 100);
      gl.uniform1i(P.u.uShadowMode, sw && sw.mode === "foot" ? 1 : 0);
      setVignette(P, fr.vignette);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, memTex);
      gl.uniform1i(P.u.uMem, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.uniform1i(P.u.uAtlas, 1);
      if (pr) {
        gl.uniform1i(P.u.uProjOn, 1);
        gl.uniformMatrix4fv(P.u.uProjVP, false, pr.cam.viewProj);
        gl.uniform3fv(P.u.uProjPos, pr.cam.pos);
        gl.uniform1f(P.u.uProjGain, pr.gain === undefined ? 1 : pr.gain);
        gl.uniform1f(P.u.uProjRef, pr.ref || 40);
        gl.uniform1f(P.u.uProjFalloff, pr.falloff === undefined ? 1 : pr.falloff);
        gl.uniform1f(P.u.uProjLod, pr.lod === undefined ? 0.5 : pr.lod);
        gl.uniform1f(P.u.uNearDim, pr.nearDim === undefined ? 0.35 : pr.nearDim);
        setPicture(P, pr, pr.leak);
      } else {
        gl.uniform1i(P.u.uProjOn, 0);
      }
      // with a shadow, every shell twice: the shadows on the snow first, then the flakes over them
      for (const pass of sw ? [1, 0] : [0]) {
        gl.uniform1i(P.u.uShadowOn, pass);
        for (let si = 0; si < shells.length; si++) {
          const s = shells[si];
          if (!s.count) continue;
          if (pass === 1 && sw.shells && !sw.shells.includes(si)) continue; // shells too far for a shadow to show
          gl.uniform3fv(P.u.uCenter, s.center);
          gl.uniform3fv(P.u.uSize, s.size);
          gl.uniform1f(P.u.uSizeK, s.sizeK);
          gl.uniform1f(P.u.uGainK, s.gainK);
          gl.uniform1f(P.u.uEdge, s.edge);
          gl.drawArrays(gl.POINTS, s.first, s.count);
        }
      }
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      FILM.mark("snow:flakes", sync);
      return canvas;
    }

    return { canvas, gl, info, render, shells, total, atlas };
  }

  global.SNOW = { field, camera, clock, sampleClock, makeAtlas, homography, mul, invert };
})(window);
