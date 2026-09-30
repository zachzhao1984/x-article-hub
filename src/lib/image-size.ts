/**
 * SPEC §10 — image dimensions from the header bytes.
 *
 * The document needs `width` / `height` so the reading page can reserve space and
 * the article does not reflow as images arrive. Getting them from a decoder would
 * mean a dependency and a full parse of every image; every one of these formats
 * carries the size in the first few dozen bytes.
 *
 * Returns null rather than a guess when the size cannot be found. A wrong
 * dimension is worse than a missing one, because a missing one can be laid out
 * after load and a wrong one cannot.
 *
 * Every byte read goes through `at` / `u16` / `u24` / `u32`, which bounds-check
 * first and return 0 past the end. Header parsing walks attacker-influenced data
 * — this reads bytes from X's CDN — so an out-of-range read has to be a quiet
 * null, never an exception that fails the whole media run.
 */

export interface ImageSize {
  width: number;
  height: number;
}

type KnownFormat = 'webp' | 'jpeg' | 'png' | 'gif';

export function imageDimensions(bytes: Uint8Array, format: KnownFormat): ImageSize | null {
  switch (format) {
    case 'png':
      return pngSize(bytes);
    case 'gif':
      return gifSize(bytes);
    case 'jpeg':
      return jpegSize(bytes);
    case 'webp':
      return webpSize(bytes);
    default:
      return null;
  }
}

/** One byte, or 0 past the end. */
function at(bytes: Uint8Array, index: number): number {
  return index >= 0 && index < bytes.length ? (bytes[index] ?? 0) : 0;
}

/** Big-endian unsigned 16-bit. */
function u16be(bytes: Uint8Array, index: number): number {
  return (at(bytes, index) << 8) | at(bytes, index + 1);
}

/** Little-endian unsigned 16-bit. */
function u16le(bytes: Uint8Array, index: number): number {
  return at(bytes, index) | (at(bytes, index + 1) << 8);
}

/** Little-endian unsigned 24-bit. */
function u24le(bytes: Uint8Array, index: number): number {
  return at(bytes, index) | (at(bytes, index + 1) << 8) | (at(bytes, index + 2) << 16);
}

/** Big-endian unsigned 32-bit, as a signed-safe JS number. */
function u32be(bytes: Uint8Array, index: number): number {
  return (
    ((at(bytes, index) << 24) | (at(bytes, index + 1) << 16) | (at(bytes, index + 2) << 8) | at(bytes, index + 3)) >>>
    0
  );
}

/** PNG: IHDR is always the first chunk and holds a big-endian 32-bit pair. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null;
  if (!(at(bytes, 0) === 0x89 && ascii(bytes, 1, 3) === 'PNG')) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF: the logical screen descriptor sits at a fixed offset from the header. */
function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** JPEG: walk the marker segments until a start-of-frame header turns up. */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4) return null;
  if (!(at(bytes, 0) === 0xff && at(bytes, 1) === 0xd8)) return null;

  let offset = 2;
  // A segment can never be longer than what is left, and a malformed length of 0
  // would otherwise spin this loop forever.
  const limit = bytes.length - 9;

  while (offset < limit) {
    // Segment padding (a run of 0xFF) is legal between markers.
    if (at(bytes, offset) !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = at(bytes, offset + 1);

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan, or end of image: the entropy-coded data begins and no frame
    // header was found, so this JPEG has no dimensions to report.
    if (marker === 0xda || marker === 0xd9) return null;

    const segmentLength = u16be(bytes, offset + 2);
    if (segmentLength < 2) return null;

    // SOF0..SOF15 hold the frame size, except for the DHT / JPG / DAC markers
    // that share the same numeric range and mean something else entirely.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isStartOfFrame) {
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

/** WebP: a RIFF container with three possible payload layouts. */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;

  const chunk = ascii(bytes, 12, 4);

  // VP8X: a 10-byte header with 24-bit canvas dimensions, stored minus one.
  if (chunk === 'VP8X') {
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }

  // VP8L: 14-bit width-1 and height-1, packed little-endian after the signature.
  if (chunk === 'VP8L') {
    const bits = at(bytes, 21) | (at(bytes, 22) << 8) | (at(bytes, 23) << 16) | (at(bytes, 24) << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }

  // VP8 (lossy): 16-bit dimensions in the frame header.
  if (chunk === 'VP8 ') {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length; i += 1) out += String.fromCharCode(at(bytes, i));
  return out;
}
