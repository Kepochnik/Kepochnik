#!/usr/bin/env python3
"""Draws the DIPLOMA mascot: a 1-bit pixel tortoise in a mortarboard holding
a rolled diploma, from a pixel map in this file. Deterministic and
dependency-light (Pillow), so anyone can re-render the exact same tortoise.

    python3 scripts/draw-mascot.py --out assets

Writes diploma-tortoise.png (1024, cream paper), diploma-tortoise-transparent.png,
diploma-tortoise-128.png and diploma-tortoise.svg.
"""
import argparse
import os

from PIL import Image

# Legend: . transparent  N navy ink  G gold  K black cap  W cream  P paper roll  R red ribbon
TORTOISE = [
    "................................",
    "................................",
    "..........KKKKKKKKKKKK..........",
    ".......KKKKKKKKKKKKKKKKKK.......",
    "..........KKKKKKKKKKKKKKG.......",
    "..........KKKKKKKKKKKKKKG.......",
    "...........KKKKKKKKKKKK.G.......",
    "............NNNNNNNNNN..G.......",
    "...........NNNNNNNNNNNN.G.......",
    "..........NNNWWNNNNWWNNN........",
    "..........NNNWWNNNNWWNNN........",
    "..........NNNNNNNNNNNNNN........",
    "...........NNNNNNNNNNNN.........",
    "............NNNNNNNNNN..........",
    "..............NNNNNN............",
    "..........NNNNNNNNNNNNNN........",
    ".......NNNNNNNNNNNNNNNNNNNN.....",
    ".....NNNNNNGGNNNNGGNNNNGGNNNN...",
    "....NNNNNGGGGNNGGGGGNNGGGGNNNN..",
    "...NNNNNNGGGGNNGGGGGNNGGGGNNNNN.",
    "...NNNNNNNGGNNNNGGGNNNNGGNNNNNN.",
    "...NNNNNNNNNNNNNNNNNNNNNNNNNNNN.",
    "....NNNNNNNNNNNNNNNNNNNNNNNNNN..",
    ".....NNNNNNNNNNNNNNNNNNNNNNNN...",
    "......NNNNNNNNNNNNNNNNNNNNNN....",
    ".......NNNN..NNNNNNNN..NNNN.....",
    ".......NNNN..NNNNNNNN..NNNN.....",
    "........NN....NNNNNN....NN......",
    "................................",
    ".........PPPPPPRRPPPPPP.........",
    ".........PPPPPPRRPPPPPP.........",
    "................................",
]

PALETTE = {
    "N": (27, 42, 107),    # navy ink
    "G": (201, 150, 43),   # gold shell scutes / tassel
    "K": (20, 18, 24),     # black mortarboard
    "W": (243, 238, 220),  # cream eyes
    "P": (243, 238, 220),  # paper roll (drawn with an ink outline below)
    "R": (214, 96, 120),   # ribbon
}
PAPER = (243, 238, 220)
PAPER_OUTLINE = (27, 42, 107)


def render(scale: int, background):
    size = len(TORTOISE[0])
    mode = "RGBA" if background is None else "RGB"
    img = Image.new(mode, (size * scale, size * scale), (0, 0, 0, 0) if background is None else background)
    px = img.load()
    for y, row in enumerate(TORTOISE):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            color = PALETTE[ch]
            # The rolled diploma is paper-coloured, so give it an ink outline one pixel around.
            if ch == "P":
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < size and 0 <= nx < size and TORTOISE[ny][nx] == ".":
                            for sy in range(scale):
                                for sx in range(scale):
                                    px[nx * scale + sx, ny * scale + sy] = PAPER_OUTLINE + ((255,) if mode == "RGBA" else ())
    for y, row in enumerate(TORTOISE):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            value = PALETTE[ch] + ((255,) if mode == "RGBA" else ())
            for dy in range(scale):
                for dx in range(scale):
                    px[x * scale + dx, y * scale + dy] = value
    return img


def svg() -> str:
    size = len(TORTOISE[0])
    rects = []
    for y, row in enumerate(TORTOISE):
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            r, g, b = PALETTE[ch]
            rects.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="#{r:02x}{g:02x}{b:02x}"/>')
    body = "\n".join(rects)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" shape-rendering="crispEdges">\n{body}\n</svg>\n'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="assets")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    render(32, PAPER).save(os.path.join(args.out, "diploma-tortoise.png"))
    render(32, None).save(os.path.join(args.out, "diploma-tortoise-transparent.png"))
    render(4, PAPER).save(os.path.join(args.out, "diploma-tortoise-128.png"))
    with open(os.path.join(args.out, "diploma-tortoise.svg"), "w") as handle:
        handle.write(svg())
    print(f"wrote tortoise to {args.out}/")


if __name__ == "__main__":
    main()
