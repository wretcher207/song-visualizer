"""Measure the song: per-frame features for the scenes, a beat grid, rough sections, and the exact moments to cue on.

  python tools/analyze.py                  lib/features.js (window.FEAT, one row per video frame) and, if there isn't
                                           one yet, a starter lib/cues.js with rough section boundaries to pin
  python tools/analyze.py --probe 12.0:low 23.6:high
                                           the exact onset nearest each time in that band (low, mid, high): pin a cue
                                           to the frame its sound starts on
  python tools/analyze.py --scan 124 142   every onset and every dropout per band in that window, in 20 ms steps: where
                                           the hats stop, where the bass comes back. A missing hit is a cue too: if the
                                           hats come every 0.34 s and the next one never comes, that moment is the cue
  python tools/analyze.py --levels 44 131  band levels (dB) in 50 ms steps, 1.5 s either side of each time

Tables in FEAT (each has exactly round(duration * 24) rows; frame i is t = i / 24):
  on_low, on_mid, on_high   band onset envelopes: onset strength, held with a 0.18 s decay (0..1)
  low, mid, high, rms       band energies, normalised to the 5th..95th percentile (0..1)
  centroid                  spectral centroid, normalised the same way (0..1)
  energy                    rms smoothed over 6 s (0..1), for slow section-scale moves
  grow                      cumulative energy, 0 at the start and 1 at the end (a growth clock)
  beat, downbeat            1 on the frame nearest a beat / bar start, else 0
  barpos                    position inside the current bar, 0..1 (0 before the first bar)
  phase                     the energy level: 0 quiet, 1/3 low, 2/3 medium, 1 high
Plus FEAT.beats and FEAT.downbeats (seconds), FEAT.bpm and FEAT.duration.
Bands: low 30 to 150 Hz (kick, bass), mid 200 to 2500 Hz (body, voice, guitars), high 5 to 11 kHz (hats, cymbals).
"""
import argparse, base64, json, pathlib, sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

FPS = project.FPS
SR = 22050
HOP = 256  # ~11.6 ms, fine enough to pin onsets to the frame
BANDS = {"low": (30, 150), "mid": (200, 2500), "high": (5000, 11000)}


def load(c):
    import librosa
    y, sr = librosa.load(str(project.song(c)), sr=SR, mono=True)
    return y, sr


def spectrum(y, sr):
    import librosa
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    ts = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=HOP)
    return S, freqs, ts


def band_mask(freqs, name):
    lo, hi = BANDS[name]
    return (freqs >= lo) & (freqs < hi)


def onset_env(S, freqs, sr, name):
    import librosa
    return librosa.onset.onset_strength(S=librosa.power_to_db(S[band_mask(freqs, name)]), sr=sr, hop_length=HOP)


def probe(c, items):
    y, sr = load(c)
    S, freqs, ts = spectrum(y, sr)
    for item in items:
        t0, bname = item.split(":")
        t0 = float(t0)
        env = onset_env(S, freqs, sr, bname)
        m = (ts[: len(env)] > t0 - 1.0) & (ts[: len(env)] < t0 + 1.0)
        idx = np.where(m)[0]
        # the strongest onset in the +-1 s window, then back up to where its rise starts
        k = idx[np.argmax(env[idx])]
        thr = env[k] * 0.25
        j = k
        while j > 0 and env[j - 1] > thr and ts[k] - ts[j - 1] < 0.06:
            j -= 1
        print(f"{bname:5s} near {t0:8.3f}: peak {ts[k]:8.3f}  rise {ts[j]:8.3f}  frame {round(ts[j] * FPS)}  strength {env[k]:.1f}")


def bands_db(y, sr):
    import scipy.signal as ss
    out = {}
    for name, (lo, hi) in BANDS.items():
        if lo <= 30:
            sos = ss.butter(4, hi / (sr / 2), "low", output="sos")
        else:
            sos = ss.butter(4, [lo / (sr / 2), min(hi / (sr / 2), 0.99)], "band", output="sos")
        out[name] = ss.sosfiltfilt(sos, y)
    return out


def level(x, sr, t, win):
    s = x[max(0, int(t * sr)): int((t + win) * sr)]
    return 10 * np.log10(np.mean(s * s) + 1e-12) if len(s) else -120.0


def scan(c, t0, t1):
    """Onsets (a rise of 12 dB or more in 20 ms) and dropouts (a band falling 15 dB below its recent level and
    staying there 0.4 s or more), per band. Read the hits' spacing: a regular pattern that stops is a cue."""
    y, sr = load(c)
    B = bands_db(y, sr)
    step = 0.02
    for name, x in B.items():
        ts = np.arange(t0, t1, step)
        lv = np.array([level(x, sr, t, step) for t in ts])
        floor = np.percentile(lv, 90) - 45
        ons = []
        for i in range(1, len(lv)):
            if lv[i] - lv[i - 1] > 12 and lv[i] > floor and (not ons or ts[i] - ons[-1] > 0.05):
                ons.append(round(float(ts[i]), 2))
        gaps = []
        if len(ons) > 2:
            d = np.diff(ons)
            gaps = [(ons[i], ons[i + 1]) for i in range(len(d)) if d[i] > 2.5 * np.median(d)]
        print(f"{name:5s} onsets: {ons}")
        if gaps:
            print(f"      gaps longer than 2.5x the usual spacing ({np.median(np.diff(ons)):.2f} s): "
                  + ", ".join(f"{a:.2f} to {b:.2f}" for a, b in gaps))
        # dropouts on a coarser grid
        big = np.arange(t0, t1, 0.25)
        lb = np.array([level(x, sr, t, 0.25) for t in big])
        ref = np.maximum.accumulate(np.concatenate([[lb[0]], lb[:-1]]))
        quiet = lb < ref - 15
        i = 0
        while i < len(big):
            if quiet[i]:
                j = i
                while j < len(big) and quiet[j]:
                    j += 1
                if (j - i) * 0.25 >= 0.4:
                    print(f"      dropout from {big[i]:.2f} to {big[j - 1] + 0.25:.2f} ({lb[i]:.0f} dB, was {ref[i]:.0f})")
                i = j
            else:
                i += 1


def levels(c, times):
    y, sr = load(c)
    B = bands_db(y, sr)
    for tc in times:
        print(f"--- around {tc}")
        for t in np.arange(tc - 1.5, tc + 1.5, 0.05):
            print(f"{t:7.2f}  " + "  ".join(f"{k} {level(v, sr, t, 0.05):6.1f}" for k, v in B.items()))


def analyze(c):
    import librosa
    y, sr = load(c)
    dur = len(y) / sr
    n = int(round(dur * FPS))
    S, freqs, ts = spectrum(y, sr)
    edges = (np.arange(n + 1) - 0.5) / FPS  # frame i covers [i/24 - 1/48, i/24 + 1/48)
    bin_of = np.searchsorted(edges, ts) - 1

    def per_frame(x, how):
        x = x[: len(ts)]
        out = np.zeros(n)
        b = bin_of[: len(x)]
        ok = (b >= 0) & (b < n)
        if how == "max":
            np.maximum.at(out, b[ok], x[ok])
            return out
        s = np.zeros(n)
        cnt = np.zeros(n)
        np.add.at(s, b[ok], x[ok])
        np.add.at(cnt, b[ok], 1)
        out = np.where(cnt > 0, s / np.maximum(cnt, 1), np.nan)
        good = ~np.isnan(out)
        return np.interp(np.arange(n), np.where(good)[0], out[good])

    def norm_pct(x, lo=5, hi=95):
        a0, a1 = np.percentile(x, lo), np.percentile(x, hi)
        return np.clip((x - a0) / (a1 - a0 + 1e-12), 0, 1)

    def hold(x, tau):
        out = np.zeros_like(x)
        k = np.exp(-1.0 / (tau * FPS))
        v = 0.0
        for i, xi in enumerate(x):
            v = max(xi, v * k)
            out[i] = v
        return out

    tab = {}
    for b in BANDS:
        on = per_frame(onset_env(S, freqs, sr, b), "max")
        on = np.clip(on / (np.percentile(on, 99) + 1e-9), 0, 1)
        tab["on_" + b] = hold(on, 0.18)
        tab[b] = norm_pct(per_frame(np.sqrt(S[band_mask(freqs, b)].sum(0)), "mean"))
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    rmsf = per_frame(rms, "mean")
    tab["rms"] = norm_pct(rmsf)
    cen = librosa.feature.spectral_centroid(S=np.sqrt(S), sr=sr)[0]
    tab["centroid"] = norm_pct(per_frame(cen, "mean"))
    k = int(6 * FPS)
    w = np.hanning(k)
    w /= w.sum()
    tab["energy"] = norm_pct(np.convolve(rmsf, w, mode="same"), 2, 98)
    cum = np.cumsum(rmsf)
    tab["grow"] = cum / cum[-1]

    # beat grid: librosa's tracker on the whole mix; bars of four, phased to where the low end hits hardest
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, bframes = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=HOP, units="frames")
    beats = librosa.frames_to_time(bframes, sr=sr, hop_length=HOP)
    lowo = onset_env(S, freqs, sr, "low")
    strength = [np.mean([lowo[min(len(lowo) - 1, f)] for f in bframes[p::4]]) if len(bframes[p::4]) else 0 for p in range(4)]
    downs = beats[int(np.argmax(strength))::4]
    bpm = float(np.atleast_1d(tempo)[0])
    beat = np.zeros(n)
    down = np.zeros(n)
    for bt in beats:
        i = int(round(bt * FPS))
        if 0 <= i < n:
            beat[i] = 1
    for d in downs:
        i = int(round(d * FPS))
        if 0 <= i < n:
            down[i] = 1
    barpos = np.zeros(n)
    tf = np.arange(n) / FPS
    bar = 240.0 / bpm if bpm > 0 else 2.0
    for j in range(len(downs)):
        d0 = downs[j]
        d1 = downs[j + 1] if j + 1 < len(downs) else d0 + bar
        m = (tf >= d0) & (tf < d1)
        barpos[m] = (tf[m] - d0) / (d1 - d0)
    tab["beat"], tab["downbeat"], tab["barpos"] = beat, down, barpos
    # energy level in four steps, from the smoothed loudness
    e = tab["energy"]
    tab["phase"] = np.digitize(e, [0.15, 0.45, 0.75]) / 3

    for k2, v in tab.items():
        assert len(v) == n, (k2, len(v), n)
    enc = {k2: base64.b64encode(np.round(np.clip(v, 0, 1) * 255).astype(np.uint8).tobytes()).decode() for k2, v in tab.items()}
    meta = {"slug": c["slug"], "fps": FPS, "n": n, "duration": round(dur, 4), "bpm": round(bpm, 2),
            "beats": [round(float(x), 3) for x in beats], "downbeats": [round(float(x), 3) for x in downs]}
    js = "\n".join([
        "// generated by tools/analyze.py; do not edit. One row per frame at 24 fps (frame i is t = i / 24).",
        "window.FEAT = (function () {",
        f"  const F = {json.dumps(meta, separators=(',', ':'))};",
        f"  const T = {json.dumps(enc, separators=(',', ':'))};",
        "  for (const k in T) {",
        "    const s = atob(T[k]);",
        "    const a = new Float32Array(s.length);",
        "    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) / 255;",
        "    F[k] = a;",
        "  }",
        "  return F;",
        "})();",
        "",
    ])
    out = project.ROOT / "lib" / "features.js"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(js, encoding="utf-8")
    print(f"{c['slug']}: {dur:.3f} s, {n} frames, {meta['bpm']} BPM, {len(beats)} beats, {len(downs)} bars -> lib/features.js "
          f"({out.stat().st_size // 1024} KB)")
    for s0 in range(0, int(dur), 10):
        i0, i1 = s0 * FPS, min(n, (s0 + 10) * FPS)
        print(f"{s0:4d}s  energy {tab['energy'][i0]:.2f}  low {tab['low'][i0:i1].mean():.2f}  mid {tab['mid'][i0:i1].mean():.2f}"
              f"  high {tab['high'][i0:i1].mean():.2f}  on_low {tab['on_low'][i0:i1].mean():.2f}"
              f"  on_high {tab['on_high'][i0:i1].mean():.2f}")
    cues = project.ROOT / "lib" / "cues.js"
    if not cues.exists():
        starter_cues(y, sr, dur, downs, cues)


def boundaries(y, sr, dur):
    """Where an instrument comes in or drops out: per band, the level over the 4 s after each moment against the 4 s
    before it. The biggest steps are the section changes a picture should move on (the bass entering, the hats
    stopping). Each is then pinned within a second to where that band's level crosses halfway between before and after.
    Returns [(time, band, step dB)], strongest first."""
    B = bands_db(y, sr)
    step, span = 0.25, 16  # 0.25 s grid, 4 s either side
    grid = np.arange(0, dur, step)
    L = {k: np.array([level(x, sr, t, step) for t in grid]) for k, x in B.items()}
    nov = np.zeros(len(grid))
    which = [""] * len(grid)
    delta = np.zeros(len(grid))
    for i in range(span, len(grid) - span):
        best = 0
        for k, lv in L.items():
            d = np.median(lv[i:i + span]) - np.median(lv[i - span:i])
            if abs(d) > abs(best):
                best, which[i] = d, k
        nov[i], delta[i] = abs(best), best
    picks = []
    for i in np.argsort(-nov):
        if nov[i] < 9:  # under 9 dB isn't a section change
            break
        if all(abs(grid[i] - grid[j]) > 8 for j in picks):
            picks.append(i)
    out = []
    for i in picks:
        x = B[which[i]]
        fine = np.arange(max(0, grid[i] - 2.0), min(dur, grid[i] + 2.0), 0.02)
        lv = np.array([level(x, sr, t, 0.1) for t in fine])  # short windows: where each hit is
        lv1 = np.array([level(x, sr, t, 1.0) for t in fine])  # the next second's power: hats and kicks average in
        before, after = np.median(L[which[i]][i - span:i]), np.median(L[which[i]][i:i + span])
        mid = (before + after) / 2
        t = grid[i]
        if delta[i] > 0:
            # a rise: the first moment the next second stays up (a stray hit before it doesn't count), backed up to
            # the hit that starts it
            j = next((j for j in range(len(lv1)) if lv1[j] > mid), None)
            if j is not None:
                k = next((k for k in range(j, min(len(lv), j + 50)) if lv[k] > mid), j)
                t = fine[k]
        else:
            # a drop: the last second that was still up, moved past its last hit
            j = next((j for j in range(len(lv1) - 1, -1, -1) if lv1[j] > mid), None)
            if j is not None:
                k = next((k for k in range(min(len(lv) - 1, j + 50), j - 1, -1) if lv[k] > mid), j)
                t = fine[k] + 0.1
        out.append((round(float(t), 2), which[i], round(float(delta[i]), 1)))
    return out


def starter_cues(y, sr, dur, downs, out):
    """Rough section boundaries: where a band (low, mid, high) steps up or down by 9 dB or more. Marked "section" until
    each is checked with --scan: a drop pinned this way can sit on the last hit before a gap rather than the missing
    one after it."""
    found = sorted(boundaries(y, sr, dur))
    snapped = []
    for t, band, d in found:
        if not snapped or t - snapped[-1][0] > 4:
            snapped.append((t, band, d))
    print("section changes: " + ", ".join(f"{t:.2f} ({band} {'+' if d > 0 else ''}{d:.0f} dB)" for t, band, d in snapped))
    names = {("low", True): "lowIn", ("low", False): "lowOut", ("mid", True): "midIn", ("mid", False): "midOut",
             ("high", True): "highIn", ("high", False): "highOut"}
    keys = []
    count = {}
    for t, band, d in snapped:
        base = names[(band, d > 0)]
        count[base] = count.get(base, 0) + 1
        keys.append(base + (str(count[base]) if count[base] > 1 else ""))
    lines = ["// Named cues (seconds). Scenes read these names, never magic numbers.",
             "// \"section\": a rough boundary from tools/analyze.py (where a band steps up or down). Rename each to what",
             "// happens there (bassIn, hatsOut, swell...), check it with tools/analyze.py --scan and mark checked ones \"onset\".",
             "window.CUE = (function () {",
             f"  const FPS = {FPS};",
             "  const C = {"]
    for k, (t, band, d) in zip(keys, snapped):
        lines.append(f"    {k}: {t}, // section: {band} {'+' if d > 0 else ''}{d:.0f} dB")
    lines.append(f"    end: {round(dur, 3)},")
    lines += ["  };",
              "  C.sections = [[0, \"start\"]" + "".join(f", [C.{k}, \"{k}\"]" for k in keys) + "];",
              "  C.section = function (t) {",
              "    let s = C.sections[0][1];",
              "    for (const [t0, name] of C.sections) if (t >= t0) s = name;",
              "    return s;",
              "  };",
              "  C.frame = (name) => Math.round(C[name] * FPS);",
              "  return C;",
              "})();",
              ""]
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"starter lib/cues.js: {len(snapped)} sections: " + ", ".join(f"{k} {t:.2f}" for k, (t, _, _) in zip(keys, snapped)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", nargs="*", help="time:band pairs; print the exact onset nearest each")
    ap.add_argument("--scan", nargs=2, type=float, metavar=("T0", "T1"))
    ap.add_argument("--levels", nargs="*", type=float)
    a = ap.parse_args()
    c = project.load()
    if a.probe is not None:
        probe(c, a.probe)
    elif a.scan:
        scan(c, *a.scan)
    elif a.levels:
        levels(c, a.levels)
    else:
        analyze(c)


if __name__ == "__main__":
    main()
