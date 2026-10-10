import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SPEC §43 — saved articles.
 *
 * Three things here are easy to get wrong in ways that do not announce themselves.
 *
 * The save control cannot be server-rendered: the article page is served `s-maxage=3600`, so
 * anything it rendered about the reader would be cached and handed to everybody — and a save
 * button showing someone else's state is worse than no button.
 *
 * The two save controls on the page have to agree. Rendering them independently is how one of
 * them ends up stale, which reads as the save not having worked.
 *
 * And the primary key is `(user_id, article_id)`, not a generated id, which is what makes a
 * double-submit idempotent rather than a UNIQUE violation.
 */

const migration = readFileSync(resolve('migrations/0011_saved_articles.sql'), 'utf8');
const users = readFileSync(resolve('src/db/users.ts'), 'utf8');
const auth = readFileSync(resolve('src/routes/auth.ts'), 'utf8');
const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
const article = readFileSync(resolve('src/pages/article/[slug].astro'), 'utf8');
const savedPage = readFileSync(resolve('src/pages/saved.astro'), 'utf8');
const middleware = readFileSync(resolve('src/middleware.ts'), 'utf8');
const siteCss = readFileSync(resolve('public/site.css'), 'utf8');

/** Source with its comments stripped, so an assertion is about code and not about prose. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*--.*$/gm, '');

describe('the saved_articles table', () => {
  it('keys on the pair, not on a generated id', () => {
    // Saving is a yes/no fact about (reader, article). A surrogate key would let the same
    // reader save the same article twice, and the only defence would be a check in
    // application code that some later path can forget.
    expect(migration).toMatch(/PRIMARY KEY \(user_id, article_id\)/);
    // And that is what the idempotent insert relies on.
    expect(users).toMatch(/ON CONFLICT \(user_id, article_id\) DO NOTHING/);
  });

  it('cascades from both sides, because both deletes are reachable', () => {
    // Deleting an article is a button in the admin; deleting an account is the same kind of
    // operation. Either one leaving a saved row behind produces a list that joins to nothing.
    expect(migration).toMatch(/user_id\s+TEXT NOT NULL REFERENCES users \(id\) ON DELETE CASCADE/);
    expect(migration).toMatch(/article_id TEXT NOT NULL REFERENCES articles \(id\) ON DELETE CASCADE/);
  });

  it('stores the raw save row and not a derived list', () => {
    // No denormalised title or author, so a retitled article cannot show a stale name here.
    const columns = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf(');'));
    expect(columns).not.toMatch(/title|slug|author/);
    expect(columns).toMatch(/saved_at\s+INTEGER NOT NULL/);
  });
});

describe('the save API', () => {
  it('is two explicit endpoints, so a double-submit is idempotent', () => {
    // A single toggle would have to infer the intent from the request, and "flip it" is a
    // request whose outcome depends on state the client read earlier — so two taps racing
    // each other can un-save what the first one saved.
    expect(auth).toMatch(/auth\.post\('\/saved\/:articleId'/);
    expect(auth).toMatch(/auth\.delete\('\/saved\/:articleId'/);
  });

  it('refuses to save an article a reader could not read', () => {
    // Otherwise a reader can save any string as an article id and the list gains a row that
    // no query joins to — invisible, and impossible to clean up from the UI.
    const post = auth.slice(
      auth.indexOf("auth.post('/saved/:articleId'"),
      auth.indexOf("auth.delete('/saved/:articleId'"),
    );
    expect(post).toMatch(/status = 'published' AND display_mode != 'takedown'/);
    expect(post).toMatch(/404/);
  });

  it('answers 401 when signed out rather than reporting state', () => {
    // Unlike `/auth/me`, which answers `{ user: null }`: this is an action, and the caller
    // has to do something different rather than pick one of two shapes to render.
    expect(auth).toMatch(/UNAUTHORIZED[\s\S]{0,80}401/);
  });

  it('never caches any of the three responses', () => {
    // Every one of them is per-reader.
    const block = auth.slice(auth.indexOf("auth.post('/saved/:articleId'"));
    const noStore = block.match(/'Cache-Control': 'no-store'/g) ?? [];
    expect(noStore.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the article page control', () => {
  it('is rendered empty and filled client-side', () => {
    // The page is `s-maxage=3600`. A server-rendered save state would be baked into a cached
    // document and shown to every reader who got that copy.
    expect(article).toMatch(/<span class="save-slot" data-save-slot data-article-id=\{article\.id\}>/);
    // The slot ships with no children — no button, no text.
    expect(article).not.toMatch(/data-save-slot[^>]*>\s*<button/);
    expect(article).toMatch(/fetch\('\/auth\/saved\/' \+ encodeURIComponent\(articleId\)/);
  });

  it('has one at the top and one at the bottom', () => {
    // The decision to keep something is made either before reading or after, and the two
    // are far enough apart that one control would not serve both.
    const slots = article.match(/<span class="save-slot" data-save-slot/g) ?? [];
    expect(slots, 'top and bottom').toHaveLength(2);
    // And they are in different places: one in the crumbs nav, one in the footer.
    const crumbs = article.slice(article.indexOf('article-crumbs'), article.indexOf('</nav>'));
    expect(crumbs).toMatch(/data-save-slot/);
    const foot = article.slice(article.indexOf('<footer'), article.indexOf('</footer>'));
    expect(foot).toMatch(/data-save-slot/);
  });

  it('renders both from one call, so they cannot disagree', () => {
    // A second copy of the render logic is how one control ends up showing the old state
    // after the other is pressed.
    expect(article).toMatch(/querySelectorAll\('\[data-save-slot\]'\)/);
    const renders = article.match(/slot\.replaceChildren\(button\)/g) ?? [];
    // One call site, inside the loop, so the loop is what makes them agree.
    expect(renders).toHaveLength(1);
    expect(article).toMatch(/for \(var i = 0; i < slots\.length; i\+\+\)/);
  });

  it('draws nothing at all for a signed-out reader', () => {
    // A save button that cannot save is a worse invitation than no button, and the header
    // already offers sign-in.
    expect(article).toMatch(/if \(!state\.authenticated\)[\s\S]{0,120}continue/);
  });

  it('settles on what the server recorded, not on what it hoped', () => {
    // Saving twice must leave both buttons reading saved rather than one flipped back.
    expect(article).toMatch(/saved: body\.saved === true/);
  });

  it('sends a reader to sign in when the session has gone', () => {
    // A silent failure would look like a broken button.
    expect(article).toMatch(/res\.status === 401/);
    expect(article).toMatch(/window\.location\.href = '\/account\?next='/);
  });
});

describe('the account menu', () => {
  it('replaced the link with a button', () => {
    // An anchor that does not navigate is a lie to a screen reader, and it breaks
    // middle-click and "open in new tab" for a control that used to support them.
    expect(header).toMatch(/document\.createElement\('button'\)/);
    expect(header).toMatch(/className = 'nav-item auth-link auth-trigger'/);
    expect(header).toMatch(/aria-haspopup/);
  });

  it('lists Saved and Account, as links', () => {
    expect(header).toMatch(/savedLink\.href = '\/saved'/);
    expect(header).toMatch(/savedLink\.textContent = 'Saved'/);
    expect(header).toMatch(/accountLink\.href = '\/account'/);
    expect(header).toMatch(/accountLink\.textContent = 'Account'/);
  });

  it('can be closed by keyboard, not only by mouse', () => {
    expect(header).toMatch(/event\.key === 'Escape'/);
    expect(header).toMatch(/button\.focus\(\)/);
  });

  it('is positioned so it cannot run off the screen', () => {
    // Anchored to the slot with `position: relative`, and right-aligned because the slot sits
    // at the right edge of the header.
    expect(siteCss).toMatch(/\.auth-slot \{[^}]*position: relative/);
    expect(siteCss).toMatch(/\.auth-menu \{[^}]*position: absolute/);
    expect(siteCss).toMatch(/\.auth-menu \{[^}]*right: 0/);
  });
});

describe('the /saved page', () => {
  it('sends a signed-out reader to sign in rather than showing an empty list', () => {
    // An empty list is indistinguishable from a working page with nothing saved, so the
    // reader would never learn they were not signed in.
    expect(savedPage).toMatch(/if \(!session\)/);
    expect(savedPage).toMatch(/Astro\.redirect\(`\/account\?next=/);
  });

  it('is never cached, because it is somebody\'s private list', () => {
    expect(middleware).toMatch(/path\.startsWith\('\/saved'\)/);
    // And on the same side of the branch as /account, not the TTL table.
    const noStore = middleware.slice(middleware.indexOf('startsWith(\'/admin\')'), middleware.indexOf("const response = await next()"));
    expect(noStore).toMatch(/'\/saved'/);
  });

  it('joins the article and honours its visibility', () => {
    // A saved article that an editor has since taken down must not reappear through a join
    // that forgot to check — the list has to agree with every other surface.
    const list = users.slice(users.indexOf('export function listSavedArticles'));
    expect(list).toMatch(/JOIN articles a ON a\.id = s\.article_id/);
    expect(list).toMatch(/a\.status = 'published'/);
    expect(list).toMatch(/a\.display_mode != 'takedown'/);
  });

  it('does not claim a reading time it does not know', () => {
    // `ArticleCard` floors the division at 1, so a missing word count renders "1 min read"
    // on every card — a wrong number rather than a missing one, which is harder to notice.
    expect(users).toMatch(/a\.word_count/);
    expect(savedPage).toMatch(/word_count: a\.word_count/);
  });

  it('says why the list can be shorter than what was saved', () => {
    expect(savedPage).toMatch(/can be shorter than the number you saved/);
  });
});
