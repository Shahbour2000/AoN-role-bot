#!/usr/bin/env python3
"""
Regenerates every web/Discord variant of the logo from ONE source image.
To change the brand later: replace packages/web/public/brand/source/aon-role-bot-logo.png (square PNG, >= 1024 px) and run
    python3 scripts/make-brand-assets.py
Variants:  logo-full-{1024,512,256}  full circular logo with text (landing hero, social, Discord avatar)
           mark-{256,128,64}         emblem only (robot + laurels, no text) for small sizes: header, dashboard
           favicon.ico, favicon-{32,48}.png, apple-touch-icon.png   (from the emblem)
           bot-avatar-1024.png       upload this in the Discord Developer Portal (Discord shows it round)
"""
import sys
from pathlib import Path
from PIL import Image

BRAND = Path(__file__).resolve().parent.parent / "packages" / "web" / "public" / "brand"
SRC = BRAND / "source" / "aon-role-bot-logo.png"
# Emblem crop (robot + hat + laurels), in source pixels for a 1254 px image. The outer gold ring and the "AoN Role Bot"
# lettering are painted out with the logo's own background first, so the small-size mark stays clean and nothing is cut off.
EMBLEM_BOX = (195, 170, 1060, 815)
RING_CENTER, RING_PAD = (623.5, 597.0), (468, 512)        # annulus (radius range) covering the outer ring
TEXT_RECT = (392, 779, 862, 1000)                          # lettering below the robot (x0, y0, x1, y1)

def save(img, name, **kw):
    path = BRAND / name
    img.save(path, optimize=True, **kw)
    print(f"{name:28s} {img.size[0]}x{img.size[1]}  {path.stat().st_size/1024:.1f} KiB")

def main():
    src = Image.open(SRC).convert("RGB")
    w, h = src.size
    if w != h or w < 1024:
        sys.exit(f"source must be a square image of at least 1024 px (got {w}x{h})")
    scale = w / 1254
    bg = src.getpixel((int(5 * scale), int(5 * scale)))                       # dark background colour sampled from the image
    for size in (1024, 512, 256):
        full = src.resize((size, size), Image.LANCZOS)
        save(full, f"logo-full-{size}.png"); save(full, f"logo-full-{size}.webp", quality=90, method=6)
    save(src.resize((1024, 1024), Image.LANCZOS), "bot-avatar-1024.png")
    from PIL import ImageDraw
    work = src.copy(); d = ImageDraw.Draw(work)
    cx, cy = (RING_CENTER[0] * scale, RING_CENTER[1] * scale)
    r_in, r_out = RING_PAD[0] * scale, RING_PAD[1] * scale
    d.ellipse((cx - r_out, cy - r_out, cx + r_out, cy + r_out), outline=bg, width=int(r_out - r_in))   # erase the ring band only
    d.rectangle(tuple(int(v * scale) for v in TEXT_RECT), fill=bg)
    box = tuple(int(v * scale) for v in EMBLEM_BOX)
    emblem = work.crop(box)
    side = max(emblem.size)
    mark = Image.new("RGB", (side, side), bg)                                  # pad to a square with the logo's own background
    mark.paste(emblem, ((side - emblem.size[0]) // 2, (side - emblem.size[1]) // 2))
    for size in (256, 128, 64):
        m = mark.resize((size, size), Image.LANCZOS)
        save(m, f"mark-{size}.png"); save(m, f"mark-{size}.webp", quality=92, method=6)
    for size in (32, 48):
        save(mark.resize((size, size), Image.LANCZOS), f"favicon-{size}.png")
    save(mark.resize((180, 180), Image.LANCZOS), "apple-touch-icon.png")
    mark.resize((64, 64), Image.LANCZOS).save(BRAND / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print("favicon.ico written")

if __name__ == "__main__":
    main()
