import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCoverPrompt, COVER_MODEL } from '../../src/services/cover';

/**
 * Generated covers (0012).
 *
 * The card's cover is the article's first `body` image, so an article with no figures has no
 * cover — 77 of the first hundred imported articles. This feature generates a stand-in, and
 * the properties worth pinning are the ones where "it worked when I tried it" is not enough:
 *
 *  - the prompt is built from stored, plain-text fields and capped, because SPEC §13.4 caps
 *    what a model sees and the input is someone else's writing;
 *  - a generated cover is a *fallback*, so a body image must still win, or adding one to an
 *    article with real figures would silently replace the author's own picture;
 *  - the media reconciler must understand `kind = 'cover'`, or the next media run computes a
 *    body key for it, judges the real key stale, and sweeps the bytes — deleting every
 *    generated cover without any run reporting a failure.
 */

const coverSrc = readFileSync(resolve('src/services/cover.ts'), 'utf8');
const mediaSrc = readFileSync(resolve('src/services/media.ts'), 'utf8');
const publicSrc = readFileSync(resolve('src/db/public.ts'), 'utf8');
const usersSrc = readFileSync(resolve('src/db/users.ts'), 'utf8');
const schema = readdirSync(resolve('migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(resolve('migrations', f), 'utf8'))
  .join('\n');

/** Source with comments stripped, so an assertion is about code and not about prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('buildCoverPrompt', () => {
  it('names the category, not the article title', () => {
    // The measured reason: given the title, flux drew it as literal text into the image —
    // the whole title with its question mark, across two prompt wordings. The title is the
    // field most likely to be short, quotable and punctuation-bearing, which is exactly what
    // a diffusion model renders as type, and there is no negative prompt to stop it (flux
    // refuses one, 5006). The category carries the theme instead.
    const prompt = buildCoverPrompt({ categoryName: 'AI' });
    expect(prompt.toLowerCase()).toContain('network');
    // And the title never appears, because it is never passed.
    expect(prompt).not.toContain('Is The Assembly');
  });

  it('gives each top-level category its own visual brief', () => {
    const seen = new Set(
      ['AI', 'Technology', 'Business', 'Science', 'Ideas'].map((c) => buildCoverPrompt({ categoryName: c })),
    );
    expect(seen.size).toBe(5);
  });

  it('falls back to a default brief when the category is unknown or absent', () => {
    // A freshly imported article may have no category at all; the prompt still has to work.
    const none = buildCoverPrompt({ categoryName: null });
    const unknown = buildCoverPrompt({ categoryName: 'Astrology' });
    expect(none.length).toBeGreaterThan(0);
    expect(none).toBe(unknown);
  });

  it('always asks for no text, because a model that writes words produces garbage on a cover', () => {
    // This is the failure the whole strategy is built around, so it is asserted directly.
    const prompt = buildCoverPrompt({ categoryName: 'AI' });
    expect(prompt.toLowerCase()).toMatch(/no text/);
    expect(prompt.toLowerCase()).toMatch(/no words/);
    expect(prompt.toLowerCase()).toMatch(/no letters/);
  });
});

describe('cover model', () => {
  it('is a single overridable constant, not a hard-coded assumption (SPEC §32)', () => {
    expect(COVER_MODEL).toMatch(/^@cf\//);
    // And a model that disappears must be a clear error, not a silent no-op.
    expect(coverSrc).toContain('MODEL_UNAVAILABLE');
  });
});

describe('cover as a fallback', () => {
  it('is preferred by the card only when there is no body image', () => {
    // The CASE keeps body ahead of cover in one subquery. If cover could win, adding a
    // generated image to an article with real figures would replace the author's picture.
    for (const src of [publicSrc, usersSrc]) {
      const body = code(src);
      expect(body).toMatch(/kind IN \('body', 'cover'\)/);
      expect(body).toMatch(/CASE m\.kind WHEN 'body' THEN 0 ELSE 1 END/);
    }
  });

  it('is a distinct media kind, declared in the schema (0012)', () => {
    // Not a flag on a body row: a generated image is not positioned in the article, and a
    // re-parse must never treat it as a figure the author inserted.
    expect(schema).toMatch(/kind TEXT NOT NULL DEFAULT 'body' CHECK \(kind IN \('body', 'avatar', 'cover'\)\)/);
  });
});

describe('the media reconciler understands a cover', () => {
  it('derives its key from the kind, not from position', () => {
    // This is the failure that costs the most and reports the least: without the branch,
    // reconcilePositions computes `media/000.<ext>` for the cover row, decides the real key
    // is stale, clears it, and sweepUnclaimedMedia deletes the bytes. No error is raised —
    // every generated cover just disappears on the next media run.
    const body = code(mediaSrc);
    expect(body).toMatch(/row\.kind === 'cover'/);
    expect(body).toMatch(/R2_PATHS\.cover\(/);
  });
});
