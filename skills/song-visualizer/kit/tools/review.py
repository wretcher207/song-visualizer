"""Build a review page from a spec: the clips, stills and whole films to judge, each with "ok" / "work" and a note.

  python tools/review.py review/gate-a.json

Writes review/<name>.html and its media in review/media-<name>/ (stills as JPEG, clips at 720p, whole films streamed in
24-second parts), then prints how to publish it. Published as a Claude artifact, the page keeps the marks in the
artifact's database (collection "reviews", one document per card: verdict, note), so Claude reads them back; opened as
a plain file, it keeps them in the browser and a button copies them as JSON to paste to Claude.

The spec (JSON):
  {
    "name": "gate-a",                                   the page's file name
    "title": "my song, Gate A",
    "eyebrow": "the artist · my song · the visualizer",
    "lede": "What this page is for, in a sentence or two. <em>HTML</em> is fine in text fields.",
    "sections": [
      { "name": "key frames",
        "cards": [
          { "id": "opening", "title": "The opening", "chip": "0:00 the opening", "tag": "0:00 to 0:12",
            "look": "What to look for: the one thing this card is asking about.",
            "media": [
              { "still": "dev/out/gatea/frame_h_000.000.png", "time": "0:00", "caption": "Frame one", "alt": "...", "wide": true },
              { "clip": "dev/out/opening.mp4", "time": "0:00 to 0:12", "caption": "With the song", "poster": 3.0 },
              { "film": "final/my-song.mp4", "time": "0:00 to 3:40", "caption": "The whole cut", "vertical": false }
            ],
            "aside": "Optional small print under the media." } ] } ],
    "calls": [ { "id": "call-x", "title": "A decision to confirm", "tag": "1:20", "text": "What I chose and why." } ],
    "foot": "Optional closing line."
  }
Card kinds: "test" (Looks right / Needs work, the default) and calls (Agree / Change it). A page's files must each be
under 15 MB to publish as an artifact, and one publish carries at most 64 MB: this script keeps clips under the first
and splits the files into batches under the second. A whole artifact version holds at most 256 MB, which whole films
at the default 1600k fill at about 20 minutes of film: for more, set "film_rate" (video, e.g. "850k") and
"film_audio" (e.g. "128k") at the top of the spec. The script prints the page's total size.
"""
import hashlib, html, json, math, pathlib, shutil, subprocess, sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
KIT = ROOT / "review" / "src"
LIMIT = 15 * 1048576
BATCH = 60 * 1048576
PART = 24.0
FILM_RATE, FILM_AUDIO = "1600k", "160k"  # whole films; a spec can set "film_rate" and "film_audio"
esc = lambda s: html.escape(str(s), quote=True)  # noqa: E731


def still(src, out, name, width=1600):
    im = Image.open(project.path(src)).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    dst = out / f"{name}.jpg"
    im.save(dst, quality=90, optimize=True, progressive=True)
    return dst


def clip(src, out, name, poster=1.0):
    src = project.path(src)
    dst = out / f"{name}.mp4"
    w, h = probe_size(src)
    scale = "1280:720" if w >= h else "720:1280"
    for crf in (20, 23, 26, 29, 32):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", f"scale={scale}:flags=lanczos", "-c:v", "libx264",
                        "-profile:v", "high", "-preset", "slow", "-crf", str(crf), "-pix_fmt", "yuv420p", "-c:a", "aac",
                        "-b:a", "160k", "-movflags", "+faststart", str(dst)], check=True)
        if dst.stat().st_size < LIMIT:
            break
    else:
        sys.exit(f"{src} won't fit under 15 MB at 720p: shorten the clip, or use it as a film (streamed in parts)")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(poster), "-i", str(dst), "-frames:v", "1", "-q:v", "3",
                    str(out / f"{name}-poster.jpg")], check=True)
    return dst, w < h


def probe_size(v):
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json",
                        str(v)], capture_output=True, text=True, check=True)
    s = json.loads(p.stdout)["streams"][0]
    return s["width"], s["height"]


def film(src, out, name, rate="1600k", arate="160k"):
    """A whole cut at 720p in 24 s fragmented MP4 parts, two-pass at a fixed rate so each part stays small; the page's
    player joins them with Media Source where the browser allows it, else plays them one after another. The parts are
    kept in review/.film-cache/ under the source's path, size and time and the rates, so building the page again only
    encodes the films that changed."""
    src = project.path(src)
    st0 = src.stat()
    key = hashlib.sha1(f"{src.resolve()}|{st0.st_size}|{st0.st_mtime_ns}|{rate}|{arate}|{PART}".encode()).hexdigest()[:16]
    cache = ROOT / "review" / ".film-cache" / key
    if (cache / "meta.json").exists():
        d = out / name
        if d.exists():
            shutil.rmtree(d)
        shutil.copytree(cache / "parts", d)
        shutil.copy2(cache / "poster.jpg", out / f"{name}-poster.jpg")
        print(f"{name}: {src.name} from the film cache")
        return json.loads((cache / "meta.json").read_text(encoding="utf-8"))
    p = _film(src, out, name, rate, arate)
    if cache.exists():
        shutil.rmtree(cache)
    cache.mkdir(parents=True)
    shutil.copytree(out / name, cache / "parts")
    shutil.copy2(out / f"{name}-poster.jpg", cache / "poster.jpg")
    (cache / "meta.json").write_text(json.dumps(p), encoding="utf-8")
    return p


def _film(src, out, name, rate, arate):
    w, h = probe_size(src)
    W, H = (1280, 720) if w >= h else (720, 1280)
    d = out / name
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    full = out / f"_{name}-full.mp4"
    log = str(out / f"_{name}-2pass")
    kb = int(rate[:-1])
    venc = ["-vf", f"scale={W}:{H}:flags=lanczos", "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-b:v", rate,
            "-maxrate", f"{kb * 3 // 2}k", "-bufsize", f"{kb * 3}k", "-bf", "0", "-pix_fmt", "yuv420p",
            "-g", "96", "-keyint_min", "96", "-sc_threshold", "0", "-passlogfile", log]
    null = "NUL" if sys.platform == "win32" else "/dev/null"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), *venc, "-pass", "1", "-an", "-f", "mp4", null], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), *venc, "-pass", "2", "-colorspace", "bt709",
                    "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-c:a", "aac", "-b:a", arate,
                    "-ar", "48000", str(full)], check=True)
    for f in out.glob(f"_{name}-2pass*"):
        f.unlink()
    # no B-frames, so each part's picture starts at zero with its sound; split a hair before each mark
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(full), "-map", "0", "-c", "copy", "-f", "segment", "-segment_time",
                    str(PART - 0.01), "-reset_timestamps", "1", "-segment_format", "mp4", "-segment_format_options",
                    "movflags=+frag_keyframe+empty_moov+default_base_moof", str(d / "part%02d.mp4")], check=True)
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=profile,level", "-of", "json",
                        str(full)], capture_output=True, text=True, check=True)
    st = json.loads(p.stdout)["streams"][0]
    prof = {"High": "64", "Main": "4d", "Constrained Baseline": "42"}[st["profile"]]
    codecs = f"avc1.{prof}00{int(st['level']):02x}, mp4a.40.2"
    dur = project.duration(full)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(min(dur / 2, 60)), "-i", str(full), "-frames:v", "1", "-q:v", "3",
                    str(out / f"{name}-poster.jpg")], check=True)
    full.unlink()
    n = len(list(d.glob("part*.mp4")))
    if max(f.stat().st_size for f in d.iterdir()) >= LIMIT:
        sys.exit(f"a part of {name} is over 15 MB: lower the rate")
    return {"n": n, "len": PART, "dur": round(dur, 3), "codecs": codecs, "tall": H > W}


def media_html(card_id, items, out, M):
    figs, k = [], 0
    for it in items:
        k += 1
        name = f"{card_id}-{k}"
        cap = f'<figcaption><span class="time">{esc(it.get("time", ""))}</span>{it.get("caption", "")}</figcaption>'
        wide = it.get("wide", "clip" in it or "film" in it)
        cls = ' class="wide"' if wide else ""
        if "still" in it:
            still(it["still"], out, name)
            figs.append(f'<figure{cls}><button class="zoom" type="button" data-full="{M}/{name}.jpg"><img src="{M}/{name}.jpg" '
                        f'alt="{esc(it.get("alt", it.get("caption", "")))}" loading="lazy"></button>{cap}</figure>')
        elif "clip" in it:
            _, tall = clip(it["clip"], out, name, it.get("poster", 1.0))
            figs.append(f'<figure{cls}><video{" class=" + chr(34) + "tall" + chr(34) if tall else ""} controls playsinline '
                        f'preload="metadata" poster="{M}/{name}-poster.jpg" src="{M}/{name}.mp4"></video>{cap}</figure>')
        elif "film" in it:
            p = film(it["film"], out, name, it.get("rate", FILM_RATE), FILM_AUDIO)
            figs.append(f'<figure{cls}><div class="film" data-parts="{M}/{name}" data-n="{p["n"]}" data-len="{p["len"]}" '
                        f'data-dur="{p["dur"]}" data-codecs="{p["codecs"]}"><video{" class=" + chr(34) + "tall" + chr(34) if p["tall"] else ""} '
                        f'controls playsinline preload="metadata" poster="{M}/{name}-poster.jpg" aria-label="{esc(it.get("caption", name))}"></video>'
                        f'<p class="state" aria-live="polite"></p></div>{cap}</figure>')
    return "\n        ".join(figs)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    spec = json.loads(project.path(sys.argv[1]).read_text(encoding="utf-8"))
    global FILM_RATE, FILM_AUDIO
    FILM_RATE = spec.get("film_rate", FILM_RATE)
    FILM_AUDIO = spec.get("film_audio", FILM_AUDIO)
    name = spec["name"]
    M = f"media-{name}"
    out = ROOT / "review" / M
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    chips, body = [], []
    for sec in spec.get("sections", []):
        cards = []
        for c in sec["cards"]:
            chips.append(f'<a class="chip" href="#{c["id"]}" data-chip="{c["id"]}"><span class="dot"></span>{esc(c.get("chip", c["title"]))}</a>')
            media = media_html(c["id"], c.get("media", []), out, M)
            aside = f'\n      <p class="aside">{c["aside"]}</p>' if c.get("aside") else ""
            cards.append(f'''    <article class="test" id="{c["id"]}" data-review="{c.get("kind", "test")}" data-title="{esc(c["title"])}">
      <div class="test-head"><h3>{c["title"]}</h3><span class="tag">{esc(c.get("tag", ""))}</span></div>
      <p class="look"><b>Look for</b>{c.get("look", "")}</p>
      <div class="media">
        {media}
      </div>{aside}
    </article>''')
        body.append(f'''  <section class="track">
    <h2 class="track-name">{sec["name"]}</h2>
{chr(10).join(cards)}
  </section>''')
    if spec.get("calls"):
        chips.append('<span class="chip-sep" aria-hidden="true"></span>')
        calls = []
        for c in spec["calls"]:
            chips.append(f'<a class="chip" href="#{c["id"]}" data-chip="{c["id"]}"><span class="dot"></span>{esc(c.get("chip", c["title"]))}</a>')
            calls.append(f'''    <article class="test" id="{c["id"]}" data-review="call" data-title="{esc(c["title"])}">
      <div class="test-head"><h3>{c["title"]}</h3><span class="tag">{esc(c.get("tag", ""))}</span></div>
      <p class="look">{c["text"]}</p>
    </article>''')
        body.append(f'''  <section class="track calls">
    <h2 class="track-name">calls to confirm</h2>
{chr(10).join(calls)}
  </section>''')
    foot = f'\n  <p class="foot">{spec["foot"]}</p>' if spec.get("foot") else ""
    page = (KIT / "page.head.html").read_text(encoding="utf-8").replace("__TITLE__", esc(spec["title"]))
    page += f'''<div class="wrap">
  <header class="top">
    <p class="eyebrow">{spec.get("eyebrow", "")}</p>
    <h1>{spec["title"]}</h1>
    <p class="lede">{spec.get("lede", "")}</p>
    <nav class="status" aria-label="Your marks so far">
      {chr(10).join("      " + c for c in chips).strip()}
    </nav>
    <p class="banner" id="banner" hidden></p>
    <div class="export" id="export" hidden>
      <button class="v ok" type="button" id="export-copy">Copy my marks</button>
      <textarea id="export-text" hidden readonly aria-label="Your marks as JSON"></textarea>
    </div>
  </header>

{chr(10).join(body)}
{foot}
</div>

'''
    tail = (KIT / "page.tail.html").read_text(encoding="utf-8")
    player = (KIT / "film-player.js").read_text(encoding="utf-8")
    page += tail + player
    dst = ROOT / "review" / f"{name}.html"
    dst.write_text(page, encoding="utf-8")  # the form a Claude artifact publish takes (it adds the document skeleton)
    local = ROOT / "review" / f"{name}.local.html"  # the same page as a whole document, to open from disk
    local.write_text('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                     '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>\n'
                     + page + "\n</body></html>\n", encoding="utf-8")
    # publish plan: batches under 64 MB (the page and its files), each file under 15 MB
    files = sorted(p for p in out.rglob("*") if p.is_file())
    batches, cur, size = [], {}, 0
    for f in files:
        s = f.stat().st_size
        if cur and size + s > BATCH:
            batches.append(cur)
            cur, size = {}, 0
        cur[f"{M}/{f.relative_to(out).as_posix()}"] = str(f.relative_to(ROOT).as_posix())
        size += s
    if cur:
        batches.append(cur)
    plan = ROOT / "review" / f"{name}.publish.json"
    plan.write_text(json.dumps({"page": str(dst.relative_to(ROOT).as_posix()), "batches": batches}, indent=1), encoding="utf-8")
    total = sum(f.stat().st_size for f in files)
    print(f"wrote {dst.relative_to(ROOT)}: {len(files)} media files, {total / 1048576:.1f} MB, {len(batches)} publish batch(es) "
          f"in {plan.relative_to(ROOT)}")
    print("open it locally to check it, then publish: the page with the first batch's files (capabilities db and user), "
          "then each later batch to the same page")


if __name__ == "__main__":
    main()
