#!/usr/bin/env python3
"""Draws the BOUNCER mascot: a pixel gorilla in a black tee and wraparound
shades, arms crossed, earpiece in, from a pixel map in this file.
Deterministic and dependency-light (Pillow), so anyone can re-render the
exact same gorilla.

    python3 scripts/draw-mascot.py --out assets --ts src/bouncer/mascot.ts

Writes bouncer-gorilla.png (1024, black door), bouncer-gorilla-transparent.png,
bouncer-gorilla-128.png, bouncer-gorilla.svg and the TypeScript rect list.
"""
import argparse
import os

from PIL import Image

# Legend: . transparent  F fur  M muzzle/skin  S shades  K black tee  B brass earpiece  R red (rope tie)  W highlight
GORILLA = [
    "................................",
    "...........FFFFFFFFFF...........",
    ".........FFFFFFFFFFFFFF.........",
    "........FFFFFFFFFFFFFFFF........",
    ".......FFFFFFFFFFFFFFFFFF.......",
    "......FFFFFMMMMMMMMMMFFFFF......",
    "......FFFFMMMMMMMMMMMMFFFF......",
    ".....FFFFSSSSSSSSSSSSSSFFFF.....",
    ".....FFFFSSSSSSSSSSSSSSFFFFB....",
    ".....FFFFMSSSSSSSSSSSSMFFFFB....",
    ".....FFFFMMMMMMMMMMMMMMFFFF.B...",
    ".....FFFFMMMMNNMMNNMMMMFFFF.B...",
    "......FFFMMMMMMMMMMMMMMFFF..B...",
    "......FFFFMMMMMMMMMMMMFFFF......",
    ".......FFFFMMMMMMMMMMFFFF.......",
    "........FFFFFFFFFFFFFFFF........",
    "....FFFFFFFFFFFFFFFFFFFFFFFF....",
    "..FFFFFFFFFKKKKKKKKKKKKFFFFFFFF.",
    ".FFFFFFFFFFKKKKKKKKKKKKFFFFFFFFF",
    ".FFFFFFFFFFKKKKKRRKKKKKFFFFFFFFF",
    ".FFFFF.FFFFFFFFFFFFFFFFFFF.FFFFF",
    ".FFFFF.FFFFFFFFFFFFFFFFFFF.FFFFF",
    ".FFFFF.FFMMMMFFFFFFFFMMMMF.FFFFF",
    ".FFFFF.FFMMMMMFFFFFFMMMMMF.FFFFF",
    ".FFFFF.FFFFFFFFFFFFFFFFFFF.FFFFF",
    ".FFFFF..FFFFFFFFFFFFFFFFF..FFFFF",
    ".FFFFF....KKKKKKKKKKKK.....FFFFF",
    ".MMMMM....KKKKKKKKKKKK.....MMMMM",
    ".MMMMM....KKKKKKKKKKKK.....MMMMM",
    "...........FFFFF.FFFFF..........",
    "...........FFFFF.FFFFF..........",
    "..........KKKKKK.KKKKKK.........",
]

PALETTE = {
    "F": (62, 62, 76),      # fur
    "M": (117, 117, 132),   # muzzle, palms
    "N": (28, 28, 34),      # nostrils
    "S": (10, 10, 14),      # wraparound shades
    "K": (17, 17, 23),      # black tee, shoes
    "B": (212, 160, 23),    # brass earpiece and wire
    "R": (200, 16, 46),     # red rope pin on the tee
    "W": (242, 239, 230),   # highlight
}
DOOR = (11, 11, 15)


def check_map() -> None:
    size = len(GORILLA)
    for row in GORILLA:
        assert len(row) == size, f"row {row!r} is {len(row)} wide, expected {size}"
        assert all(ch == "." or ch in PALETTE for ch in row), f"unknown pixel in {row!r}"


def render(scale: int, background):
    size = len(GORILLA)
    mode = "RGBA" if background is None else "RGB"
    img = Image.new(mode, (size * scale, size * scale), (0, 0, 0, 0) if background is None else background)
    px = img.load()
    for y, row in enumerate(GORILLA):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            value = PALETTE[ch] + ((255,) if mode == "RGBA" else ())
            for dy in range(scale):
                for dx in range(scale):
                    px[x * scale + dx, y * scale + dy] = value
    return img


def rects() -> str:
    out = []
    for y, row in enumerate(GORILLA):
        x = 0
        while x < len(row):
            ch = row[x]
            if ch == ".":
                x += 1
                continue
            run = 1
            while x + run < len(row) and row[x + run] == ch:
                run += 1
            r, g, b = PALETTE[ch]
            out.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="#{r:02x}{g:02x}{b:02x}"/>')
            x += run
    return "".join(out)


def svg() -> str:
    size = len(GORILLA)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" shape-rendering="crispEdges">\n{rects()}\n</svg>\n'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="assets")
    parser.add_argument("--ts", default=None, help="write the rect list as a TypeScript module")
    args = parser.parse_args()
    check_map()
    os.makedirs(args.out, exist_ok=True)
    render(32, DOOR).save(os.path.join(args.out, "bouncer-gorilla.png"))
    render(32, None).save(os.path.join(args.out, "bouncer-gorilla-transparent.png"))
    render(4, DOOR).save(os.path.join(args.out, "bouncer-gorilla-128.png"))
    with open(os.path.join(args.out, "bouncer-gorilla.svg"), "w") as handle:
        handle.write(svg())
    if args.ts:
        with open(args.ts, "w") as handle:
            handle.write("/** The gorilla as SVG rects on a 32-unit grid. Generated from scripts/draw-mascot.py; do not edit by hand. */\n")
            handle.write(f"export const MASCOT_SVG_INNER = `{rects()}`;\n")
    print(f"wrote gorilla to {args.out}/")


if __name__ == "__main__":
    main()
