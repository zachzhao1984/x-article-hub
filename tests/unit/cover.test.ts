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
  it('puts the title and a summary into the prompt', () => {
    // The whole point of deriving the prompt is that the image relates to the article. A
    // prompt that dropped the title would generate something unrelated and still "work".
    const prompt = buildCoverPrompt({
      title: 'How LLM inference actually works',
      excerpt: null,
      aiSummary: null,
      editorSummary: 'A tour of prefill and decode.',
      categoryName: 'AI',
    });
    expect(prompt).toContain('How LLM inference actually works');
    expect(prompt).toContain('A tour of prefill and decode.');
    expect(prompt).toContain('AI');
  });

  it('prefers an editor summary over the AI summary over the excerpt', () => {
    // Most-edited wins: an editor who rewrote the summary expects that to be what the image
    // is about, not the machine's first pass.
    const all = buildCoverPrompt({
      title: 'T',
      excerpt: 'EXCERPT',
      aiSummary: 'AI_SUMMARY',
      editorSummary: 'EDITOR_SUMMARY',
      categoryName: null,
    });
    expect(all).toContain('EDITOR_SUMMARY');
    expect(all).not.toContain('AI_SUMMARY');

    const ai = buildCoverPrompt({
      title: 'T',
      excerpt: 'EXCERPT',
      aiSummary: 'AI_SUMMARY',
      editorSummary: null,
      categoryName: null,
    });
    expect(ai).toContain('AI_SUMMARY');

    const ex = buildCoverPrompt({ title: 'T', excerpt: 'EXCERPT', aiSummary: null, editorSummary: null, categoryName: null });
    expect(ex).toContain('EXCERPT');
  });

  it('always asks for no text, because a model that writes words produces garbage on a cover', () => {
    const prompt = buildCoverPrompt({ title: 'T', excerpt: null, aiSummary: null, editorSummary: null, categoryName: null });
    expect(prompt.toLowerCase()).toMatch(/no text|no words|no letters/);
  });

  it('caps the prompt length (SPEC §13.4)', () => {
    // A very long summary must not grow the model input without bound.
    const huge = 'x'.repeat(5000);
    const prompt = buildCoverPrompt({ title: huge, excerpt: null, aiSummary: null, editorSummary: huge, categoryName: null });
    expect(prompt.length).toBeLessThanOrEqual(400);
  });

  it('survives an article with nothing but a title', () => {
    // A freshly imported article has no summary at all; the prompt still has to be usable.
    const prompt = buildCoverPrompt({ title: 'Only a title', excerpt: null, aiSummary: null, editorSummary: null, categoryName: null });
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Only a title');
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
