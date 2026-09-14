#!/usr/bin/env python3
"""Stitch PNG frames into a GIF (Pillow) and, when ffmpeg is available, a WebM
(JPEG bytes piped through image2pipe/mjpeg, which even minimal ffmpeg builds have).

    python3 scripts/stitch.py --manifest frames-manifest.json --gif out.gif [--webm out.webm] [--fps 12]

manifest: {"frames": [{"png": "...", "holdMs": 700}, ...]}
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

from PIL import Image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--gif", required=True)
    parser.add_argument("--webm")
    parser.add_argument("--fps", type=int, default=12)
    parser.add_argument("--bg", default="#070b07")
    args = parser.parse_args()

    manifest = json.load(open(args.manifest))
    frames = manifest["frames"]
    images = [Image.open(f["png"]).convert("RGB") for f in frames]
    width = max(im.width for im in images)
    height = max(im.height for im in images)
    # Even dimensions keep yuv420p encoders happy.
    width += width % 2
    height += height % 2
    bg = tuple(int(args.bg.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))

    padded = []
    for im in images:
        canvas = Image.new("RGB", (width, height), bg)
        canvas.paste(im, (0, 0))
        padded.append(canvas)

    durations = [max(20, int(f.get("holdMs", 1000))) for f in frames]
    os.makedirs(os.path.dirname(os.path.abspath(args.gif)), exist_ok=True)
    quantized = [p.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for p in padded]
    quantized[0].save(
        args.gif,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=False,
        disposal=1,
    )
    print(f"wrote {args.gif} ({len(frames)} frames, {width}x{height})")

    if args.webm:
        ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
        if not ffmpeg:
            print("ffmpeg not found; skipped webm", file=sys.stderr)
            return 0
        import io
        import tempfile
        # A concatenated MJPEG stream on disk: the only image input the minimal
        # Playwright ffmpeg build accepts (no image2, no pipe protocol).
        with tempfile.NamedTemporaryFile(suffix=".mjpeg", delete=False) as stream:
            for frame, hold in zip(padded, durations):
                copies = max(1, round(hold / 1000 * args.fps))
                buf = io.BytesIO()
                frame.save(buf, format="JPEG", quality=95, subsampling=0)
                stream.write(buf.getvalue() * copies)
            stream_path = stream.name
        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(args.fps), "-i", stream_path,
            "-c:v", "libvpx", "-b:v", "2M", "-auto-alt-ref", "0", "-pix_fmt", "yuv420p", args.webm,
        ]
        result = subprocess.run(cmd)
        os.unlink(stream_path)
        if result.returncode != 0:
            print(f"ffmpeg exited {result.returncode}", file=sys.stderr)
            return result.returncode
        print(f"wrote {args.webm}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
