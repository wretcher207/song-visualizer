"""The smaller copies people actually upload, from the master in final/.

  python tools/deliver.py [--vertical] [--phone-mb 29] [--share-mbps 9]
      final/<slug>[-vertical]-share.mp4   full size, two-pass at a fixed rate (default 9 Mbps): fine grain and snow cost
                                          a lot of bits, so a quality-based encode can come out bigger than the master
      final/<slug>[-vertical]-phone.mp4   720p (720x1280 for the vertical), two-pass sized to come in under the limit
                                          (default 29 MB, under the common 30 MB phone upload cap)
Look at a few frames of the phone copy at full pixel size afterwards (grain and snow are where blocking shows first).
"""
import argparse, pathlib, subprocess, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

COLOUR = ["-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]


def two_pass(src, dst, kbps, scale=None, audio_k=192):
    log = str(pathlib.Path(tempfile.mkdtemp()) / "pass")
    v = (["-vf", f"scale={scale}:flags=lanczos"] if scale else []) + ["-c:v", "libx264", "-profile:v", "high", "-preset", "slow",
                                                                       "-b:v", f"{kbps}k", *COLOUR, "-passlogfile", log]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), *v, "-pass", "1", "-an", "-f", "mp4", "NUL" if sys.platform == "win32" else "/dev/null"], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), *v, "-pass", "2", "-c:a", "aac", "-b:a", f"{audio_k}k",
                    "-movflags", "+faststart", str(dst)], check=True)
    print(f"{dst.name}: {dst.stat().st_size / 1048576:.1f} MB at {kbps} kbps")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--phone-mb", type=float, default=29.0)
    ap.add_argument("--share-mbps", type=float, default=9.0)
    a = ap.parse_args()
    c = project.load()
    tag = "-vertical" if a.vertical else ""
    master = project.ROOT / "final" / f"{c['slug']}{tag}.mp4"
    if not master.exists():
        sys.exit(f"no master at {master}: python tools/render.py full{' --vertical' if a.vertical else ''} first")
    dur = project.duration(master)
    two_pass(master, master.with_name(f"{c['slug']}{tag}-share.mp4"), int(a.share_mbps * 1000), audio_k=256)
    audio_k = 128
    kbps = int(0.97 * (a.phone_mb * 1048576 * 8 / dur / 1000) - audio_k)
    if kbps < 400:
        print(f"warning: {dur:.0f} s at {a.phone_mb} MB leaves only {kbps} kbps for the picture; expect blocking")
    two_pass(master, master.with_name(f"{c['slug']}{tag}-phone.mp4"), kbps, "720:1280" if a.vertical else "1280:720", audio_k)


if __name__ == "__main__":
    main()
