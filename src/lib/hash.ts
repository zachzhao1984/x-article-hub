/**
 * SPEC §27 / §28 / §36 — content hashing.
 *
 * `source_hash` detects "the page we archived changed".
 * `content_hash` detects "the parsed document changed".
 * Both are used to skip re-crawl / re-AI work, which is the single biggest cost
 * lever in SPEC §36.
 */

export type HashAlgorithm = 'SHA-256';

const encoder = new TextEncoder();

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data =
    typeof input === 'string'
      ? encoder.encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);

  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
