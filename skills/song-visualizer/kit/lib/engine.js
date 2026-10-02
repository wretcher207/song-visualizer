// Film engine: one canvas, one global clock. Scenes register with FILM.scene(name, def) and the timeline (timeline.js) says
// which scene owns each moment.
//
// Scene contract:
//   FILM.scene("name", {
//     layout(env)          optional, runs once before init: returns positions for the current frame size
//                          (env.W x env.H, env.vertical). The result is env.layouts[name] and draw's 4th arg.
//     init(env, lay)       optional, runs once before the first draw (precompute geometry, canvases)
//     draw(ctx, t, env, lay)  draw a FULL env.W x env.H frame for GLOBAL time t (seconds)
//   })
// Rules: deterministic (LOOK.rng / LOOK.hash, env.f for the frame number, env.b for boil), no clocks,
// no Math.random. A scene may draw another scene nested: env.drawScene("name", ctx, t).
(function (global) {
  const L = global.LOOK;
  const scenes = {};
  const inited = new Set();
  const FILM = { scenes, timeline: [], duration: 0, fps: 24 };

  const env = {
    W: L.W,
    H: L.H,
    vertical: false,
    t: 0,
    f: 0, // frame number, round(t * fps)
    b: 0, // boil index: floor(f / 2), strict twos at 24 fps
    fps: 24,
    L,
    drawScene,
    layouts: {},
    segment: null,
    at, // env.at(table, t): per-frame table sampled at t, linear between frames
  };

  FILM.scene = function (name, def) {
    scenes[name] = def;
  };

  // Per-frame tables (features.js, snow clocks) hold one value per frame at 24 fps.
  function at(arr, t) {
    const x = Math.max(0, Math.min(arr.length - 1.000001, t * FILM.fps));
    const i = Math.floor(x);
    const u = x - i;
    return arr[i] + (arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * u;
  }

  function placeholder(ctx, name, t) {
    ctx.fillStyle = "#26262b";
    ctx.fillRect(0, 0, env.W, env.H);
    ctx.fillStyle = "#9a9aa5";
    ctx.font = "600 64px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`[${name}]  t=${t.toFixed(2)}`, env.W / 2, env.H / 2);
  }

  function drawScene(name, ctx, t) {
    const s = scenes[name];
    if (!s) {
      placeholder(ctx, name, t);
      return;
    }
    if (!inited.has(name)) {
      inited.add(name);
      env.layouts[name] = s.layout ? s.layout(env) : {};
      if (s.init) s.init(env, env.layouts[name]);
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    s.draw(ctx, t, env, env.layouts[name]);
    ctx.restore();
  }

  function segmentAt(t) {
    const tl = FILM.timeline;
    for (let i = 0; i < tl.length; i++) {
      if (t >= tl[i].start && t < tl[i].end) return tl[i];
    }
    return tl[tl.length - 1];
  }

  // The frame size comes from the canvas: 1920x1080 for index.html, 1080x1920 for vertical/index.html.
  // Which GPU is this Chrome on? On SwiftShader (the software renders) every 2D canvas stays on the CPU
  // rasteriser (LOOK.soft2d); on a hardware GPU 2D canvases stay accelerated. All workers in one render
  // share the mode, so frames stay identical across workers.
  function probeRenderer() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return "none";
      const e = gl.getExtension("WEBGL_debug_renderer_info");
      const r = String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return r;
    } catch (err) {
      return "none";
    }
  }

  let ctx = null;
  FILM.attach = function (canvas) {
    FILM.renderer = probeRenderer();
    L.soft2d = /swiftshader|llvmpipe|software|none/i.test(FILM.renderer);
    ctx = canvas.getContext("2d", { willReadFrequently: L.soft2d });
    L.setSize(canvas.width, canvas.height);
    env.W = canvas.width;
    env.H = canvas.height;
    env.vertical = canvas.height > canvas.width;
  };

  // Redraw guard. A HyperFrames render calls FILM.render about six times per captured frame (the
  // runtime seeks the timeline several times, including a +0.001 s nudge, then hf-seek fires). The
  // first call already draws the frame, so repeat calls for the same frame number return early:
  // identical frames in a fraction of the capture time. Keep it.
  //   - Render at --fps equal to FILM.fps; at a higher render rate some frames would repeat.
  //   - Anything that finishes loading asynchronously must call FILM.invalidate() so the frame redraws.
  //   - force = true always draws: the dev pages pass it, and hf-seek must too if a scene samples a <video>.
  let lastF = -1;
  FILM.invalidate = function () {
    lastF = -1;
  };

  // Images a scene needs (a painted plate, a texture). FILM.asset(url) starts the load when the scene's script runs and
  // holds the render until it has loaded: HyperFrames waits on window.__hf.buildReady before it seeks (a declared
  // hold, registered while the scripts load), and the dev pages wait on FILM.ready(). The redraw guard is reset
  // when an image arrives, so nothing drawn before it sticks. URLs are relative to the project's root; the dev pages
  // set window.FILM_BASE = "../".
  const pending = [];
  // Until every asset is in, nothing initialises or draws: a scene's init builds from its images, and the HyperFrames root renders once while the scripts are still loading.
  let loading = 0;
  FILM.asset = function (url) {
    const img = new Image();
    const loaded = new Promise((res) => {
      img.onload = () => res();
      img.onerror = () => res();
    });
    img.src = (global.FILM_BASE || "") + url;
    // the load event only: drawImage decodes on first use, and img.decode() can hang in headless Chrome when two
    // images decode at once under a virtual time budget (seen with two large plates)
    loading++;
    pending.push(
      loaded.then(() => {
        loading--;
        FILM.invalidate();
      }),
    );
    global.__hf = global.__hf || {};
    global.__hf.buildReady = global.__hf.buildReady || {};
    global.__hf.buildReady["visualizer-assets"] = Promise.all(pending);
    return img;
  };
  FILM.ready = () => Promise.all(pending);

  FILM.render = function (time, force) {
    if (loading > 0) return; // FILM.invalidate() when the last asset arrives lets the next call draw
    const t = Math.max(0, Math.min(FILM.duration - 1e-6, time));
    const f = Math.round(t * FILM.fps);
    if (f === lastF && !force) return;
    lastF = f;
    env.t = t;
    env.f = f;
    env.fps = FILM.fps;
    // Boil on the frame number, strict twos. (GSAP rounds the clock to 1e-6 s, so a boil keyed on
    // floor(t * 12) would hold 3-1-2 frames; rounding to the frame first gives a clean 2-2-2.)
    env.b = Math.floor(f / 2);
    const seg = segmentAt(t);
    env.segment = seg;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    FILM.mark("start");
    drawScene(seg.name, ctx, t);
    L.applyGrain(ctx, env.b, seg.grain === undefined ? 0.12 : seg.grain);
    FILM.mark("grain", () => ctx.getImageData(0, 0, 1, 1));
  };

  // Draw a WebGL field into the 2D frame without the frame ever taking a WebGL canvas as a source. The first time a
  // 2D canvas draws a WebGL canvas, Chrome moves it onto the GPU path: on SwiftShader every later 2D call then costs
  // 5 to 50 times more (a full-frame layer 3 ms before, 15 ms after; small fills far worse), and the first frame
  // rounds differently from every later one. So the pixels are read back (readPixels, about 20 ms for 1080p) into a
  // CPU-side canvas and drawn from there, flipped (GL rows run bottom up). premultiplied: the field's canvas holds
  // premultiplied alpha (ink fields), undone for putImageData.
  const staging = new Map();
  FILM.blit = function (ctx, gl, op = "source-over", premultiplied = false) {
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    let st = staging.get(gl);
    if (!st) {
      const c = L.canvas(W, H);
      st = { c, g: c.getContext("2d"), img: new ImageData(W, H) };
      staging.set(gl, st);
    }
    const px = st.img.data;
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px.buffer));
    if (premultiplied) {
      for (let i = 3; i < px.length; i += 4) {
        const a = px[i];
        if (a > 0 && a < 255) {
          const k = 255 / a;
          px[i - 3] *= k;
          px[i - 2] *= k;
          px[i - 1] *= k;
        }
      }
    }
    st.g.putImageData(st.img, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = op;
    ctx.translate(0, H);
    ctx.scale(1, -1);
    ctx.drawImage(st.c, 0, 0);
    ctx.restore();
  };

  // Dev profiling hook: the dev harness replaces this to time each stage (scenes call FILM.mark("name", flush)
  // after a stage; flush forces the GPU to finish so the time lands on the right stage). A no-op in renders.
  FILM.mark = function () {};

  FILM.segmentAt = segmentAt;
  FILM.env = env;
  global.FILM = FILM;
})(window);
