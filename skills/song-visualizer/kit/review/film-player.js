
<script>
(() => {
  // A film in parts (fragmented MP4s of `len` seconds, timestamps from zero in each). Where Media Source works, the
  // parts are appended into one buffer as they're needed, so the film plays straight through and seeks anywhere;
  // where it doesn't, the parts play one after another in the same player. Nothing loads until play is pressed.
  const MS = window.ManagedMediaSource || window.MediaSource;
  const managed = !!window.ManagedMediaSource && MS === window.ManagedMediaSource;
  document.querySelectorAll(".film").forEach((box) => {
    const video = box.querySelector("video");
    const state = box.querySelector(".state");
    const n = +box.dataset.n, len = +box.dataset.len, dur = +box.dataset.dur, dir = box.dataset.parts;
    const mime = 'video/mp4; codecs="' + box.dataset.codecs + '"';
    const url = (k) => dir + "/part" + String(k).padStart(2, "0") + ".mp4";
    let mode = null;

    const sequential = () => {
      if (mode === "parts") return;
      mode = "parts";
      let k = 0;
      const load = (i, play) => {
        k = i;
        video.src = url(i);
        if (play) video.play().catch(() => {});
      };
      video.addEventListener("ended", () => { if (k + 1 < n) load(k + 1, true); });
      load(0, false);
      state.textContent = "This browser plays it in " + n + " parts of " + len + " seconds, with a short pause between them.";
    };
    if (!MS || !MS.isTypeSupported || !MS.isTypeSupported(mime)) return sequential();

    const ms = new MS();
    if (managed) video.disableRemotePlayback = true;
    let opened = false;
    const fail = () => { if (!opened) sequential(); };
    video.addEventListener("error", fail, { once: true });
    const timer = setTimeout(fail, 6000);
    ms.addEventListener("sourceopen", () => {
      clearTimeout(timer);
      if (mode === "parts") return;
      opened = true;
      mode = "stream";
      let sb;
      try {
        sb = ms.addSourceBuffer(mime);
        sb.mode = "segments";
        ms.duration = dur;
      } catch (e) {
        opened = false;
        return sequential();
      }
      // a part is in when the buffer covers it (the browser may drop what's behind the playhead on its own)
      const loaded = (k) => {
        const a = k * len + 0.25;
        const b = Math.min((k + 1) * len, dur) - 0.25;
        const r = sb.buffered;
        for (let i = 0; i < r.length; i++) if (r.start(i) <= a && r.end(i) >= b) return true;
        return false;
      };
      const append = (k, buf) => new Promise((ok, bad) => {
        const off = () => { sb.removeEventListener("updateend", done); sb.removeEventListener("error", err); };
        const done = () => { off(); ok(); };
        const err = () => { off(); bad(new Error("append")); };
        sb.addEventListener("updateend", done);
        sb.addEventListener("error", err);
        try {
          sb.timestampOffset = k * len;
          sb.appendBuffer(buf);
        } catch (e) {
          off();
          bad(e);
        }
      });
      // make room: drop what's more than one part behind the playhead
      const trim = () => new Promise((ok) => {
        const behind = Math.floor(video.currentTime / len - 1) * len;
        if (behind <= 0) return ok();
        sb.addEventListener("updateend", ok, { once: true });
        try { sb.remove(0, behind); } catch (e) { ok(); }
      });
      let busy = false;
      let started = false;
      let appended = 0;
      // keep the part under the playhead and the next two loaded
      const pump = async () => {
        if (busy || !started || mode !== "stream") return;
        busy = true;
        try {
          for (;;) {
            const here = Math.min(n - 1, Math.floor(video.currentTime / len));
            let k = -1;
            for (let i = here; i < Math.min(n, here + 3); i++) if (!loaded(i)) { k = i; break; }
            if (k < 0) break;
            const buf = await fetch(url(k)).then((r) => {
              if (!r.ok) throw new Error(String(r.status));
              return r.arrayBuffer();
            });
            try { await append(k, buf); } catch (e) { await trim(); await append(k, buf); }
            appended++;
            if (k === n - 1 && ms.readyState === "open") { try { ms.endOfStream(); } catch (e) {} }
          }
        } catch (e) {
          // the stream opened but wouldn't take the first part: play the parts one after another instead
          if (!appended) {
            busy = false;
            mode = null;
            sequential();
            video.play().catch(() => {});
            return;
          }
          state.textContent = "A part didn't load. Reload the page to try again.";
        }
        busy = false;
      };
      const start = () => { started = true; pump(); };
      video.addEventListener("play", start);
      video.addEventListener("seeking", start);
      video.addEventListener("timeupdate", pump);
      video.addEventListener("waiting", pump);
      if (managed) ms.addEventListener("startstreaming", pump);
    }, { once: true });
    try { video.src = URL.createObjectURL(ms); } catch (e) { clearTimeout(timer); sequential(); }
  });
})();
</script>
