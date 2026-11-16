#!/usr/bin/env python3
"""Make the web sizes of the page pictures (assets/pictures/).

The Delivery, Suburbs and Bulk eggs pages each show their own real photograph in the hero,
in place of the chalk tray photo. The 2048 px masters are too heavy for the repo; they live
in the project files (website-redesign/page-pictures-nov-15/real-photos/masters/, with
SOURCES.txt beside them naming each photograph, its author and its CC0 licence). This script
turns a folder of masters named delivery.png, suburbs.png and bulk.png into the three widths
the hero asks for, in webp and jpg, the same widths as the chalk photo.

    python3 infra/build-page-pictures.py <folder of masters>

After a picture changes, bump PIC_V in infra/build-pages.mjs and rebuild the pages.
"""
import sys
from pathlib import Path
from PIL import Image

NAMES = ("delivery", "suburbs", "bulk")
WIDTHS = (640, 928, 1536)
OUT = Path(__file__).resolve().parent.parent / "assets" / "pictures"


def main(folder):
    OUT.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        master = Image.open(Path(folder) / f"{name}.png").convert("RGB")
        if master.width != master.height:
            raise SystemExit(f"{name}.png must be square, got {master.size}")
        for w in WIDTHS:
            im = master.resize((w, w), Image.LANCZOS)
            im.save(OUT / f"{name}-{w}.webp", "WEBP", quality=82, method=6)
            im.save(OUT / f"{name}-{w}.jpg", "JPEG", quality=84, optimize=True, progressive=True)
            print(name, w, (OUT / f"{name}-{w}.webp").stat().st_size, (OUT / f"{name}-{w}.jpg").stat().st_size)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
