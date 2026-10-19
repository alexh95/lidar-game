"""Tile snapshots into one labelled image so a reviewer (human or agent) can
compare several views at once.

    python tools/contact-sheet.py out.png .snapshots/h1-*.png [--cols 2] [--width 480]
"""

import argparse
import glob
import os

from PIL import Image, ImageDraw


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--width", type=int, default=480, help="tile width in px")
    args = ap.parse_args()

    paths: list[str] = []
    for pattern in args.inputs:
        paths.extend(sorted(glob.glob(pattern)) or [pattern])
    tiles = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        h = round(im.height * args.width / im.width)
        tiles.append((os.path.splitext(os.path.basename(p))[0], im.resize((args.width, h))))
    if not tiles:
        raise SystemExit("no images")
    tile_h = max(t.height for _, t in tiles) + 22
    rows = (len(tiles) + args.cols - 1) // args.cols
    sheet = Image.new("RGB", (args.cols * args.width, rows * tile_h), (24, 22, 30))
    draw = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(tiles):
        x = (i % args.cols) * args.width
        y = (i // args.cols) * tile_h
        sheet.paste(im, (x, y + 22))
        draw.text((x + 6, y + 5), name, fill=(255, 220, 170))
    sheet.save(args.out)
    print(args.out, sheet.size)


if __name__ == "__main__":
    main()
