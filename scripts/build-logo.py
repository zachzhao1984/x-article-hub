#!/usr/bin/env python3
"""
Build every logo asset from `Logo.jpg`, the one source of the artwork.

Why this exists
---------------
`Logo.jpg` is a JPEG, and a JPEG cannot carry transparency. The mark was exported
with a grey/white checkerboard where the alpha channel should be, so the
checkerboard is *real pixels* in the file — neutral, between 209 and 254 in
luminance, and therefore indistinguishable from a light background.

That is not hypothetical. Every icon this repo shipped before was a transparent
PNG that still had the checkerboard baked in at full opacity, so a browser tab, an
iOS home screen and an Android launcher all drew a grey checkerboard around the
mark. Regenerating from the artwork with the matte removed is the fix, and doing
it from one source file is what keeps the 16px and 32px versions from drifting
apart the way hand-tuned rasters do.

The matte
---------
The background and the mark separate on two independent axes, and any single
threshold on either one is wrong:

  - The body is *neutral and dark* — 26 to 165 in luminance, R=G=B.
  - The star is *chromatic and bright* — up to 246 in luminance, but R−B is 94.

So the rule is "keep the pixel if it is chromatic **or** dark". Thresholding on
luminance alone swallows the star; thresholding on chroma alone swallows the body's
specular highlights. The two tests are independent and an OR of them isolates the
mark, which works precisely because the artwork's brightest pixel (246) is also
one of its most chromatic ones (94) — the two conditions never overlap, so no
single threshold can separate them.

Alpha is binary by design rather than a per-pixel un-matte. Every output here is
at most 512px from a 1712px source, so the silhouette is resampled by at least
3.4x on the way down, and Lanczos over a 1px-hard edge produces exactly the
anti-aliased edge a soft matte would have given. What is lost is sub-pixel
*position* accuracy: at most ±1 source pixel, which is under 0.3px at the largest
output and 0.02px at 32. A soft matte would buy nothing visible there, and it would
cost a per-pixel solve for a foreground colour the artwork does not have — the
body is a shaded gradient, not one flat value, so the solve would be ill-posed.
One morphological step does the part that does matter: JPEG chroma subsampling
rings a half-tone transition along the mark's edge, and closing removes that
fringe, which is the one artefact a binary matte genuinely shows.

Why numpy and not ImageMagick
-----------------------------
The matte is array arithmetic over 2M pixels, which is what numpy is for. Crop,
resample, tile and encode are all ImageMagick's job, because getting resampling
quality right by hand is not this file's business.

Storage format is left to ImageMagick, and deliberately so. It picks per image: the
16px favicon holds a couple of dozen colours and comes out as a *paletted* PNG
carrying its transparency in a tRNS table, while the 180px one is truecolour with an
alpha channel. Both are correct, the palette is lossless and smaller, and forcing
truecolour with `PNG32:` is simply ignored. Only the sample depth is pinned, with
`-depth 8`, because ImageMagick runs at Q16 and an unpinned `xc:` canvas came out
16-bit. Anything that reads these files has to understand both — see
`tests/unit/png.ts`.

Run: `python3 scripts/build-logo.py` (needs `magick` on PATH and numpy).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'Logo.jpg'
PUBLIC = ROOT / 'public'

# Luminance above which a *neutral* pixel counts as background. The checker's
# darker square sits at 209, so this must stay below it; the mark's brightest
# neutral pixel is a highlight on a fold at 165, so it must stay above that.
BG_LUMINANCE = 196.0

# R−B above which a pixel counts as chromatic, i.e. part of the mark. The
# checkerboard is neutral to within JPEG noise (< 6); the star's dimmest gold is
# 138−87 = 51. 14 sits in the empty middle.
CHROMA = 14.0


# --- process -----------------------------------------------------------------


def run(*args: str, stdin: bytes | None = None) -> bytes:
    """Run a command, failing loudly — a skipped step would ship stale icons."""
    result = subprocess.run(args, input=stdin, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr.decode('utf-8', 'replace'))
        raise SystemExit(f'failed: {" ".join(args[:4])}')
    return result.stdout


def size_of(path: Path) -> tuple[int, int]:
    width, height = run('magick', 'identify', '-format', '%w %h', str(path)).decode().split()
    return int(width), int(height)


# --- array helpers -----------------------------------------------------------


def pad_edge(a: np.ndarray) -> np.ndarray:
    """
    Pad by one with 255, the value no real pixel exceeds.

    The morphology below slides a 3x3 window over the array, which walks off two
    edges. Padding rather than letting the slices shorten is what keeps the window
    from silently changing the array's shape mid-reduction.
    """
    pad_width = [(1, 1), (1, 1)] + ([(0, 0)] if a.ndim == 3 else [])
    return np.pad(a, pad_width, mode='constant', constant_values=255.0)


def neighbour(a: np.ndarray, op) -> np.ndarray:
    """Per-pixel min or max over the 3x3 neighbourhood."""
    height, width = a.shape[:2]
    padded = pad_edge(a)
    out = padded[:height, :width].copy()
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            op(out, padded[dy : dy + height, dx : dx + width], out=out)
    return out


# --- matte -------------------------------------------------------------------


def read_source() -> np.ndarray:
    """The artwork as a float RGB array of shape (height, width, 3) in 0–255."""
    width, height = size_of(SOURCE)
    raw = run('magick', str(SOURCE), '-alpha', 'off', '-depth', '8', 'rgb:-')
    if len(raw) != width * height * 3:
        raise SystemExit(f'expected {width * height * 3} bytes of RGB, got {len(raw)}')
    return np.frombuffer(raw, np.uint8).reshape(height, width, 3).astype(np.float32)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]


def chroma(rgb: np.ndarray) -> np.ndarray:
    return rgb.max(axis=2) - rgb.min(axis=2)


def matte(rgb: np.ndarray) -> np.ndarray:
    """The mark's alpha as 1.0 / 0.0, one float per pixel."""
    mark = (chroma(rgb) > CHROMA) | (luminance(rgb) < BG_LUMINANCE)

    # Binary closing, and the order is the whole point. Erode-then-dilate is a
    # closing too, and it keeps the half-tone ring that chroma subsampling leaves
    # along the edge while growing the mark by it. Dilate-then-erode swallows the
    # ring and leaves the silhouette where it actually is.
    mark = neighbour(mark.astype(np.float32), np.maximum)
    mark = neighbour(mark, np.minimum)
    return mark


def unring(rgb: np.ndarray, mark: np.ndarray) -> np.ndarray:
    """
    Pull the edge colour inside the silhouette.

    A boundary pixel is a blend of the mark and the checker's grey, and kept as it
    is that blend survives the downscale as a one-pixel halo: light grey on the
    dark body, washed-out cream on the star. Taking the darkest neighbour over a
    3x3 window replaces it with the mark's own colour, and that works in both
    directions of the artwork — the body's interior is darker than its edge blend,
    and the star's is too, since gold at 210 sits below a gold-on-white blend at
    240.
    """
    seeded = np.where(mark[..., None], rgb, 255.0)
    return np.where(mark[..., None], neighbour(seeded, np.minimum), rgb)


def ink_inverse(rgb: np.ndarray) -> np.ndarray:
    """
    The mark as it reads on a dark ground: the body lightened by inverting its
    shading.

    A per-channel inversion is not usable — it sends the gold through the
    complement and turns it teal, which on this palette is the accent colour, so
    the star would read as interface rather than as artwork. The body's shading is
    mapped along the site's own paper ramp instead, which keeps the emboss as a
    gradient rather than flattening it, and the star keeps its hue and simply gains
    the headroom it loses against dark ink.

    The ramp runs from the paper the site prints on to one step below it, so the
    inverse mark sits in the same tonal family as the dark theme's ink
    (`#e7eceb`) rather than in a family invented here.
    """
    out = rgb.copy()
    neutral = chroma(rgb) <= CHROMA

    # The body's shading, normalised to 0 at its deepest black and 1 at its
    # brightest highlight.
    depth = np.clip((luminance(rgb) - 20.0) / 155.0, 0.0, 1.0)
    light = np.array([245.0, 240.0, 230.0])
    shade = np.array([176.0, 170.0, 158.0])
    out[neutral] = (light + (shade - light) * depth[:, :, None])[neutral]

    gold = ~neutral
    out[gold] = np.clip(rgb[gold] * 1.06 + 6.0, 0.0, 255.0)
    return out


def tight_box(mark: np.ndarray) -> tuple[int, int, int, int]:
    """The mark's bounding box as (top, left, bottom, right), bottom/right exclusive."""
    rows = np.flatnonzero(mark.any(axis=1))
    cols = np.flatnonzero(mark.any(axis=0))
    if rows.size == 0 or cols.size == 0:
        raise SystemExit('the matte came out empty — the thresholds do not match this artwork')
    return int(rows[0]), int(cols[0]), int(rows[-1]) + 1, int(cols[-1]) + 1


def write_rgba(path: Path, rgb: np.ndarray, alpha: np.ndarray) -> None:
    """Encode an (h, w, 3) body plus an (h, w) alpha into a PNG via raw pixel data."""
    height, width = alpha.shape
    rgba = np.dstack([rgb, np.repeat(alpha[:, :, None], 1, axis=2) * 255.0])
    run(
        'magick',
        '-size',
        f'{width}x{height}',
        '-depth',
        '8',
        'rgba:-',
        str(path),
        stdin=np.ascontiguousarray(rgba, dtype=np.uint8).tobytes(),
    )


# --- assets ------------------------------------------------------------------


def fit(
    mark_png: Path,
    out: Path,
    canvas: int,
    fill: float,
    background: str = 'none',
) -> None:
    """
    Centre the mark on a square canvas, scaled to `fill` of its larger side.

    The larger *side*, not the width: the mark is wider than it is tall at about
    1.22:1, so fitting to width leaves the small sizes with a mark so short that the
    folds and the star disappear — which is the entire reason a separate
    hand-tuned raster used to exist for 16px. Fitting the longer side and centring
    keeps the star above a pixel at every size.
    """
    width, height = size_of(mark_png)
    scale = (canvas * fill) / max(width, height)
    geometry = f'{max(1, round(width * scale))}x{max(1, round(height * scale))}'
    layer = out.with_name(f'.layer-{out.name}')

    # `-filter Lanczos` explicitly, because the command line's default is a box
    # filter and a box filter turns a diagonal edge into a staircase at 16px.
    run('magick', str(mark_png), '-filter', 'Lanczos', '-resize', geometry, str(layer))
    run(
        'magick',
        '-size',
        f'{canvas}x{canvas}',
        f'xc:{background}',
        str(layer),
        '-gravity',
        'center',
        '-compose',
        'over',
        '-composite',
        '-depth',
        '8',
        '-strip',
        str(out),
    )
    layer.unlink()


def theme_color() -> str:
    """
    The touch-icon tile, read from the module that already owns it.

    `THEME_COLOR` in src/config/icons.ts is what the browser chrome and the
    installed-app splash use. Copying its value here would be a second place to
    forget to update, and the two are meant to be the same colour: an iOS icon cut
    from a different paper than the splash behind it reads as a rendering fault.
    """
    source = (ROOT / 'src' / 'config' / 'icons.ts').read_text(encoding='utf-8')
    match = re.search(r"THEME_COLOR\s*=\s*'(#[0-9a-fA-F]{6})'", source)
    if not match:
        raise SystemExit('could not read THEME_COLOR from src/config/icons.ts')
    return match.group(1)


def emit_all(master: Path, inverse: Path, work: Path) -> None:
    """Write every asset the site serves."""
    # The header mark, at 3x the 24px it renders at: crisp on a 2x display without
    # paying for a file big enough to matter.
    fit(master, PUBLIC / 'logo-mark.png', 72, 1.0)
    fit(inverse, PUBLIC / 'logo-mark-inverse.png', 72, 1.0)

    # Tabs. 0.86 leaves the mark nearly full-bleed, which is what the previous
    # hand-tuned set did; the padding that favicons.io adds is for artwork that
    # carries its own tile, and this one does not.
    fit(master, PUBLIC / 'favicon-16x16.png', 16, 0.86)
    fit(master, PUBLIC / 'favicon-32x32.png', 32, 0.86)

    # The same two sizes for a dark tab bar. The mark is near-black by
    # construction, so against #13191c it is not low contrast, it is absent — the
    # inverse is the one that survives there. Gated by `media` in the icon config
    # rather than baked into a light tile, because a tile on a white tab bar shows
    # its own edge.
    fit(inverse, PUBLIC / 'favicon-16x16-inverse.png', 16, 0.86)
    fit(inverse, PUBLIC / 'favicon-32x32-inverse.png', 32, 0.86)

    frame_48 = work / 'favicon-48x48.png'
    fit(master, frame_48, 48, 0.86)
    run(
        'magick',
        str(PUBLIC / 'favicon-16x16.png'),
        str(PUBLIC / 'favicon-32x32.png'),
        str(frame_48),
        '-depth',
        '8',
        str(PUBLIC / 'favicon.ico'),
    )
    frame_48.unlink()

    # Installed-app icons. No `purpose: maskable` anywhere: the mark is a floating
    # silhouette with no full-bleed background, so a launcher cropping it to a
    # circle or a squircle would cut into the glyph. Advertising one would make
    # Chrome pick it and clip the mark on install.
    fit(master, PUBLIC / 'icon-192.png', 192, 0.76)
    fit(master, PUBLIC / 'icon-512.png', 512, 0.76)

    # The touch icon is the one asset that cannot be transparent: iOS draws it on
    # the home screen without compositing it, and a floating mark on an
    # unpredictable wallpaper is unreadable. It also gets the most padding of any
    # asset, because iOS masks it with a superellipse that eats the corners — 112
    # of 180 leaves the mark inside the 102px circle inscribed in that shape.
    touch_mark = work / 'touch-mark.png'
    fit(master, touch_mark, 112, 1.0)
    run(
        'magick',
        '-size',
        '180x180',
        f'xc:{theme_color()}',
        str(touch_mark),
        '-gravity',
        'center',
        '-compose',
        'over',
        '-composite',
        '-depth',
        '8',
        '-strip',
        str(PUBLIC / 'apple-touch-icon.png'),
    )


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f'missing {SOURCE}')
    if not shutil.which('magick'):
        raise SystemExit('magick is not on PATH')

    rgb = read_source()
    mark = matte(rgb)
    top, left, bottom, right = tight_box(mark)

    # Crop to the mark with a margin, so a resize never samples the matte's own
    # hard edge as though it were artwork.
    height, width = mark.shape
    pad = max(4, round(max(bottom - top, right - left) * 0.02))
    top, left = max(0, top - pad), max(0, left - pad)
    bottom, right = min(height, bottom + pad), min(width, right + pad)

    alpha = mark[top:bottom, left:right]
    body = unring(rgb[top:bottom, left:right], alpha > 0.5)

    work = Path(tempfile.mkdtemp(prefix='xah-logo-'))
    try:
        master = work / 'mark.png'
        write_rgba(master, body, alpha)
        write_rgba(work / 'mark-inverse.png', ink_inverse(body), alpha)
        emit_all(master, work / 'mark-inverse.png', work)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    filled = 100 * alpha.sum() / ((right - left) * (bottom - top))
    print(f'source {width}x{height}, mark {right - left}x{bottom - top}, {filled:.0f}% of its crop')
    print('wrote logo-mark, logo-mark-inverse, favicon-16x16{,-inverse}, favicon-32x32{,-inverse},')
    print('      favicon.ico, apple-touch-icon, icon-192, icon-512')


if __name__ == '__main__':
    main()