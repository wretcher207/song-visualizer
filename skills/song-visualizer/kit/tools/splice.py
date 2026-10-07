"""Replace stretches of a finished master with freshly rendered frames, when its PNG frames are gone.

  python tools/splice.py [--vertical] --seg START_FRAME:END_FRAME:FRAMES_DIR [--seg ...] [--out OUT.mp4]

  The master is final/<slug>[-vertical].mp4.
  --seg       a stretch to replace: video frames START to END (END exclusive; "end" for the rest of the film), and the
              PNG frames for exactly that stretch (from tools/render.py window START/24 LEN --name NAME:
              renders/NAME-frames; a relative path is taken from the project). START and END must be keyframes of
              the master: every stretch that is kept is stream-copied, so its frames are the master's own, bit for bit.
              List the keyframes: ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 MASTER
              (rows with K; frame = round(pts_time * 24)).
  --out       default: final/<slug>[-vertical].spliced.mp4 (the master is never overwritten here)

What it does, and what it checks:
  1. lists the master's keyframes from its packets and refuses a cut that isn't on one
  2. kept stretches: stream-copied (ffmpeg -ss at the keyframe's exact time, -frames:v, -c copy)
  3. new stretches: encoded with tools/encode.py --no-audio, so the x264 settings match the master's
  4. joined with the concat demuxer; the audio is the master's own stream, copied
  5. checks: the whole file decodes with no decoder message; per-frame MD5s (ffmpeg framemd5, the decoded YUV) of every
     kept stretch equal the master's at the same frame numbers; the frame count is the master's plus any frames the
     master lost at its end (the master's encode dropped its last frame to -shortest; a tail encoded without audio
     keeps it)
Why: once a render's PNG frames are cleared, a late fix to a few seconds would otherwise mean rendering the whole film
again (one to four hours an aspect); render.py patch needs the frames. Written 2026-10-07 for the hometown films
(workspace/home): an end card fixed in four films' tails and a 9:16 hand fixed mid-film, every kept stretch
byte-identical to the master. Render each new stretch with render.py window from the keyframe's exact time (frame / 24).
"""
import argparse, json, pathlib, shutil, subprocess, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
FPS = project.FPS


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def packets(v):
    """(frame index, is keyframe) for every video packet, in presentation order."""
    p = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "json", str(v)])
    pk = json.loads(p.stdout)["packets"]
    out = sorted((round(float(x["pts_time"]) * FPS), "K" in x["flags"]) for x in pk)
    return out


def framemd5(v):
    p = run(["ffmpeg", "-v", "error", "-i", str(v), "-map", "0:v", "-f", "framemd5", "-"])
    return [ln.rsplit(",", 1)[1].strip() for ln in p.stdout.splitlines() if ln and not ln.startswith("#")]


def new_vs_pngs(v, st, stop, pngs, w=480):
    """Mean absolute difference (0..255) between the decoded frames st..stop-1 of v and the PNGs, at offsets 0, -1, +1,
    on frames scaled to w wide; and the worst single frame at offset 0. Decoded with the encode's own matrix (bt709,
    limited range) so the comparison sees only the codec."""
    import numpy as np
    from PIL import Image
    first = Image.open(pngs[0])
    h = round(first.height * w / first.width)
    n = stop - st
    p = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{st / FPS:.6f}", "-i", str(v), "-frames:v", str(n), "-vf",
                        f"scale=in_range=tv:out_range=full:in_color_matrix=bt709:w={w}:h={h}:flags=area,format=rgb24",
                        "-f", "rawvideo", "-"], capture_output=True)
    raw = np.frombuffer(p.stdout, np.uint8)
    if raw.size != n * w * h * 3:
        return None
    dec = raw.reshape(n, h, w, 3).astype(np.int16)
    ref = np.stack([np.asarray(Image.open(q).convert("RGB").resize((w, h), Image.BOX), np.int16) for q in pngs[:n]])
    per = np.abs(dec - ref).mean(axis=(1, 2, 3))
    early = np.abs(dec[1:] - ref[:-1]).mean() if n > 1 else 1e9
    late = np.abs(dec[:-1] - ref[1:]).mean() if n > 1 else 1e9
    return float(per.mean()), float(early), float(late), float(per.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--seg", action="append", required=True)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    proj = ROOT
    slug = json.loads((proj / "visualizer.json").read_text(encoding="utf-8"))["slug"]
    tag = "-vertical" if a.vertical else ""
    master = proj / "final" / f"{slug}{tag}.mp4"
    out = pathlib.Path(a.out) if a.out else proj / "final" / f"{slug}{tag}.spliced.mp4"

    pk = packets(master)
    n = len(pk)
    keys = {f for f, k in pk if k}
    if [f for f, _ in pk] != list(range(n)):
        sys.exit(f"{master.name}: packet frame numbers are not 0..{n - 1}")
    segs = []
    for s in a.seg:
        st, en, d = s.split(":", 2)
        st = int(st)
        en = None if en == "end" else int(en)
        d = pathlib.Path(d)
        if not d.is_absolute():
            d = proj / d
        pngs = sorted(d.glob("*.png"))
        if st not in keys:
            sys.exit(f"frame {st} is not a keyframe of {master.name}; keyframes near it: "
                     + ", ".join(str(k) for k in sorted(keys) if abs(k - st) < 400))
        if en is not None and en not in keys:
            sys.exit(f"frame {en} is not a keyframe of {master.name}")
        want = (en - st) if en is not None else None
        if want is not None and len(pngs) < want:
            sys.exit(f"{d} has {len(pngs)} frames, the stretch {st} to {en} needs {want}")
        if want is None and len(pngs) < n - st:
            sys.exit(f"{d} has {len(pngs)} frames, the stretch {st} to the end needs at least {n - st}")
        segs.append((st, en, d, pngs))
    segs.sort()

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="splice-"))
    parts, kept = [], []
    pos = 0
    tools = proj / "tools"
    try:
        for st, en, d, pngs in segs:
            if st > pos:
                k = tmp / f"keep-{pos:06d}.mp4"
                run(["ffmpeg", "-v", "error", "-y", "-ss", f"{pos / FPS:.6f}", "-i", str(master), "-map", "0:v", "-c:v", "copy",
                     "-frames:v", str(st - pos), "-an", str(k)])
                parts.append(k)
                kept.append((pos, st, k))
            # the new stretch: exactly its frames (a tail takes every frame rendered)
            use = pngs if en is None else pngs[: en - st]
            fd = tmp / f"frames-{st:06d}"
            fd.mkdir()
            for i, p in enumerate(use):
                dst = fd / f"frame_{i + 1:06d}.png"
                try:
                    dst.hardlink_to(p)
                except OSError:
                    shutil.copy2(p, dst)
            e = tmp / f"new-{st:06d}.mp4"
            run([sys.executable, str(tools / "encode.py"), str(fd), str(e), "--no-audio"], cwd=proj)
            parts.append(e)
            pos = en if en is not None else None
            if pos is None:
                break
        if pos is not None and pos < n:
            k = tmp / f"keep-{pos:06d}.mp4"
            run(["ffmpeg", "-v", "error", "-y", "-ss", f"{pos / FPS:.6f}", "-i", str(master), "-map", "0:v", "-c:v", "copy", "-an", str(k)])
            parts.append(k)
            kept.append((pos, n, k))

        lst = tmp / "list.txt"
        lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
        run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(master),
             "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", str(out)])

        # checks
        dec = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "null", "-"], capture_output=True, text=True)
        if dec.returncode != 0 or dec.stderr.strip():
            sys.exit(f"decoder complained about {out.name}:\n{dec.stderr[:2000]}")
        m_old = framemd5(master)
        m_new = framemd5(out)
        bad = []
        pk2 = packets(out)
        if [f for f, _ in pk2] != list(range(len(pk2))):
            bad.append("the joined file's frame numbers are not consecutive (a gap or a repeat at a join)")
        expect = sum(b0 - a0 for a0, b0, _ in kept) + sum(((en - st) if en is not None else len(pngs)) for st, en, _, pngs in segs)
        if len(m_new) != expect:
            bad.append(f"{len(m_new)} frames decoded, expected {expect}")
        # each new stretch against its PNGs: small differences (the encode), and smallest at offset 0, not one frame
        # early or late
        for st, en, d, pngs in segs:
            stop = en if en is not None else len(m_new)
            mae = new_vs_pngs(out, st, stop, pngs)
            if mae is None:
                bad.append(f"new stretch {st}: could not compare with its PNGs")
                continue
            m0, mm, mp, worst = mae
            print(f"  new stretch {st} to {stop - 1} against its PNGs: mean abs difference {m0:.2f} levels at offset 0 "
                  f"(worst frame {worst:.2f}); {mm:.2f} one frame early, {mp:.2f} one frame late")
            if not (m0 < 3.0 and worst < 6.0):
                bad.append(f"new stretch {st}: differs from its PNGs by {m0:.2f} levels on average, {worst:.2f} at worst")
            if not (m0 <= mm and m0 <= mp):
                bad.append(f"new stretch {st}: matches its PNGs better one frame off (alignment)")
        for a0, b0, k in kept:
            n_k = len(framemd5(k))
            if n_k != b0 - a0:
                bad.append(f"kept stretch {a0}-{b0}: {n_k} frames, expected {b0 - a0}")
            if m_new[a0:b0] != m_old[a0:b0]:
                diff = [i for i in range(a0, b0) if i >= len(m_new) or m_new[i] != m_old[i]]
                bad.append(f"kept stretch {a0}-{b0}: {len(diff)} frames differ from the master (first {diff[:5]})")
        print(f"{master.name}: {len(m_old)} frames; {out.name}: {len(m_new)} frames")
        for a0, b0, _ in kept:
            print(f"  frames {a0} to {b0 - 1}: stream-copied, identical to the master (framemd5)")
        for st, en, d, pngs in segs:
            print(f"  frames {st} to {(en if en is not None else len(m_new)) - 1}: new, from {d.name}")
        if bad:
            sys.exit("FAILED:\n  " + "\n  ".join(bad))
        print(f"wrote {out}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
