# Brand assets

The logo in `source/aon-role-bot-logo.png` is the **preliminary** AoN Role Bot logo (not a final brand asset).

To change it later, **replace that one file** (square PNG, at least 1024 px) and run, from the repository root:

    python3 scripts/make-brand-assets.py

The script regenerates every variant below. If the new artwork has a different layout, adjust `EMBLEM_BOX`, `RING_*` and `TEXT_RECT`
at the top of the script (they control the text-free emblem used at small sizes).

| File | Used for |
|---|---|
| `logo-full-{1024,512,256}.png/.webp` | landing-page hero, sharing |
| `mark-{256,128,64}.png/.webp` | dashboard / landing header (emblem only, readable at small sizes) |
| `favicon.ico`, `favicon-{32,48}.png`, `apple-touch-icon.png` | browser tab / home-screen icon |
| `bot-avatar-1024.png` | upload manually in the Discord Developer Portal → Bot → Icon (Discord shows it round) |

Pages reference only `/static/brand/*`, so no HTML needs to change when the logo is replaced.
