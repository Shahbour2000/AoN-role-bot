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
# Emblem crop (crown + robot), in source pixels for a 1254 px image. The outer neon ring and the "AoN ROLE BOT" lettering are
# removed from the small-size mark: pixels are kept only inside the ring's inner radius or inside the crown box (the crown rises
# above the ring), everything else is painted with the logo's own background, and the crop stops above the lettering.
EMBLEM_BOX = (300, 70, 960, 652)
RING_CENTER, KEEP_RADIUS = (627.0, 648.0), 412
CROWN_BOX = (440, 70, 815, 330)

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
    cx, cy, keep_r = RING_CENTER[0] * scale, RING_CENTER[1] * scale, KEEP_RADIUS * scale
    mask = Image.new("L", src.size, 0); d = ImageDraw.Draw(mask)
    d.ellipse((cx - keep_r, cy - keep_r, cx + keep_r, cy + keep_r), fill=255)
    d.rectangle(tuple(int(v * scale) for v in CROWN_BOX), fill=255)
    work = Image.composite(src, Image.new("RGB", src.size, bg), mask)
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
