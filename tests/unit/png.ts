/**
 * A minimal PNG reader, for assertions about pixels rather than about a header.
 *
 * It exists because "is this icon actually transparent" is a question no header
 * answers. The files the site used to serve were RGBA PNGs at full opacity — the
 * grey/white checkerboard from the source JPEG was baked in as pixels — so a check
 * that read the IHDR colour type called them fine. Reading the alpha channel means
 * walking the scanline filters, which is all the rest of this file is.
 *
 * Scope is deliberately narrow: 8-bit and below, no interlacing, no 16-bit samples.
 * Anything outside that throws with a message naming the file, rather than quietly
 * returning a wrong answer.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

export interface Decoded {
  width: number;
  height: number;
  /** Whether any pixel is transparent, as opposed to the file being opaque throughout. */
  hasAlpha: boolean;
  /** width * height * 4, RGBA order. */
  data: Uint8Array;
}

/** Stored samples per pixel, per PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(name: string): Decoded {
  const buf = readFileSync(resolve('public', name));
  if (buf.subarray(0, 8).length !== 8 || SIGNATURE.some((b, i) => buf[i] !== b)) {
    throw new Error(`${name} is not a PNG`);
  }

  let pos = 8;
  let header: Buffer | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const idat: Buffer[] = [];
  let interlaced = false;
  for (;;) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') header = chunk;
    else if (type === 'PLTE') palette = chunk;
    else if (type === 'tRNS') transparency = chunk;
    else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (!header) throw new Error(`${name} has no IHDR`);

  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8] ?? 0;
  const colourType = header[9] ?? 0;
  // Adam7 interlace writes seven differently-strided images; supporting it would mean
  // a second pass geometry for a format nothing here produces.
  interlaced = (header[12] ?? 0) !== 0;
  if (depth > 8) throw new Error(`${name} is ${depth}-bit; this reader handles 8 and below`);
  if (interlaced) throw new Error(`${name} is interlaced; this reader handles progressive only`);

  const stored = CHANNELS[colourType];
  if (stored === undefined) {
    throw new Error(`${name} is colour type ${colourType}, which this reader does not handle`);
  }
  if (colourType === 3 && !palette) throw new Error(`${name} is paletted with no PLTE`);

  // Bytes per pixel for the *filter* arithmetic: ceil(samples × depth ÷ 8), never less
  // than 1 — a paletted 4-bit image still filters one byte at a time.
  const bytesPerPixel = Math.max(1, Math.ceil((stored * depth) / 8));
  const stride = Math.ceil((width * stored * depth) / 8);

  const raw = inflateSync(Buffer.concat(idat));
  const scan = new Uint8Array(height * stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++] ?? 0;
    const line = scan.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? scan.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const byte = raw[at++] ?? 0;
      const a = x >= bytesPerPixel ? (line[x - bytesPerPixel] ?? 0) : 0;
      const b = above ? (above[x] ?? 0) : 0;
      const c = above && x >= bytesPerPixel ? (above[x - bytesPerPixel] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + a;
          break;
        case 2:
          value = byte + b;
          break;
        case 3:
          value = byte + ((a + b) >> 1);
          break;
        case 4: {
          // Paeth: take whichever candidate is nearest the linear estimate. Ties break
          // toward `a`, as the spec requires.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = byte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`${name} row ${y} has unknown filter ${filter}`);
      }
      line[x] = value & 0xff;
    }
  }

  /** Sample `n` of pixel `x`: a channel, or the palette index for a paletted image. */
  const sample = (row: Uint8Array, x: number, n: number): number => {
    if (depth === 8) return row[x * stored + n] ?? 0;
    // Sub-byte depths pack samples most-significant-bit first within each byte.
    const perByte = 8 / depth;
    const byte = row[Math.floor(x / perByte)] ?? 0;
    const shift = 8 - depth * ((x % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };

  // tRNS holds one 16-bit key per channel for a direct-colour image, and for greyscale
  // a single one; for a palette it is one alpha byte per entry, handled below.
  const keys =
    transparency && transparency.length >= 6
      ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)]
      : undefined;
  const greyKey = transparency && transparency.length >= 2 ? transparency.readUInt16BE(0) : undefined;

  const out = new Uint8Array(width * height * 4);
  let hasAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = scan.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      let rgb: number[];
      let alpha = 255;
      switch (colourType) {
        case 0:
          rgb = [sample(row, x, 0), sample(row, x, 0), sample(row, x, 0)];
          if (greyKey !== undefined && sample(row, x, 0) === greyKey) alpha = 0;
          break;
        case 2:
          rgb = [sample(row, x, 0), sample(row, x, 1), sample(row, x, 2)];
          if (keys && rgb.every((v, i) => v === keys[i])) alpha = 0;
          break;
        case 3: {
          const entry = sample(row, x, 0);
          rgb = [palette?.[entry * 3] ?? 0, palette?.[entry * 3 + 1] ?? 0, palette?.[entry * 3 + 2] ?? 0];
          // A paletted image is transparent where its tRNS entry is, and tRNS may be
          // shorter than the palette: past its end every index is opaque.
          const entryAlpha = transparency?.[entry];
          if (entryAlpha !== undefined) alpha = entryAlpha;
          break;
        }
        case 4:
          rgb = [sample(row, x, 0), sample(row, x, 0), sample(row, x, 0)];
          alpha = sample(row, x, 1);
          break;
        default:
          rgb = [sample(row, x, 0), sample(row, x, 1), sample(row, x, 2)];
          alpha = sample(row, x, 3);
          break;
      }
      if (alpha < 255) hasAlpha = true;
      const to = (y * width + x) * 4;
      out[to] = rgb[0] ?? 0;
      out[to + 1] = rgb[1] ?? 0;
      out[to + 2] = rgb[2] ?? 0;
      out[to + 3] = alpha;
    }
  }
  return { width, height, hasAlpha, data: out };
}

export const alphaAt = (img: Decoded, x: number, y: number): number =>
  img.data[(y * img.width + x) * 4 + 3] ?? 0;

export const rgbAt = (img: Decoded, x: number, y: number): readonly [number, number, number] => {
  const at = (y * img.width + x) * 4;
  return [img.data[at] ?? 0, img.data[at + 1] ?? 0, img.data[at + 2] ?? 0];
};

export const luminance = ([r, g, b]: readonly [number, number, number]): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The share of the canvas the mark covers, 0–100. */
export const coverage = (img: Decoded): number => {
  let opaque = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if ((img.data[i * 4 + 3] ?? 0) >= 250) opaque++;
  }
  return (opaque * 100) / (img.width * img.height);
};

/** Mean luminance over the pixels opaque enough to be artwork rather than an edge. */
export const meanLuminance = (img: Decoded): number => {
  let total = 0;
  let count = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if ((img.data[i * 4 + 3] ?? 0) < 250) continue;
    total += luminance([img.data[i * 4] ?? 0, img.data[i * 4 + 1] ?? 0, img.data[i * 4 + 2] ?? 0]);
    count++;
  }
  return count === 0 ? 0 : total / count;
};

/** The widest R−B spread among opaque pixels, which is what a coloured accent shows up in. */
export const maxChroma = (img: Decoded): number => {
  let widest = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if ((img.data[i * 4 + 3] ?? 0) < 250) continue;
    const channels = [img.data[i * 4] ?? 0, img.data[i * 4 + 1] ?? 0, img.data[i * 4 + 2] ?? 0];
    widest = Math.max(widest, Math.max(...channels) - Math.min(...channels));
  }
  return widest;
};