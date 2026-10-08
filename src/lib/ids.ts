/**
 * Prefixed, sortable-ish ids: `art_`, `job_`, `aut_`, `tag_`, `ver_`, `met_`,
 * `evt_`, `cat_`, `usr_`. Prefixes make D1 rows self-describing in logs and raw queries.
 *
 * Random suffix (base36 of 128-bit randomness) keeps ids unguessable, which
 * matters for admin-only routes that address rows by id.
 *
 * `usr_` is in this list for the same reason as the rest: a user id turns up in logs and
 * in `/account` URLs, and a prefix makes it obvious which table a bare id belongs to.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomSuffix(length = 20): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export type IdPrefix = 'art' | 'job' | 'aut' | 'tag' | 'ver' | 'met' | 'evt' | 'cat' | 'usr';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomSuffix()}`;
}

/** Deterministic author id derived from the X username, so re-imports never duplicate an author. */
export function authorId(username: string): string {
  return `aut_${username.toLowerCase()}`;
}
