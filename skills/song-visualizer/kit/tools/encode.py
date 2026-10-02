"""Encode a HyperFrames PNG-sequence render into the deliverable MP4, with the song's WAV.

  python tools/encode.py FRAMES_DIR OUT.mp4 [--wav PATH] [--start SEC] [--crf 14]
  (--wav defaults to the song in visualizer.json; --no-audio for a silent file)

Why not HyperFrames' own MP4 output: in 0.8.77 its MP4 path captures each frame as a quality-80 JPEG, which
(1) darkens every level by 3 to 4 (a flat ramp 4, 11, 50, 128, 255 came back 1, 8, 46, 124, 253; measured
2026-09-30) and (2) smears fine flakes and grain before H.264 sees them. PNG-sequence capture is exact, so
render with `--format png-sequence` and encode here: H.264 high, yuv420p, bt709 limited range with the
conversion done explicitly, AAC 320k from the WAV (--start trims the audio for a preview window).
"""
import argparse, pathlib, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("frames")
ap.add_argument("out")
ap.add_argument("--wav", default=None)
ap.add_argument("--start", type=float, default=0.0)
ap.add_argument("--crf", type=int, default=14)
ap.add_argument("--fps", type=int, default=24)
ap.add_argument("--no-audio", action="store_true")
a = ap.parse_args()
if not a.wav and not a.no_audio:
    a.wav = str(project.song())
frames = pathlib.Path(a.frames)
pngs = sorted(frames.glob("*.png"))
if not pngs:
    sys.exit(f"no PNGs in {frames}")
first = pngs[0].stem
prefix = first.rstrip("0123456789")
digits = len(first) - len(prefix)
start_num = int(first[len(prefix):])
cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(a.fps), "-start_number", str(start_num),
       "-i", str(frames / f"{prefix}%0{digits}d.png")]
if a.wav:
    cmd += ["-ss", f"{a.start:.4f}", "-t", f"{len(pngs) / a.fps:.4f}", "-i", a.wav]
cmd += ["-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
        "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", str(a.crf),
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-movflags", "+faststart"]
if a.wav:
    cmd += ["-c:a", "aac", "-b:a", "320k", "-shortest"]
cmd += [a.out]
subprocess.run(cmd, check=True)
print(f"{a.out}: {len(pngs)} frames at {a.fps} fps" + (f" + {a.wav} from {a.start:.3f} s" if a.wav else ""))
