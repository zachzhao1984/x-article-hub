import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveLogin, type AuthDb } from '../../src/services/login';
import {
  pkceChallenge,
  safeRedirectPath,
  randomToken,
  callbackUri,
  PROVIDER_IDS,
  type OAuthProfile,
} from '../../src/lib/oauth';
import { readUserCookie, USER_COOKIE, SESSION_TTL_MS } from '../../src/lib/user-session';
import { providerConfig } from '../../src/lib/oauth';

/**
 * SPEC §43 — reader accounts.
 *
 * `resolveLogin` is exercised against a working fake rather than against source text,
 * because it is the only function here that decides *whose* account a completed sign-in
 * belongs to. The reason identity is keyed on (provider, provider_user_id) lives here too.
 *
 * That reason changed when X was removed, so the test that used to carry it is gone and
 * what replaced it is asserted below: Google verifies the addresses it holds, so "X hands
 * out an unverified address" no longer applies — but Google also lets an account holder
 * *change* their address, which reaches the same place by a different road.
 */

const NOW = 1_760_000_000_000;

interface FakeUser {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role: 'reader' | 'admin';
  created_at: number;
  updated_at: number;
}
interface FakeIdentity {
  provider: string;
  provider_user_id: string;
  user_id: string;
  username: string | null;
}
interface Statement {
  sql: string;
  args: unknown[];
}

class FakeDb implements AuthDb {
  users = new Map<string, FakeUser>();
  identities: FakeIdentity[] = [];
  /** Every batch, so a test can assert what was grouped into one transaction. */
  batches: Statement[][] = [];

  private apply(sql: string, args: unknown[]): FakeUser | null {
    const arg = (i: number) => args[i] as never;

    if (sql.includes('FROM user_identities i')) {
      const identity = this.identities.find(
        (i) => i.provider === arg(0) && i.provider_user_id === arg(1),
      );
      return identity ? (this.users.get(identity.user_id) ?? null) : null;
    }
    if (sql.includes('FROM users WHERE id =')) {
      return this.users.get(arg(0) as string) ?? null;
    }
    if (sql.includes('FROM users WHERE email =')) {
      for (const u of this.users.values()) if (u.email === arg(0)) return u;
      return null;
    }
    if (sql.startsWith('INSERT INTO users')) {
      const user: FakeUser = {
        id: arg(0),
        email: arg(1),
        display_name: arg(2),
        avatar_url: arg(3),
        role: 'reader',
        created_at: arg(4),
        updated_at: arg(4),
      };
      this.users.set(user.id, user);
      return user;
    }
    if (sql.startsWith('INSERT INTO user_identities')) {
      this.identities.push({
        provider: arg(0),
        provider_user_id: arg(1),
        user_id: arg(2),
        username: arg(3),
      });
      return null;
    }
    if (sql.startsWith('UPDATE users')) {
      const user = this.users.get(arg(0) as string);
      if (!user) return null;
      user.display_name = arg(1);
      // The SQL coalesces these, so null from the provider leaves the stored value alone.
      user.avatar_url = arg(2) ?? user.avatar_url;
      user.email = arg(3) ?? user.email;
      user.updated_at = arg(4);
      return user;
    }
    throw new Error(`fake db has no rule for: ${sql.slice(0, 70)}`);
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        sql,
        args,
        first: async () => this.apply(sql, args),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    };
  }

  async batch(statements: unknown[]): Promise<unknown> {
    const flat = statements as unknown as { sql: string; args: unknown[] }[];
    this.batches.push(flat);
    for (const s of flat) this.apply(s.sql, s.args);
    return [];
  }
}

function profile(over: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    id: 'g-sub-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    username: 'ada',
    avatarUrl: null,
    ...over,
  };
}

function seed(db: FakeDb, id: string, over: Partial<FakeUser> = {}, identity?: Partial<FakeIdentity>) {
  const user: FakeUser = {
    id,
    email: null,
    display_name: 'Existing',
    avatar_url: null,
    role: 'reader',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  db.users.set(id, user);
  if (identity) {
    db.identities.push({
      provider: identity.provider ?? 'google',
      provider_user_id: identity.provider_user_id ?? 'g-sub-1',
      user_id: id,
      username: identity.username ?? 'existing',
    });
  }
  return user;
}

/**
 * Run the real profile reader against a stubbed `fetch`, returning the profile it built.
 *
 * Used rather than an exported helper so the assertions below exercise the code that
 * actually runs at the callback. `email_verified` is the one field the whole
 * address-matching decision rests on, and testing it against a hand-built profile would
 * test the test's own understanding of it instead.
 */
async function googleProfileFromResponse(body: Record<string, unknown>): Promise<OAuthProfile> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const config = providerConfig(
      { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' } as unknown as Env,
      'google',
    );
    if (!config) throw new Error('provider config should exist with both secrets set');
    return await config.readProfile('token');
  } finally {
    globalThis.fetch = original;
  }
}

describe('SPEC §43 — who a completed sign-in belongs to', () => {
  it('returns the same account when a known identity comes back', async () => {
    const db = new FakeDb();
    seed(db, 'usr_existing', {}, { provider_user_id: 'g-sub-1' });

    const result = await resolveLogin(db, { provider: 'google', profile: profile(), now: NOW });

    expect(result.outcome).toBe('existing');
    expect(result.user.id).toBe('usr_existing');
    // No new identity row: a returning reader must not accumulate one per sign-in.
    expect(db.identities).toHaveLength(1);
  });

  it('refreshes a stale name on a returning reader', async () => {
    const db = new FakeDb();
    seed(db, 'usr_existing', { display_name: 'old name' }, { provider_user_id: 'g-sub-1' });

    const result = await resolveLogin(db, {
      provider: 'google',
      profile: profile({ displayName: 'new name' }),
      now: NOW,
    });

    expect(result.user.display_name).toBe('new name');
  });

  it('keeps a stored address when Google stops returning a verified one', async () => {
    // The reader drops `email` unless `email_verified` was true, so this is what a Google
    // account whose address failed re-verification looks like. Blanking the column would
    // break the lookup on the next sign-in and quietly mint a second account for the same
    // person, who would then see their own history missing.
    const db = new FakeDb();
    seed(db, 'usr_existing', { email: 'ada@example.com' }, { provider_user_id: 'g-sub-1' });

    await resolveLogin(db, { provider: 'google', profile: profile({ email: null }), now: NOW });

    expect(db.users.get('usr_existing')?.email).toBe('ada@example.com');
  });

  it('creates one account for a first-time reader, in a single batch', async () => {
    const db = new FakeDb();

    const result = await resolveLogin(db, { provider: 'google', profile: profile(), now: NOW });

    expect(result.outcome).toBe('created');
    expect(result.user.role).toBe('reader');
    expect(result.user.email).toBe('ada@example.com');
    // Two statements, one batch. An account row with no identity is a row nobody can sign
    // into, so a crash between two unbatched writes would be unrecoverable by hand.
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.identities[0]?.user_id).toBe(result.user.id);
  });

  it('links an unknown identity whose verified address is already on file', async () => {
    const db = new FakeDb();
    seed(db, 'usr_existing', { email: 'ada@example.com' }, { provider_user_id: 'g-sub-old' });

    const result = await resolveLogin(db, {
      provider: 'google',
      profile: profile({ id: 'g-sub-new' }),
      now: NOW,
    });

    expect(result.outcome).toBe('linked_by_email');
    expect(result.user.id).toBe('usr_existing');
    expect(db.identities.map((i) => i.provider_user_id).sort()).toEqual(['g-sub-new', 'g-sub-old']);
  });

  it('will not match on an address Google did not verify', async () => {
    // The single remaining reason identity is not keyed on email. Google *does* verify the
    // addresses it holds, so this is not about unverified addresses any more — it is that
    // an account holder can change the address on a Google account. Whoever holds it next
    // would otherwise inherit the identity, which is the same failure as before reached by
    // a different road.
    //
    // The profile reader drops `email` unless `email_verified` was true, so the input here
    // is what an address that failed re-verification looks like. `resolveLogin` trusts
    // `profile.email` precisely because of that, which is why this test goes through
    // `readProfile` rather than asserting the guard directly: a future refactor that
    // stopped nulling unverified addresses would break the real flow, not this.
    const db = new FakeDb();
    seed(db, 'usr_address_holder', { email: 'ada@example.com' }, { provider_user_id: 'g-other' });

    const unverified = await googleProfileFromResponse({
      sub: 'g-new',
      email: 'ada@example.com',
      email_verified: false,
    });
    expect(unverified.email, 'an unverified address must not reach the login flow').toBeNull();

    const result = await resolveLogin(db, { provider: 'google', profile: unverified, now: NOW });

    expect(result.outcome).toBe('created');
    expect(result.user.id).not.toBe('usr_address_holder');
  });

  describe('no linking to whoever is already signed in', () => {
    it('signs in as the identity rather than merging it into the current account', async () => {
      // This is the branch that had to go with X. With two providers it merged one
      // person's accounts; with one provider, an unknown identity arriving while signed in
      // as somebody else would be attached to that account — so two Google accounts become
      // one person without the second owner agreeing, and neither session would show
      // anything odd afterwards.
      const db = new FakeDb();
      seed(db, 'usr_signed_in', { email: 'grace@example.com' }, {
        provider_user_id: 'g-grace',
      });

      const result = await resolveLogin(db, {
        provider: 'google',
        profile: profile({ id: 'g-alan', email: 'alan@example.com' }),
        now: NOW,
      });

      expect(result.outcome).toBe('created');
      expect(result.user.id).not.toBe('usr_signed_in');
      // The signed-in account is untouched: no second identity attached to it.
      expect(db.identities.filter((i) => i.user_id === 'usr_signed_in')).toHaveLength(1);
    });

    it('never takes a link target from the request', () => {
      // The option is gone from the type, so a call site cannot pass one, and the column
      // holding it is gone from the schema.
      //
      // Asserted on the comment-stripped source of the whole module rather than on a
      // single branch: an earlier version of this test only checked the schema, and a
      // `db as any`-style re-introduction of a link path in the service passed it. The
      // regression that actually matters is the branch coming back, not the spelling.
      const login = readFileSync(resolve('src/services/login.ts'), 'utf8');
      const code = login.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, 'no code path may take a link target').not.toMatch(/linkToUserId|\blinkTo\b/);
      // Spelled with any other name for the same thing, which is the form the first
      // version of this test missed — it matched `linkToUserId` while a `mergeInto`
      // reintroduction went straight through. The property is "no column of the session is
      // read into the login decision", so this matches the idea rather than a spelling.
      expect(code, 'resolveLogin must not read the current session').not.toMatch(
        /as unknown as \{[^\}]*:\s*string[^\}]*\}|resolveSession|c\.req\.header\('cookie'\)/,
      );
      // And the signature itself, which is what makes a call site fail to compile.
      expect(login).toMatch(/export interface ResolveLoginOptions \{\s*provider: ProviderId;/);

      const migration = readFileSync(resolve('migrations/0009_google_only.sql'), 'utf8');
      const migrated = migration.replace(/--.*$/gm, '');
      expect(migrated).not.toMatch(/link_to_user_id/);
      // The rebuilt table has six columns, and one of them is not a link target.
      const rebuilt = migrated.match(/CREATE TABLE oauth_states_new \(([\s\S]*?)\);/)?.[1] ?? '';
      expect(rebuilt).not.toBe('');
      expect(rebuilt.split(',').filter((c) => /\w/.test(c))).toHaveLength(6);
    });
  });
});

describe('SPEC §43 — where a sign-in may send the reader afterwards', () => {
  it('keeps a site-relative path', () => {
    expect(safeRedirectPath('/article/some-slug')).toBe('/article/some-slug');
    expect(safeRedirectPath('/account')).toBe('/account');
  });

  it('refuses anything that could leave the site', () => {
    // `//host` and `/\host` are absolute URLs to a browser despite the leading slash,
    // which is why a "starts with /" check is not enough on its own.
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example',
      '/\\evil.example',
      '/a\\b',
      'javascript:alert(1)',
      'evil.example',
      '',
    ]) {
      expect(safeRedirectPath(hostile), `${hostile} should be refused`).toBe('/account');
    }
  });

  it('refuses a value carrying a header line break', () => {
    expect(safeRedirectPath('/account\r\nSet-Cookie: a=b')).toBe('/account');
  });

  it('trims a padded path rather than sending the padding into the header', () => {
    expect(safeRedirectPath('  /article/x  ')).toBe('/article/x');
  });

  it('falls back when there is nothing to go on', () => {
    expect(safeRedirectPath(null)).toBe('/account');
    expect(safeRedirectPath(undefined)).toBe('/account');
  });
});

describe('SPEC §43 — PKCE', () => {
  it('is BASE64URL(SHA256(verifier)) with no padding', async () => {
    // RFC 7636 §4.2, pinned to a value computed independently. If this changes, Google
    // rejects the exchange and the failure is opaque.
    const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });

  it('produces 256 bits of randomness as base64url', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Two draws in a row must not collide, or two readers could share a session.
    expect(randomToken(32)).not.toBe(token);
  });
});

describe('SPEC §43 — the session cookie', () => {
  it('reads its own cookie out of a header full of others', () => {
    const header = `xah_theme=dark; ${USER_COOKIE}=abc123; other=1`;
    expect(readUserCookie(header)).toBe('abc123');
  });

  it('treats an empty or malformed cookie as signed out', () => {
    expect(readUserCookie(`${USER_COOKIE}=`)).toBeNull();
    expect(readUserCookie(null)).toBeNull();
    expect(readUserCookie('xah_theme=dark')).toBeNull();
  });

  it('keeps a token containing "=" intact', () => {
    // base64url never produces "=", but a value that survives a round trip through a
    // mis-parsing proxy might, and splitting on every "=" would truncate it into a
    // different — also valid looking — token.
    expect(readUserCookie(`${USER_COOKIE}=ab=cd`)).toBe('ab=cd');
  });

  it('is Lax so it survives the redirect back from Google', () => {
    // `Strict` would withhold the cookie on the top-level navigation that ends the OAuth
    // round trip, so every sign-in would land back on /account still signed out with no
    // error anywhere. The admin cookie uses Strict and can: it is never the target of a
    // cross-site redirect.
    const session = readFileSync(resolve('src/lib/user-session.ts'), 'utf8');
    const cookie = session.match(/SameSite=\w+/g) ?? [];
    expect(cookie.length).toBeGreaterThan(0);
    for (const value of cookie) expect(value).toBe('SameSite=Lax');
  });

  it('never gives a session a shorter life than a month without saying so', () => {
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('SPEC §43 — Google is the only provider', () => {
  const oauth = readFileSync(resolve('src/lib/oauth.ts'), 'utf8');
  const auth = readFileSync(resolve('src/routes/auth.ts'), 'utf8');
  const env = readFileSync(resolve('src/env.ts'), 'utf8');
  const users = readFileSync(resolve('src/db/users.ts'), 'utf8');
  const migration9 = readFileSync(resolve('migrations/0009_google_only.sql'), 'utf8');
  const account = readFileSync(resolve('src/pages/account.astro'), 'utf8');
  const setup = readFileSync(resolve('SIGN-IN-SETUP.md'), 'utf8');
  const spec = readFileSync(resolve('x-article-curated-site-development-spec.md'), 'utf8');

  /** Source with its comments stripped, so an assertion is about code and not about prose. */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/--.*$/gm, '');

  it('offers Google and nothing else', () => {
    expect(PROVIDER_IDS).toEqual(['google']);
    expect(callbackUri({ SITE_ORIGIN: 'https://example.test' }, 'google')).toBe(
      'https://example.test/auth/google/callback',
    );
  });

  it('has no X credentials to configure anywhere', () => {
    expect(env).not.toMatch(/X_CLIENT/);
    expect(code(oauth)).not.toMatch(/X_CLIENT/);
    expect(setup).not.toMatch(/X_CLIENT_ID/);
    // And nothing still offers it: an endpoint that survived would be a 404 waiting for a
    // reader to walk into it.
    expect(account).not.toMatch(/Continue with X/);
  });

  it('narrows the schema to the one provider it can produce', () => {
    expect(migration9).toMatch(/CHECK \(provider IN \('google'\)\)/);
    // The column stays, because (provider, id) is the correct composite key and a future
    // provider should not have to rethink it — only the permitted set narrows.
    expect(users).toMatch(/provider: ProviderId/);
  });

  it('asks Google for the three scopes it needs and no more', () => {
    expect(oauth).toMatch(/scope: 'openid email profile'/);
    // All three are basic-profile scopes, which is what keeps this out of Google's
    // verification queue.
    expect(code(oauth)).not.toMatch(/drive\.|gmail|calendar|contacts|photos/);
  });

  it('does not request a refresh token it would never use', () => {
    // Matched against the comment-stripped source: the note explaining why it is absent
    // names it, which is exactly what a bare `.not.toContain` catches.
    expect(code(oauth)).not.toContain('offline.access');
  });

  it('sends client credentials in the body, which is what Google takes', () => {
    // The Basic-auth branch existed for X. It is gone rather than left reachable with one
    // value, because an unreachable branch that documents the wrong convention is worse
    // than no branch.
    expect(code(oauth)).not.toMatch(/tokenAuth/);
    expect(code(oauth)).not.toMatch(/Authorization.*Basic/);
    expect(oauth).toMatch(/client_id: config\.clientId/);
  });

  it('never stores the access token', () => {
    const route = readFileSync(resolve('src/routes/auth.ts'), 'utf8');
    // Held in a local, used for the profile read, then dropped — nothing calls Google
    // afterwards, so persisting it would be a credential with no use.
    expect(code(route)).not.toMatch(/INSERT INTO .*token|UPDATE .*token/);
  });

  it('derives the callback URL from the configured origin, not from the request', () => {
    expect(oauth).toMatch(/siteConfig\(env\)\.origin/);
    expect(code(oauth)).not.toMatch(/c\.req\.header\('host'\)|x-forwarded-host/);
  });

  it('requires the secrets to be present before offering a way in', () => {
    // A missing pair is a supported state: /account explains it rather than erroring.
    expect(oauth).toMatch(/if \(!env\.GOOGLE_CLIENT_ID \|\| !env\.GOOGLE_CLIENT_SECRET\) return null/);
  });

  it('spends an oauth state exactly once, in one statement', () => {
    // A SELECT followed by a DELETE would have a window in which two callbacks holding the
    // same `state` both read it and both proceed. D1 has no transaction across two
    // statements, so the read and the delete have to be the same statement.
    expect(users).toMatch(/DELETE FROM oauth_states WHERE state = \?1 AND expires_at > \?2 RETURNING/);
  });

  it('reads the session on the callback but not on the way in', () => {
    // Nothing about the caller's session is needed to start a flow any more, and reading
    // it there is a D1 read on the hot path into every sign-in for no reason.
    const start = auth.match(/auth\.get\('\/:provider\/start'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(start).not.toMatch(/resolveSession/);
  });

  it('tells the reader which address it keys on, and why', () => {
    expect(account).toMatch(/keyed on the id Google assigned/);
    // Stated on the page because it is the one claim a reader could otherwise not check,
    // and it is what explains why changing a Google address neither loses your history nor
    // hands your account to whoever picks the address up next.
    expect(account).toMatch(/the address belongs to you, the id does not move/);
    // §43.2 records the same reasoning, and its wording is deliberately not the one X
    // required — the section says so explicitly.
    expect(spec).toMatch(/Google 允许账号持有人修改自己账号的地址/);
    expect(spec).toMatch(/沿用旧理由会是错的/);
  });

  it('keeps every document agreeing that there is one provider', () => {
    expect(setup).not.toMatch(/developer\.x\.com/);
    expect(spec).not.toMatch(/43\.[0-9].*\bX 和 Google\b/);
  });
});

describe('SPEC §43 — the pieces this depends on', () => {
  const migration = readFileSync(resolve('migrations/0008_user_accounts.sql'), 'utf8');
  const users = readFileSync(resolve('src/db/users.ts'), 'utf8');
  const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
  const middleware = readFileSync(resolve('src/middleware.ts'), 'utf8');
  const adminAuth = readFileSync(resolve('src/middleware/admin-auth.ts'), 'utf8');
  const css = readFileSync(resolve('public/site.css'), 'utf8');

  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('keys identity on the provider, not on an address', () => {
    expect(migration).toMatch(/PRIMARY KEY \(provider, provider_user_id\)/);
    // A unique index on email would make the address an identity by the back door.
    expect(migration).not.toMatch(/UNIQUE[^\n]*email/i);
  });

  it('aliases both created_at columns in the session join', () => {
    // `user_sessions` and `users` each have one. Unaliased, the second silently wins and
    // `session.created_at` becomes the date the account was created — plausible enough to
    // pass a glance and wrong in every session audit.
    expect(users).toMatch(/s\.created_at\s+AS session_created_at/);
    expect(users).toMatch(/u\.created_at\s+AS user_created_at/);
  });

  it('takes the admin role from the row, not from the cookie', () => {
    expect(adminAuth).toMatch(/session\.user\.role !== 'admin'/);
    expect(code(adminAuth)).not.toMatch(/role[^=]*=.*cookie|cookie.*role/);
  });

  it('keeps the token as a way in, checked before the account', () => {
    // Scoped to `requireAdmin`'s own body. An earlier version of this searched the whole
    // file, where `indexOf('verifySessionCookie')` finds the *function declaration* above
    // it rather than the call — so reordering the checks did not fail the test. It passed
    // while the thing it claims to pin was broken.
    const body = /export function requireAdmin\(\) \{([\s\S]*?)\n\}/.exec(code(adminAuth))?.[1] ?? '';
    expect(body, 'cannot locate requireAdmin').not.toBe('');

    const identity = body.indexOf('resolveIdentity(c)');
    const token = body.indexOf('verifySessionCookie(c,');
    const account = body.indexOf('resolveAccountIdentity(c)');

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(token).toBeGreaterThan(identity);
    // A Google consent screen somebody disabled must not be able to lock the operator out
    // of their own site, and a mistake in the account branch must leave the token working.
    expect(account).toBeGreaterThan(token);
  });

  it('keeps the reading pages out of the session', () => {
    // The cache story: the header is identical HTML for everyone, so `/` at s-maxage=60 and
    // `/article/*` at 3600 stay shareable. If the header read the session, one reader's
    // name would be baked into a cached document and served to everyone.
    expect(code(header)).not.toMatch(/resolveSession|user_session/);
    expect(header).toMatch(/data-auth-slot/);
    expect(header).toMatch(/fetch\('\/auth\/me'/);
    expect(middleware).toMatch(/path\.startsWith\('\/auth'\)/);
    expect(middleware).toMatch(/path\.startsWith\('\/account'\)/);
  });

  it('writes a display name with textContent, never innerHTML', () => {
    const script = header.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(script).toContain('textContent');
    expect(script).not.toContain('innerHTML');
  });

  it('bounds the account slot so it cannot squeeze the nav out of the header', () => {
    expect(css).toMatch(/\.auth-slot \{[^}]*flex: none/);
    expect(css).toMatch(/\.auth-slot \{[^}]*max-width/);
    expect(css).toMatch(/\.auth-name \{[^}]*text-overflow: ellipsis/);

    // The slot narrows at the same width the nav labels do. If it narrowed later — or
    // never — the two would shrink independently and the nav, which is the part that must
    // not lose content, would be the one paying for it.
    const labelShrink = /@media \(max-width: (\d+)px\) \{[^}]*\.nav-item \{[^}]*font-size: 13px/.exec(
      css,
    )?.[1];
    const slotShrink = /@media \(max-width: (\d+)px\) \{\s*\.auth-slot \{ max-width/.exec(css)?.[1];
    expect(labelShrink, 'cannot find where the nav labels shrink').toBeDefined();
    expect(slotShrink, "the slot must narrow at the nav's threshold").toBe(labelShrink);
  });
});