"""Build every Signal Path app icon from one definition.

The mark is a sawtooth wave, the raw material of subtractive synthesis, drawn
in white on the course's "sound" blue. It's defined once below as an SVG path,
the same one as site/assets/favicon.svg, and rendered by a headless browser at
every size the web app manifest and iOS need, so the icons can't drift from
the favicon and get proper anti-aliasing and round joins.

    pip install playwright && python3 -m playwright install chromium
    python3 scripts/build_icons.py

Outputs, in site/icons/:

    icon-192.png, icon-512.png      rounded tile, for browsers and desktops
    maskable-192.png, maskable-512  full-bleed tile with the mark inside the
                                    safe zone, so Android can crop it to any shape
    apple-touch-icon.png            180 px, square (iOS rounds the corners itself)
"""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

OUT = Path(__file__).resolve().parent.parent / 'site' / 'icons'

BLUE = '#1e5bd8'  # --sound
PATH = 'M5 22 L12 9 L12 22 L19 9 L19 22 L27 9'  # the favicon's sawtooth, 32 x 32


def svg(size, *, rounded, scale):
    """The tile and the mark. `scale` shrinks the mark around the centre."""
    radius = 7 if rounded else 0
    # The mark spans x 5–27 and y 9–22; centre it on (16, 15.5) before scaling.
    transform = f'translate(16 16) scale({scale}) translate(-16 -15.5)'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="{size}" height="{size}">
  <rect width="32" height="32" rx="{radius}" fill="{BLUE}"/>
  <path d="{PATH}" transform="{transform}" fill="none" stroke="#fff"
        stroke-width="{2.6 / scale:.3f}" stroke-linejoin="round" stroke-linecap="round"
        vector-effect="non-scaling-stroke" style="stroke-width:{2.6 * size / 32:.2f}px"/>
</svg>'''


ICONS = [
    ('icon-192.png', 192, dict(rounded=True, scale=1.0)),
    ('icon-512.png', 512, dict(rounded=True, scale=1.0)),
    # Maskable icons get cropped to circles and squircles: keep the mark well
    # inside the central 80% safe zone.
    ('maskable-192.png', 192, dict(rounded=False, scale=0.78)),
    ('maskable-512.png', 512, dict(rounded=False, scale=0.78)),
    ('apple-touch-icon.png', 180, dict(rounded=False, scale=0.92)),
]


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        for name, size, opts in ICONS:
            await page.set_viewport_size({'width': size, 'height': size})
            await page.set_content(
                f'<html><body style="margin:0;background:transparent">{svg(size, **opts)}</body></html>'
            )
            await page.locator('svg').screenshot(path=str(OUT / name), omit_background=True)
        await browser.close()
    print(f'Wrote {len(ICONS)} icons to {OUT}')


if __name__ == '__main__':
    asyncio.run(main())
