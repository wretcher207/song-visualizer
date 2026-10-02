// Shared look + math for every scene. Loaded first; exposes window.LOOK.
// Everything here is deterministic: no Math.random, no clocks.
(function (global) {
  // Frame size. FILM.attach sets it from the canvas (LOOK.setSize), so 16:9 and 9:16 share one code path.
  let W = 1920;
  let H = 1080;
  const TAU = Math.PI * 2;

  // ---------- randomness ----------
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // seeded generator with helpers: const r = LOOK.rng(42); r(); r.range(a, b); r.int(n); r.pick(arr); r.sign()
  function rng(seed) {
    const f = mulberry32(seed);
    f.range = (a, b) => a + (b - a) * f();
    f.int = (n) => Math.floor(f() * n);
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    f.sign = () => (f() < 0.5 ? -1 : 1);
    f.gauss = () => (f() + f() + f() + f() - 2) / 2; // ~N(0, 0.58)
    return f;
  }
  // stateless hash of up to 3 integers -> [0, 1)
  function hash(a, b = 0, c = 0) {
    let h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  // smooth 1D value noise, [-1, 1]
  function noise1(seed, x) {
    const i = Math.floor(x);
    const f = x - i;
    const a = hash(seed, i, 0);
    const b = hash(seed, i + 1, 0);
    const s = f * f * (3 - 2 * f);
    return (a + (b - a) * s) * 2 - 1;
  }
  // smooth 2D value noise, [-1, 1]
  function noise2(seed, x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    const h = (i, j) => hash(seed, xi + i + (yi + j) * 7919, 17);
    const a = h(0, 0) + (h(1, 0) - h(0, 0)) * sx;
    const b = h(0, 1) + (h(1, 1) - h(0, 1)) * sx;
    return (a + (b - a) * sy) * 2 - 1;
  }
  // fractal noise, roughly [-1, 1]
  function fbm2(seed, x, y, oct = 4) {
    let v = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      v += noise2(seed + o * 101, x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return v / norm;
  }

  // ---------- math ----------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, x) => clamp01((x - a) / (b - a));
  const win = (t, start, dur) => clamp01((t - start) / dur); // 0..1 progress of a window
  const smooth = (t) => t * t * (3 - 2 * t);
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const ease = {
    linear: (t) => t,
    p2i: (t) => t * t,
    p2o: (t) => 1 - (1 - t) * (1 - t),
    p2io: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    p3i: (t) => t * t * t,
    p3o: (t) => 1 - Math.pow(1 - t, 3),
    p3io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    p4io: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
    expoI: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
    expoO: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    expoIO: (t) =>
      t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
    sineIO: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    sineO: (t) => Math.sin((t * Math.PI) / 2),
    sineI: (t) => 1 - Math.cos((t * Math.PI) / 2),
    backO: (t, s = 1.70158) => {
      const c3 = s + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
    },
    backI: (t, s = 1.70158) => (s + 1) * t * t * t - s * t * t,
    elasticO: (t) =>
      t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  };
  // piecewise-linear remap through [[x0,y0],[x1,y1],...] (x ascending), clamped at the ends
  function remap(x, pts) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  }

  // ---------- colour ----------
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const shade = (c, k) => c.map((v) => clamp(v * k, 0, 255));
  const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const mixHex = (a, b, t, alpha = 1) => css(mix(hex(a), hex(b), t), alpha);

  // ---------- canvases ----------
  function canvas(w = W, h = H) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    // On the software GPU (SwiftShader) Chrome would rasterise 2D canvases through it, about 100 ms per
    // full-frame composite; willReadFrequently keeps them on the CPU rasteriser instead (FILM.attach decides).
    if (LOOK.soft2d) c.getContext("2d", { willReadFrequently: true });
    return c;
  }
  // grey noise canvas (values centred on 128), for overlay/soft-light texture
  function noiseCanvas(w, h, seed, amp = 70, gaussian = true) {
    const c = canvas(w, h);
    const g = c.getContext("2d");
    const img = g.createImageData(w, h);
    const r = mulberry32(seed);
    for (let i = 0; i < w * h; i++) {
      const n = gaussian ? r() + r() - 1 : r() * 2 - 1;
      const v = 128 + n * amp;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // Paper / backdrop canvas (static, W x H). opts:
  //   base: "#rrggbb" or gradient stops [[0,"#.."],[1,"#.."]] (vertical)
  //   lift: {x, y, r, color: "r,g,b", a}   optional soft radial lightening
  //   blotch: 0..1 strength of low-frequency pigment blotches (default 0.3)
  //   blotchBlur: px (default 80), blotchCells: grid width (default 32)
  //   fibers: 0..1 strength of fine paper fibres/speckle (default 0)
  //   seed
  const _paperCache = new Map();
  function paper(opts) {
    const key = W + "x" + H + JSON.stringify(opts);
    if (_paperCache.has(key)) return _paperCache.get(key);
    const c = canvas();
    const g = c.getContext("2d");
    if (typeof opts.base === "string") {
      g.fillStyle = opts.base;
    } else {
      const lin = g.createLinearGradient(0, 0, 0, H);
      for (const [s, col] of opts.base) lin.addColorStop(s, col);
      g.fillStyle = lin;
    }
    g.fillRect(0, 0, W, H);
    if (opts.lift) {
      const L = opts.lift;
      const rad = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
      rad.addColorStop(0, `rgba(${L.color},${L.a})`);
      rad.addColorStop(0.55, `rgba(${L.color},${L.a / 3})`);
      rad.addColorStop(1, `rgba(${L.color},0)`);
      g.fillStyle = rad;
      g.fillRect(0, 0, W, H);
    }
    const seed = opts.seed || 11;
    const blotch = opts.blotch === undefined ? 0.3 : opts.blotch;
    if (blotch > 0) {
      const cw = opts.blotchCells || 32;
      const ch = Math.round((cw * 9) / 16);
      const small = noiseCanvas(cw, ch, seed, 45, false);
      g.save();
      g.globalCompositeOperation = "soft-light";
      g.globalAlpha = blotch;
      g.filter = `blur(${opts.blotchBlur || 80}px)`;
      g.imageSmoothingEnabled = true;
      g.drawImage(small, -200, -200, W + 400, H + 400);
      g.restore();
    }
    if (opts.fibers) {
      const n = noiseCanvas(W / 2, H / 2, seed + 7, 90, true);
      g.save();
      g.globalCompositeOperation = "soft-light";
      g.globalAlpha = opts.fibers;
      g.drawImage(n, 0, 0, W, H);
      g.restore();
    }
    _paperCache.set(key, c);
    return c;
  }

  // Film grain, animated on the boil clock. Applied globally by the engine. Plain source-over draws of
  // pre-made grain frames (light and dark specks carried in alpha), offset per boil frame: on the software
  // GPU an "overlay" pattern fill cost about 85 ms a frame, a source-over draw about 3 ms.
  const GPAD = 96;
  let _grain = null;
  let _gKey = "";
  function grainFrame(w, h, seed) {
    const c = canvas(w, h);
    const g = c.getContext("2d");
    const img = g.createImageData(w, h);
    const r = mulberry32(seed);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      const n = (r() + r() + r() - 1.5) / 1.5; // about gaussian, -1..1
      const k = i * 4;
      if (n > 0) {
        d[k] = d[k + 1] = d[k + 2] = 255;
        d[k + 3] = n * 0.16 * 255;
      } else {
        d[k] = d[k + 1] = d[k + 2] = 0;
        d[k + 3] = -n * 0.3 * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function applyGrain(ctx, b, alpha) {
    if (alpha <= 0) return;
    const key = W + "x" + H;
    if (!_grain || _gKey !== key) {
      _grain = [0, 1, 2].map((k) => grainFrame(W + GPAD, H + GPAD, 1000 + k));
      _gKey = key;
    }
    const ox = Math.floor(hash(b, 7, 7) * GPAD);
    const oy = Math.floor(hash(b, 8, 8) * GPAD);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(_grain[b % 3], ox, oy, W, H, 0, 0, W, H);
    ctx.restore();
  }

  // ---------- ink ----------
  // Displace a polyline with smooth noise that re-rolls every boil frame.
  // pts: [[x,y],...]; seed: stable per-shape int; b: boil index; amp: px; freq: noise cycles along the line
  function boil(pts, seed, b, amp = 0.9, freq = 5, closed = false) {
    const n = pts.length;
    const out = new Array(n);
    const sx = seed * 7 + b * 131 + 1;
    const sy = seed * 7 + b * 131 + 2;
    for (let i = 0; i < n; i++) {
      let u = i / Math.max(1, n - 1);
      let nx = noise1(sx, u * freq);
      let ny = noise1(sy, u * freq);
      if (closed) {
        // blend so the seam matches
        const w = smooth(clamp01((u - 0.85) / 0.15));
        nx = lerp(nx, noise1(sx, 0), w);
        ny = lerp(ny, noise1(sy, 0), w);
      }
      out[i] = [pts[i][0] + nx * amp, pts[i][1] + ny * amp];
    }
    return out;
  }
  function polyPath(pts, closed = false) {
    const p = new Path2D();
    p.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
    if (closed) p.closePath();
    return p;
  }
  // smooth path through points using midpoint quadratics (keeps corners soft)
  function smoothPath(pts, closed = false) {
    const p = new Path2D();
    const n = pts.length;
    if (n < 3) return polyPath(pts, closed);
    if (closed) {
      const m0 = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2];
      p.moveTo(m0[0], m0[1]);
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      p.closePath();
    } else {
      p.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      p.lineTo(pts[n - 1][0], pts[n - 1][1]);
    }
    return p;
  }
  // wobbly circle / ellipse as points (closed). rot in radians.
  function ellipsePts(cx, cy, rx, ry, rot = 0, n = 96, a0 = 0, a1 = TAU) {
    const pts = [];
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const full = Math.abs(a1 - a0 - TAU) < 1e-6;
    const count = full ? n : n + 1;
    for (let i = 0; i < count; i++) {
      const a = lerp(a0, a1, i / n);
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      pts.push([cx + x * c - y * s, cy + x * s + y * c]);
    }
    return pts;
  }
  // periodic boil for closed round shapes (no seam): radial offset from a few sines re-phased per boil frame
  function roundBoil(cx, cy, r, seed, b, amp = 0.9, n = 120, a0 = 0, a1 = TAU) {
    const ph1 = hash(seed, b, 1) * TAU;
    const ph2 = hash(seed, b, 2) * TAU;
    const ph3 = hash(seed, b, 3) * TAU;
    const pts = [];
    const steps = Math.max(8, Math.ceil((n * Math.abs(a1 - a0)) / TAU));
    for (let i = 0; i <= steps; i++) {
      const a = lerp(a0, a1, i / steps);
      const off = amp * (0.5 * Math.sin(3 * a + ph1) + 0.3 * Math.sin(5 * a + ph2) + 0.2 * Math.sin(8 * a + ph3));
      pts.push([cx + Math.cos(a) * (r + off), cy + Math.sin(a) * (r + off)]);
    }
    return pts;
  }
  function stroke(ctx, path, width, color = "#1c1008", cap = "round") {
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = cap;
    ctx.strokeStyle = color;
    ctx.stroke(path);
  }
  function fill(ctx, path, color) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  // Variable-width ink line along an open polyline (tapers at both ends). widthFn(u) -> px.
  function taperedLine(ctx, pts, widthFn, color) {
    const n = pts.length;
    if (n < 2) return;
    const left = [];
    const right = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(n - 1, i + 1)];
      let dx = p1[0] - p0[0];
      let dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const w = widthFn(i / (n - 1)) / 2;
      left.push([pts[i][0] - dy * w, pts[i][1] + dx * w]);
      right.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
    }
    const p = new Path2D();
    p.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < n; i++) p.lineTo(left[i][0], left[i][1]);
    for (let i = n - 1; i >= 0; i--) p.lineTo(right[i][0], right[i][1]);
    p.closePath();
    ctx.fillStyle = color;
    ctx.fill(p);
  }
  // Parallel hatch strokes clipped to a path. opts: angle, spacing, len (0 = full lines), width, color, jitter, seed, b
  function hatch(ctx, clipPath, bbox, opts) {
    const { angle = -0.8, spacing = 7, len = 0, width = 1, color = "rgba(0,0,0,0.25)", jitter = 1.5, seed = 1, b = 0 } =
      opts;
    const [x0, y0, x1, y1] = bbox;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const R = Math.hypot(x1 - x0, y1 - y0) / 2 + 4;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const nx = -dy;
    const ny = dx;
    ctx.save();
    ctx.clip(clipPath);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    let k = 0;
    for (let o = -R; o <= R; o += spacing, k++) {
      const jo = (hash(seed, k, b) - 0.5) * jitter;
      const bx = cx + nx * (o + jo);
      const by = cy + ny * (o + jo);
      if (len > 0) {
        // dashes along this hatch line
        let s = -R + hash(seed, k, 99) * len;
        let m = 0;
        while (s < R) {
          const l = len * (0.6 + 0.8 * hash(seed, k * 131 + m, 5));
          ctx.moveTo(bx + dx * s, by + dy * s);
          ctx.lineTo(bx + dx * (s + l), by + dy * (s + l));
          s += l + len * (0.4 + hash(seed, k * 131 + m, 6));
          m++;
        }
      } else {
        ctx.moveTo(bx - dx * R, by - dy * R);
        ctx.lineTo(bx + dx * R, by + dy * R);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  // Additive radial glow
  function glow(ctx, x, y, r, rgb, alpha = 1, comp = "lighter") {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(0.35, `rgba(${rgb},${alpha * 0.35})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.save();
    ctx.globalCompositeOperation = comp;
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }
  // 4-point sparkle star
  function sparkle(ctx, x, y, r, color = "#fff8e0", thin = 0.18) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const a2 = a + Math.PI / 4;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a2) * r * thin, Math.sin(a2) * r * thin);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Static starfield canvas (cached per seed/density)
  const _stars = new Map();
  function starfield(seed = 3, count = 900, opts = {}) {
    const key = W + "x" + H + ":" + seed + ":" + count + JSON.stringify(opts);
    if (_stars.has(key)) return _stars.get(key);
    const c = canvas();
    const g = c.getContext("2d");
    const r = rng(seed);
    for (let i = 0; i < count; i++) {
      const x = r() * W;
      const y = r() * H;
      const s = Math.pow(r(), 3) * (opts.maxSize || 2.2) + 0.5;
      g.globalAlpha = 0.35 + r() * 0.6;
      g.fillStyle = opts.color || "#e8e6ff";
      g.beginPath();
      g.arc(x, y, s, 0, TAU);
      g.fill();
    }
    _stars.set(key, c);
    return c;
  }

  function setSize(w, h) {
    W = w;
    H = h;
    LOOK.W = w;
    LOOK.H = h;
  }

  const LOOK = (global.LOOK = {
    W,
    H,
    soft2d: false,
    setSize,
    TAU,
    INK: "#1c1008",
    mulberry32,
    rng,
    hash,
    noise1,
    noise2,
    fbm2,
    clamp,
    clamp01,
    lerp,
    invLerp,
    win,
    smooth,
    wrapPi,
    ease,
    remap,
    hex,
    mix,
    shade,
    css,
    mixHex,
    canvas,
    noiseCanvas,
    paper,
    applyGrain,
    boil,
    polyPath,
    smoothPath,
    ellipsePts,
    roundBoil,
    stroke,
    fill,
    taperedLine,
    hatch,
    glow,
    sparkle,
    starfield,
  });
})(window);
