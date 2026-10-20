#!/usr/bin/env python3
"""Generate site marks and browser icons from Logo.png (ImageMagick + numpy)."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from collections import deque
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'Logo.png'
PUBLIC = ROOT / 'public'


def run(*args: str, stdin: bytes | None = None) -> bytes:
    result = subprocess.run(args, input=stdin, capture_output=True)
    if result.returncode:
        sys.stderr.write(result.stderr.decode('utf-8', 'replace'))
        raise SystemExit(f'failed: {" ".join(args[:4])}')
    return result.stdout


def rgba_source() -> tuple[np.ndarray, np.ndarray]:
    width, height = map(int, run('magick', 'identify', '-format', '%w %h', str(SOURCE)).split())
    data = np.frombuffer(run('magick', str(SOURCE), '-depth', '8', 'rgba:-'), np.uint8)
    pixels = data.reshape(height, width, 4)
    return pixels[:, :, :3].copy(), pixels[:, :, 3].copy()


def foreground(rgb: np.ndarray, source_alpha: np.ndarray) -> np.ndarray:
    """Remove the neutral, light checkerboard while keeping the warm paper card.

    In this source the checkerboard is actual RGB pixels, not transparency. Its
    chroma is <=4 even where it is gray; the white card has warm chroma >=5,
    and the blue square has far more. The near-black X is kept by luminance.
    Close tiny compression holes and fill enclosed gaps in the paper silhouette.
    """
    channels = rgb.astype(np.int16)
    chroma = channels.max(axis=2) - channels.min(axis=2)
    luminance = channels.mean(axis=2)
    mark = ((chroma >= 5) | (luminance < 220)) & (source_alpha > 0)

    # A 5px closing joins isolated gaps in the pale paper and shadow.
    pad = np.pad(mark, 2, constant_values=False)
    mark = np.logical_or.reduce([pad[dy:dy + mark.shape[0], dx:dx + mark.shape[1]]
                                 for dy in range(5) for dx in range(5)])
    pad = np.pad(mark, 2, constant_values=True)
    mark = np.logical_and.reduce([pad[dy:dy + mark.shape[0], dx:dx + mark.shape[1]]
                                  for dy in range(5) for dx in range(5)])

    # Treat only exterior background as transparent; enclosed pale areas belong
    # to the page even when they happen to match a checkerboard square.
    height, width = mark.shape
    exterior = np.zeros((height, width), dtype=np.uint8)
    queue: deque[int] = deque()
    flat_mark = mark.ravel()
    flat_exterior = exterior.ravel()
    for x in range(width):
        for index in (x, (height - 1) * width + x):
            if not flat_mark[index] and not flat_exterior[index]:
                flat_exterior[index] = 1
                queue.append(index)
    for y in range(1, height - 1):
        for index in (y * width, y * width + width - 1):
            if not flat_mark[index] and not flat_exterior[index]:
                flat_exterior[index] = 1
                queue.append(index)
    while queue:
        index = queue.popleft()
        for neighbour in (index - 1, index + 1, index - width, index + width):
            if 0 <= neighbour < height * width and not flat_mark[neighbour] and not flat_exterior[neighbour]:
                flat_exterior[neighbour] = 1
                queue.append(neighbour)
    return np.logical_not(exterior)


def save_rgba(path: Path, rgb: np.ndarray, alpha: np.ndarray) -> None:
    h, w = alpha.shape
    pixels = np.dstack((rgb, alpha)).astype(np.uint8)
    run('magick', '-size', f'{w}x{h}', '-depth', '8', 'rgba:-', '-strip', str(path),
        stdin=np.ascontiguousarray(pixels).tobytes())


def fit(mark: Path, path: Path, size: int, fill: float, background: str = 'none') -> None:
    run('magick', str(mark), '-filter', 'Lanczos', '-resize', f'{round(size * fill)}x{round(size * fill)}',
        '-gravity', 'center', '-background', background, '-extent', f'{size}x{size}',
        '-depth', '8', '-strip', str(path))


def theme_color() -> str:
    config = (ROOT / 'src' / 'config' / 'icons.ts').read_text(encoding='utf-8')
    match = re.search(r"THEME_COLOR\s*=\s*'(#[0-9a-fA-F]{6})'", config)
    if not match:
        raise SystemExit('could not read THEME_COLOR from src/config/icons.ts')
    return match.group(1)


def pinned_tab(alpha: np.ndarray) -> None:
    """Trace the same silhouette at 64px into Safari's monochrome mask."""
    h, w = alpha.shape
    small = np.frombuffer(run('magick', '-size', f'{w}x{h}', '-depth', '8',
                              'gray:-', '-filter', 'Lanczos', '-resize', '56x56!',
                              '-threshold', '45%', '-depth', '8', 'gray:-',
                              stdin=np.ascontiguousarray(alpha).tobytes()), np.uint8).reshape(56, 56)
    paths: list[str] = []
    for y, row in enumerate(small):
        padded = np.pad(row > 0, (1, 1), constant_values=False).astype(np.int8)
        starts = np.flatnonzero(np.diff(padded) == 1)
        ends = np.flatnonzero(np.diff(padded) == -1)
        for start, end in zip(starts, ends):
            paths.append(f'M{start + 4},{y + 4}h{end - start}v1H{start + 4}z')
    markup = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
              '  <!-- Monochrome mask generated from Logo.png by scripts/build-logo.py. -->\n'
              '  <defs><mask id="stencil">'
              f'<path d="{"".join(paths)}" fill="#fff"/>'
              '</mask></defs>\n'
              '  <rect width="64" height="64" fill="#000" mask="url(#stencil)"/>\n</svg>\n')
    (PUBLIC / 'safari-pinned-tab.svg').write_text(markup, encoding='utf-8')


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f'missing {SOURCE}')
    if not shutil.which('magick'):
        raise SystemExit('magick is not on PATH')
    rgb, source_alpha = rgba_source()
    alpha = foreground(rgb, source_alpha)
    ys, xs = np.where(alpha)
    pad = 12
    top, bottom = max(0, ys.min() - pad), min(len(rgb), ys.max() + pad + 1)
    left, right = max(0, xs.min() - pad), min(rgb.shape[1], xs.max() + pad + 1)
    crop = rgb[top:bottom, left:right]
    mask = (alpha[top:bottom, left:right] * 255).astype(np.uint8)

    # The dark X needs its own light ink on dark headers. Preserve the white
    # article card, its blue image, and the gray text exactly as provided.
    inverse = crop.copy()
    y, x = np.indices(mask.shape)
    dark_x = ((x + left < 620) | (y + top < 405)) & (crop.mean(axis=2) < 120)
    inverse[dark_x] = np.clip(242 - crop[dark_x] * 0.25, 0, 255).astype(np.uint8)

    work = Path(tempfile.mkdtemp(prefix='xah-logo-'))
    try:
        mark, light_mark = work / 'mark.png', work / 'mark-inverse.png'
        save_rgba(mark, crop, mask)
        save_rgba(light_mark, inverse, mask)
        fit(mark, PUBLIC / 'logo-mark.png', 96, 0.98)
        fit(light_mark, PUBLIC / 'logo-mark-inverse.png', 96, 0.98)
        for size in (16, 32):
            fit(mark, PUBLIC / f'favicon-{size}x{size}.png', size, 0.92)
            fit(light_mark, PUBLIC / f'favicon-{size}x{size}-inverse.png', size, 0.92)
        frame = work / 'favicon-48.png'
        fit(mark, frame, 48, 0.92)
        run('magick', str(PUBLIC / 'favicon-16x16.png'), str(PUBLIC / 'favicon-32x32.png'),
            str(frame), str(PUBLIC / 'favicon.ico'))
        for size in (192, 512):
            fit(mark, PUBLIC / f'icon-{size}.png', size, 0.76)
        fit(mark, PUBLIC / 'apple-touch-icon.png', 180, 0.64, theme_color())
        pinned_tab(mask)
    finally:
        shutil.rmtree(work)
    print('Generated logo, favicons, touch icons, and Safari mask from Logo.png')


if __name__ == '__main__':
    main()
