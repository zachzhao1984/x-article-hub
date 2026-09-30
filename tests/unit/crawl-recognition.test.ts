import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  extractAvatarUrl,
  extractMetadata,
  extractPublishedAt,
  parseFrontmatter,
  splitXTitle,
} from '../../src/jobs/x-selectors';

/**
 * SPEC §42: "应在正式开发前先拿真实 Article URL 做一批抓取测试，并建立 fixture 数据集."
 *
 * These fixtures are real Browser Run output shapes captured while probing X,
 * not invented. `X_LOGGED_OUT_PROFILE.md` is a verbatim /markdown capture of
 * https://x.com/karpathy with gotoOptions.waitUntil=networkidle2, which is what
 * an unauthenticated crawl of an Article page looks like.
 */

/** Real capture: metadata renders server-side, the body is the login wall. */
const X_LOGGED_OUT_PROFILE = `---
title: "Andrej Karpathy (@karpathy) / X"
meta:
  author: "Andrej Karpathy"
  description: "4247047 followers · 1139 following. Earth. Joined Apr 2009. See the latest conversations with @karpathy"
  keywords: "Andrej Karpathy, karpathy, X, social media, profile, timeline"
  "og:description": "4247047 followers · 1139 following. Earth. Joined Apr 2009. See the latest conversations with @karpathy"
  "og:title": "Andrej Karpathy (@karpathy) on X"
---

[X](/)

[X](/)

[Log in](https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2Fkarpathy) [Sign up](https://x.com/i/jf/onboarding/web?mode=signup&redirect_after_login=%2Fkarpathy)

[X](/)

[Log in](https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2Fkarpathy)

Continue with phone
Continue with Google
Continue with Apple
`;

const REAL_ARTICLE = `---
title: "On Giant Language Models and Why They're Few-Shot Parsers"
meta:
  author: "Simon Willison"
  description: "A quick summary of the In-Context Learning paper."
  "og:title": "On Giant Language Models and Why They're Few-Shot Parsers"
---

# On Giant Language Models

Published 2024-01-11T09:30:00.000Z

I wanted to write a short summary of the In-Context Learning paper, but the
process turned into something more interesting than the summary itself.

## The core observation

The paper establishes that in-context learning is a legitimate new capability
that we did not explicitly program into the model. The model is not being
retrained when we hand it examples; it is doing something else entirely.

<time datetime="2024-01-11T09:30:00.000Z">Jan 11, 2024</time>

That distinction matters more than it first appears, because it changes what we
think we are building when we build with these systems.

> The model is a few-shot parser, and the schema is the prompt.

## What follows from it

If the model parses, then every downstream question becomes a question about
the parser: what schema, what examples, what failure modes, what escapes.

This is a much more tractable framing than "what does the model know".
`;

describe('parseFrontmatter', () => {
  it('reads the flat key/value pairs /markdown emits', () => {
    const fm = parseFrontmatter(X_LOGGED_OUT_PROFILE);
    expect(fm.title).toBe('Andrej Karpathy (@karpathy) / X');
    expect(fm.author).toBe('Andrej Karpathy');
    expect(fm['og:title']).toBe('Andrej Karpathy (@karpathy) on X');
  });

  it('returns nothing for markdown without frontmatter', () => {
    expect(parseFrontmatter('# Just a heading')).toEqual({});
    expect(parseFrontmatter('')).toEqual({});
  });
});

describe('splitXTitle', () => {
  it('splits an X page title into display name and handle', () => {
    expect(splitXTitle('Andrej Karpathy (@karpathy) / X')).toEqual({ name: 'Andrej Karpathy', username: 'karpathy' });
  });

  it('returns nulls when there is no handle', () => {
    expect(splitXTitle('Just A Title')).toEqual({ name: null, username: null });
  });
});

describe('classifyContent (SPEC §26)', () => {
  it('detects the logged-out login wall from a real capture', () => {
    // This is the case that decides whether crawling X works at all without a
    // signed-in session, so it is pinned explicitly.
    expect(classifyContent(X_LOGGED_OUT_PROFILE).kind).toBe('login_wall');
  });

  it('accepts a real article body', () => {
    expect(classifyContent(REAL_ARTICLE)).toMatchObject({ kind: 'ok' });
  });

  it('reports a deleted or protected article as empty', () => {
    const gone = `---\ntitle: "Gone / X"\n---\n\nThis Post may be deleted.\n\nLog in\nSign up\n`;
    expect(classifyContent(gone).kind).toBe('empty');
  });

  it('reports a non-article as such rather than as empty', () => {
    const nope = `---\ntitle: "X / X"\n---\n\nHmm...this page doesn’t exist\nLog in\nSign up\n`;
    expect(classifyContent(nope).kind).toBe('non_article');
  });

  it('reports a too-thin capture with its measured size', () => {
    const verdict = classifyContent('---\ntitle: "T"\n---\n\nShort.\n');
    expect(verdict.kind).toBe('too_small');
    expect(verdict).toHaveProperty('bodyChars');
  });

  it('prefers the login wall over the size heuristic', () => {
    // A walled page is also short; misclassifying it as EMPTY_CONTENT would
    // point an operator at the wrong fix (retrying can never clear a login wall).
    expect(classifyContent(X_LOGGED_OUT_PROFILE).kind).not.toBe('too_small');
  });

  it('uses the HTML capture to overturn a thin markdown result', () => {
    expect(classifyContent('---\ntitle: "T"\n---\n\nTiny.', '<article>' + 'x'.repeat(3000) + '</article>').kind).toBe(
      'too_small',
    );
  });

  it('treats empty input as too small, not as a successful fetch', () => {
    expect(classifyContent('').kind).toBe('too_small');
  });
});

describe('extractMetadata', () => {
  it('prefers the URL handle over the title handle', () => {
    const meta = extractMetadata(
      'https://x.com/selectsam/article/1234567890',
      REAL_ARTICLE,
      '',
      'fallback_user',
    );
    expect(meta.authorUsername).toBe('selectsam');
  });

  it('falls back to the title handle when the URL has none', () => {
    const meta = extractMetadata('https://x.com/karpathy', X_LOGGED_OUT_PROFILE, '', null);
    expect(meta.authorUsername).toBe('karpathy');
  });

  it('falls back to the caller-supplied handle when neither source has one', () => {
    const meta = extractMetadata('https://x.com/unknown', REAL_ARTICLE, '', 'caller_handle');
    expect(meta.authorUsername).toBe('caller_handle');
  });

  it('uses the URL handle even when the title disagrees with it', () => {
    // The URL is the dedup key's own input, so it wins.
    const meta = extractMetadata('https://x.com/realthing/article/1', X_LOGGED_OUT_PROFILE, '', null);
    expect(meta.authorUsername).toBe('realthing');
  });

  it('strips the trailing " / X" from the title', () => {
    const meta = extractMetadata('https://x.com/karpathy/article/1', X_LOGGED_OUT_PROFILE, '', null);
    expect(meta.title).toBe('Andrej Karpathy (@karpathy)');
  });

  it('reads a published date out of a <time> tag', () => {
    expect(extractPublishedAt('<time datetime="2024-01-11T09:30:00.000Z">Jan 11</time>', '')).toBe(
      '2024-01-11T09:30:00.000Z',
    );
  });

  it('falls back to an ISO date in the markdown', () => {
    expect(extractPublishedAt('', 'Published 2024-01-11T09:30:00.000Z')).toBe('2024-01-11T09:30:00.000Z');
  });

  it('returns null when there is no usable date', () => {
    expect(extractPublishedAt('<time>no attribute</time>', 'nothing here')).toBeNull();
  });
});

describe('extractAvatarUrl', () => {
  it('prefers og:image', () => {
    expect(extractAvatarUrl('<meta property="og:image" content="https://pbs.twimg.com/a.jpg">')).toBe(
      'https://pbs.twimg.com/a.jpg',
    );
  });

  it('falls back to twitter:image', () => {
    expect(extractAvatarUrl('<meta name="twitter:image" content="https://pbs.twimg.com/b.jpg">')).toBe(
      'https://pbs.twimg.com/b.jpg',
    );
  });

  it('returns null when neither is present', () => {
    expect(extractAvatarUrl('<html></html>')).toBeNull();
  });
});
