// Natural media beyond look.js: toned papers, graphite and coloured pencil, charcoal, chalk, hatching that
// only accumulates (tonal art maps), Kentridge ghosts, and a GPU field of pencil strokes for marks that
// grow by the tens of thousands (frost). Deterministic: seeded, no clocks. Loaded after look.js.
//
// 2D (bake into layers at init; nothing here is meant to run per stroke per frame):
//   MEDIA.paper(W, H, { tone, seed, blotch, fibre })     toned paper canvas (cached): "blue-black", "grey",
//                                                        "cream" or [r, g, b]
//   MEDIA.tooth(W, H, seed)                              the paper's height field, grey canvas (cached)
//   MEDIA.toothed(layer, tooth, k)                       knock paint out of a layer's valleys: pencil on paper
//   MEDIA.pencil(g, pts, o)                              a graphite line: 2 or 3 seeded passes, pressure along it
//   MEDIA.colourFill(g, path, bbox, o)                   coloured-pencil fill: crossing hatch passes, colour jitter
//   MEDIA.charcoal(g, pts, o)  MEDIA.chalk(g, pts, o)    broken grainy strokes (sand splines)
//   MEDIA.tam(bbox, o) -> strokes;  MEDIA.drawTam(g, strokes, tone, o)
//                                                        hatching with a fixed threshold per stroke (Praun et
//                                                        al.): a stroke draws once tone passes it, so strokes
//                                                        only ever accumulate
//   MEDIA.ghost(t, r, o)                                 alpha of a mark removed at time r (Kentridge's erasures)
// GPU (WebGL2, premultiplied, composited with plain source-over):
//   const f = MEDIA.strokeField({ W, H, strokes, tooth });  strokes: Float32Array, 12 per stroke (STROKE)
//   f.render({ grow, melt, xform, ghost, toothK }) -> f.canvas
(function (global) {
  const L = global.LOOK;

  // ---------- papers ----------
  const TONES = {
    "blue-black": [20, 25, 38],
    grey: [128, 128, 126],
    cream: [226, 216, 196],
  };
  const _paper = new Map();
  function paper(W, H, o = {}) {
    const key = [W, H, JSON.stringify(o)].join(":");
    if (_paper.has(key)) return _paper.get(key);
    const base = Array.isArray(o.tone) ? o.tone : TONES[o.tone || "grey"];
    const seed = o.seed || 7;
    const c = L.canvas(W, H);
    const g = c.getContext("2d");
    g.fillStyle = L.css(base);
    g.fillRect(0, 0, W, H);
    // low pigment blotches, then the fibres
    g.save();
    g.globalCompositeOperation = "soft-light";
    g.globalAlpha = o.blotch === undefined ? 0.35 : o.blotch;
    g.filter = "blur(60px)";
    g.drawImage(L.noiseCanvas(40, 24, seed, 50, false), -150, -150, W + 300, H + 300);
    g.filter = "none";
    g.globalAlpha = o.fibre === undefined ? 0.3 : o.fibre;
    g.drawImage(tooth(W, H, seed + 1), 0, 0);
    g.restore();
    _paper.set(key, c);
    return c;
  }

  // the paper's tooth: fine grain (1 to 2 px) over a slightly coarser weave, mean 128
  const _tooth = new Map();
  function tooth(W, H, seed = 3) {
    const key = [W, H, seed].join(":");
    if (_tooth.has(key)) return _tooth.get(key);
    const c = L.canvas(W, H);
    const g = c.getContext("2d");
    g.drawImage(L.noiseCanvas(W, H, seed, 70, true), 0, 0);
    g.globalAlpha = 0.5;
    g.filter = "blur(1.2px)";
    g.drawImage(L.noiseCanvas(W >> 1, H >> 1, seed + 1, 80, true), 0, 0, W, H);
    g.filter = "none";
    g.globalAlpha = 1;
    _tooth.set(key, c);
    return c;
  }

  // pencil only catches the paper's peaks: darken the layer's alpha where the tooth is low (k 0..1)
  function toothed(layer, toothC, k = 0.6) {
    const c = L.canvas(layer.width, layer.height);
    const g = c.getContext("2d");
    g.drawImage(layer, 0, 0);
    g.globalCompositeOperation = "destination-out";
    g.globalAlpha = k;
    // the tooth's valleys (dark) remove paint: draw the tooth inverted as alpha
    g.drawImage(invertedAlpha(toothC), 0, 0, layer.width, layer.height);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    return c;
  }
  const _inv = new WeakMap();
  function invertedAlpha(src) {
    if (_inv.has(src)) return _inv.get(src);
    const c = L.canvas(src.width, src.height);
    const g = c.getContext("2d");
    const d = src.getContext("2d").getImageData(0, 0, src.width, src.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      // valleys (below the mean) become opaque, peaks transparent, with a soft knee
      const v = p[i] / 255;
      p[i + 3] = 255 * L.clamp01((0.62 - v) / 0.4);
      p[i] = p[i + 1] = p[i + 2] = 0;
    }
    g.putImageData(d, 0, 0);
    _inv.set(src, c);
    return c;
  }

  // ---------- strokes ----------
  // a graphite line: o.passes (2) seeded passes, each a little off the line, pressure swelling along it
  //   o: { width 1.2, color "rgba(..)", passes 2, wander 0.7, seed, b (boil), taper true }
  function pencil(g, pts, o = {}) {
    const passes = o.passes || 2;
    const w = o.width || 1.2;
    const seed = o.seed || 1;
    const b = o.b || 0;
    for (let k = 0; k < passes; k++) {
      const p = L.boil(pts, seed * 13 + k * 101, b, (o.wander === undefined ? 0.7 : o.wander) * (k ? 1 : 0.6), 5);
      const ph = L.hash(seed, k, 3) * 6;
      const press = (u) => {
        const end = o.taper === false ? 1 : Math.min(1, Math.min(u, 1 - u) * 6 + 0.25);
        return end * (0.75 + 0.25 * Math.sin(u * 7 + ph));
      };
      L.taperedLine(g, p, (u) => w * (k ? 0.75 : 1) * press(u), o.color || "rgba(30,30,34,0.7)");
    }
  }

  // coloured-pencil fill: o.angles hatch passes across the path, each stroke's colour jittered
  //   o: { angles [-0.9, 0.6], spacing 4, len 26, width 1, colors [...] or color, jitter 0.08, alpha, seed, b }
  function colourFill(g, path, bbox, o = {}) {
    const angles = o.angles || [-0.9, 0.6];
    const cols = o.colors || [o.color || "#8aa0c0"];
    const seed = o.seed || 1;
    angles.forEach((ang, k) => {
      const col = cols[k % cols.length];
      const rgb = L.hex(col);
      const j = o.jitter === undefined ? 0.08 : o.jitter;
      // hatch draws one colour per call: split the pass into a few jittered sub-passes
      for (let s = 0; s < 3; s++) {
        const m = 1 + (L.hash(seed, k, s) - 0.5) * 2 * j;
        L.hatch(g, path, bbox, {
          angle: ang + (L.hash(seed, k, s + 9) - 0.5) * 0.06,
          spacing: (o.spacing || 4) * 3,
          len: o.len === undefined ? 26 : o.len,
          width: o.width || 1,
          color: L.css(L.shade(rgb, m), o.alpha === undefined ? 0.35 : o.alpha),
          jitter: 2,
          seed: seed * 7 + k * 3 + s,
          b: o.b || 0,
        });
      }
    });
  }

  // charcoal and chalk: grains scattered across the line, thick at the centre, broken at the edges (sand
  // splines), so the stroke has a grainy edge and gaps where the stick skipped
  //   o: { width 6, color, density 1, seed, alpha, skip 0.15 }
  function sand(g, pts, o, kind) {
    const w = o.width || 6;
    const r = L.rng(o.seed || 1);
    const col = o.color || (kind === "chalk" ? "rgba(235,238,242,1)" : "rgba(20,20,22,1)");
    const a0 = o.alpha === undefined ? (kind === "chalk" ? 0.5 : 0.6) : o.alpha;
    const dens = (o.density || 1) * (kind === "chalk" ? 0.8 : 1.4);
    const skip = o.skip === undefined ? (kind === "chalk" ? 0.25 : 0.12) : o.skip;
    g.save();
    g.fillStyle = col;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const n = Math.max(4, Math.round(len * w * dens * 0.35));
    // walk the line by arc length
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    let seg = 1;
    for (let k = 0; k < n; k++) {
      const s = (k / n) * len;
      while (seg < pts.length - 1 && cum[seg] < s) seg++;
      const p0 = pts[seg - 1];
      const p1 = pts[seg];
      const sl = cum[seg] - cum[seg - 1] || 1;
      const u = (s - cum[seg - 1]) / sl;
      const x = L.lerp(p0[0], p1[0], u);
      const y = L.lerp(p0[1], p1[1], u);
      const nx = -(p1[1] - p0[1]) / sl;
      const ny = (p1[0] - p0[0]) / sl;
      // skips: the stick lifts off the paper for a moment
      if (L.noise1((o.seed || 1) * 3 + 1, s / 18) > 1 - skip * 2) continue;
      const across = r.gauss() * 0.9; // grains thin out toward the edges
      const d = across * w * 0.5;
      const sz = r.range(0.6, 1.6) * (kind === "chalk" ? 1.2 : 1);
      g.globalAlpha = a0 * (1 - Math.min(1, Math.abs(across) * 0.55)) * r.range(0.4, 1);
      g.fillRect(x + nx * d - sz / 2, y + ny * d - sz / 2, sz, sz);
    }
    g.restore();
  }
  const charcoal = (g, pts, o = {}) => sand(g, pts, o, "charcoal");
  const chalk = (g, pts, o = {}) => sand(g, pts, o, "chalk");

  // ---------- tonal art maps ----------
  // strokes covering bbox (as hatch lines broken into dashes), each with a threshold; level k of n angles
  // switches on cross-hatching. A stroke is drawn when tone >= its threshold, so raising tone only adds.
  //   o: { angles [-0.8, 0.75, 0.05], spacing 5, len 30, seed }
  function tam(bbox, o = {}) {
    const [x0, y0, x1, y1] = bbox;
    const angles = o.angles || [-0.8, 0.75, 0.05];
    const spacing = o.spacing || 5;
    const len = o.len || 30;
    const r = L.rng(o.seed || 1);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const R = Math.hypot(x1 - x0, y1 - y0) / 2 + len;
    const out = [];
    angles.forEach((ang, level) => {
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      for (let off = -R; off <= R; off += spacing) {
        const bx = cx - dy * (off + r.range(-1, 1));
        const by = cy + dx * (off + r.range(-1, 1));
        let s = -R + r() * len;
        while (s < R) {
          const l = len * r.range(0.6, 1.3);
          const ax = bx + dx * s;
          const ay = by + dy * s;
          const ex = bx + dx * (s + l);
          const ey = by + dy * (s + l);
          if (Math.max(ax, ex) > x0 && Math.min(ax, ex) < x1 && Math.max(ay, ey) > y0 && Math.min(ay, ey) < y1) {
            // thresholds: each angle owns a band of tone, strokes spread evenly through it
            const th = (level + r()) / angles.length;
            out.push([ax, ay, ex, ey, th]);
          }
          s += l + len * r.range(0.3, 0.8);
        }
      }
    });
    out.sort((a, b) => a[4] - b[4]);
    return out;
  }
  // draw every stroke whose threshold is at most tone (strokes are sorted, so this is a prefix)
  function drawTam(g, strokes, tone, o = {}) {
    g.save();
    if (o.clip) g.clip(o.clip);
    g.strokeStyle = o.color || "rgba(30,30,34,0.35)";
    g.lineWidth = o.width || 1;
    g.lineCap = "round";
    g.beginPath();
    for (const s of strokes) {
      if (s[4] > tone) break;
      g.moveTo(s[0], s[1]);
      g.lineTo(s[2], s[3]);
    }
    g.stroke();
    g.restore();
  }

  // ---------- erasure ----------
  // a mark removed at time r: full before r; after it, a faint ghost that fades (o.keep, o.decay seconds),
  // the way Kentridge's rubbed-out charcoal stays on the sheet
  function ghost(t, r, o = {}) {
    if (t < r) return 1;
    const keep = o.keep === undefined ? 0.14 : o.keep;
    const fade = o.fade === undefined ? 0.6 : o.fade; // seconds to fall from full to the ghost
    const decay = o.decay === undefined ? 40 : o.decay;
    const u = L.clamp01((t - r) / fade);
    return L.lerp(1, keep, L.ease.sineO(u)) * Math.exp(-Math.max(0, t - r - fade) / decay);
  }

  // ---------- GPU stroke field ----------
  // STROKE: 12 floats per stroke:
  //   x0, y0, x1, y1      layout px (y down); the field's xform maps them to the frame
  //   width, alpha        px, 0..1
  //   birth               the stroke grows while grow passes birth .. birth + 1 (drawn from x0, y0 to x1, y1)
  //   die                 erased when melt passes die; leaves a ghost (see render)
  //   r, g, b             0..1 (sRGB)
  //   seed                any number; varies pressure along the stroke
  const STROKE = 12;
  // Each stroke is one GL point whose sprite covers it; the fragment shader cuts the capsule out of the sprite.
  // (Instanced quads cost about 11 us per stroke on SwiftShader even when culled; points cost about 1 us.)
  // Strokes longer than the point size limit are split when the field is built.
  const VS = `#version 300 es
  precision highp float;
  layout(location = 0) in vec4 aSeg;
  layout(location = 1) in vec4 aMeta;
  layout(location = 2) in vec4 aCol;
  uniform vec2 uRes;
  uniform mat3 uX;
  uniform float uGrow, uMelt, uGhostKeep, uGhostSpan, uWidthK, uMaxPoint;
  out vec2 vA, vB, vMid;
  out float vW, vAlpha, vSeed, vSize;
  out vec3 vColor;
  void off() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; }
  void main() {
    float g = clamp(uGrow - aMeta.z, 0.0, 1.0);
    float alpha = aMeta.y;
    if (uMelt > aMeta.w) alpha *= uGhostKeep * clamp(1.0 - (uMelt - aMeta.w) / uGhostSpan, 0.0, 1.0);
    if (g <= 0.0 || alpha <= 0.002) { off(); return; }
    vec3 ha = uX * vec3(aSeg.xy, 1.0);
    vec3 hb = uX * vec3(aSeg.zw, 1.0);
    vec2 a = ha.xy / ha.z; // a homography: frost on a pane seen in perspective
    vec2 b = mix(a, hb.xy / hb.z, g);
    float w = aMeta.x * uWidthK;
    vec2 mid = 0.5 * (a + b);
    float size = min(max(abs(b.x - a.x), abs(b.y - a.y)) + w + 3.0, uMaxPoint);
    if (mid.x < -size || mid.y < -size || mid.x > uRes.x + size || mid.y > uRes.y + size) { off(); return; }
    vA = a;
    vB = b;
    vMid = mid;
    vW = w;
    vAlpha = alpha;
    vSeed = aCol.w;
    vSize = size;
    vColor = aCol.rgb;
    gl_Position = vec4(mid.x / uRes.x * 2.0 - 1.0, 1.0 - mid.y / uRes.y * 2.0, 0.0, 1.0);
    gl_PointSize = size;
  }`;
  const FS = `#version 300 es
  precision highp float;
  in vec2 vA, vB, vMid;
  in float vW, vAlpha, vSeed, vSize;
  in vec3 vColor;
  uniform sampler2D uTooth;
  uniform vec2 uToothSize;
  uniform float uToothK;
  out vec4 o;
  void main() {
    vec2 p = vMid + (gl_PointCoord - 0.5) * vSize; // gl_PointCoord runs y down, like the layout
    vec2 ab = vB - vA;
    float l2 = max(dot(ab, ab), 1e-6);
    float h = clamp(dot(p - vA, ab) / l2, 0.0, 1.0);
    float d = length(p - vA - ab * h);
    float r = vW * 0.5;
    float cov = clamp(r + 0.6 - d, 0.0, 1.0) * clamp(r * 2.0 + 0.35, 0.0, 1.0);
    if (cov <= 0.0) discard;
    // pressure, one per stroke (strokes chain into branches, so no taper of their own); heavier pressure
    // reaches further down into the paper's tooth
    float press = 0.62 + 0.38 * fract(vSeed * 0.6180339 + 0.31);
    float t = texture(uTooth, p / uToothSize).r;
    float dep = mix(1.0, smoothstep(1.0 - press - 0.25, 1.0 - press + 0.2, t), uToothK);
    float a = vAlpha * cov * dep;
    o = vec4(vColor * a, a);
  }`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("media shader: " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("media link: " + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  // strokes longer than max px become a chain of pieces that grow one after another inside the same birth
  function splitLong(st, max) {
    const n = st.length / STROKE;
    let extra = 0;
    for (let i = 0; i < n; i++) {
      const k = i * STROKE;
      extra += Math.max(0, Math.ceil(Math.hypot(st[k + 2] - st[k], st[k + 3] - st[k + 1]) / max) - 1);
    }
    if (!extra) return st;
    const out = new Float32Array((n + extra) * STROKE);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const k = i * STROKE;
      const m = Math.max(1, Math.ceil(Math.hypot(st[k + 2] - st[k], st[k + 3] - st[k + 1]) / max));
      for (let q = 0; q < m; q++) {
        out.set(st.subarray(k, k + STROKE), j);
        out[j] = L.lerp(st[k], st[k + 2], q / m);
        out[j + 1] = L.lerp(st[k + 1], st[k + 3], q / m);
        out[j + 2] = L.lerp(st[k], st[k + 2], (q + 1) / m);
        out[j + 3] = L.lerp(st[k + 1], st[k + 3], (q + 1) / m);
        out[j + 6] = st[k + 6] + q / m; // birth: piece q grows during the q-th part of the stroke's step
        j += STROKE;
      }
    }
    return out;
  }

  // o: { W, H, strokes (Float32Array, STROKE floats each), tooth (canvas, default MEDIA.tooth 512) }
  function strokeField(o) {
    const W = o.W || L.W;
    const H = o.H || L.H;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const gl = canvas.getContext("webgl2", {
      preserveDrawingBuffer: true,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw new Error("media: WebGL2 unavailable");
    const P = compile(gl, VS, FS);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const maxPoint = Math.min(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1], 256);
    const strokes = splitLong(o.strokes, (maxPoint - 8) * 0.9);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, strokes, gl.STATIC_DRAW);
    const stride = STROKE * 4;
    for (let k = 0; k < 3; k++) {
      gl.enableVertexAttribArray(k);
      gl.vertexAttribPointer(k, 4, gl.FLOAT, false, stride, k * 16);
    }
    gl.bindVertexArray(null);
    const count = strokes.length / STROKE;
    const tc = o.tooth || tooth(512, 512, 5);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // r: { grow, melt, xform (mat3, column-major: layout -> frame px, affine or a homography), ghostKeep,
    //      ghostSpan, toothK, widthK }
    function render(r = {}) {
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(P.p);
      gl.uniform2f(P.u.uRes, W, H);
      gl.uniformMatrix3fv(P.u.uX, false, r.xform || new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]));
      gl.uniform1f(P.u.uGrow, r.grow === undefined ? 1e9 : r.grow);
      gl.uniform1f(P.u.uMelt, r.melt === undefined ? -1e9 : r.melt);
      gl.uniform1f(P.u.uGhostKeep, r.ghostKeep === undefined ? 0.14 : r.ghostKeep);
      gl.uniform1f(P.u.uGhostSpan, r.ghostSpan === undefined ? 1e6 : r.ghostSpan);
      gl.uniform1f(P.u.uWidthK, r.widthK || 1);
      gl.uniform1f(P.u.uMaxPoint, maxPoint);
      gl.uniform1f(P.u.uToothK, r.toothK === undefined ? 0.8 : r.toothK);
      gl.uniform2f(P.u.uToothSize, tc.width, tc.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(P.u.uTooth, 0);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      return canvas;
    }
    return { canvas, gl, render, count };
  }

  global.MEDIA = {
    TONES,
    paper,
    tooth,
    toothed,
    pencil,
    colourFill,
    charcoal,
    chalk,
    tam,
    drawTam,
    ghost,
    STROKE,
    strokeField,
  };
})(window);
