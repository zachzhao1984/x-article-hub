import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveLogin, type AuthDb } from '../../src/services/login';
import { pkceChallenge, safeRedirectPath, randomToken, callbackUri, PROVIDER_IDS } from '../../src/lib/oauth';
import { readUserCookie, USER_COOKIE, SESSION_TTL_MS } from '../../src/lib/user-session';
import type { OAuthProfile, ProviderId } from '../../src/lib/oauth';

/**
 * SPEC §43 — reader accounts.
 *
 * `resolveLogin` is exercised against a working fake rather than against source text,
 * because it is the only function here that decides *whose* account a completed sign-in
 * belongs to. Every branch below is a different answer to "is this the person who came
 * back, someone arriving for the first time, or an account takeover wearing a stolen
 * code", and the reason the module takes a narrow `AuthDb` instead of `D1Database` is
 * so that this file can hold a table in memory and ask those questions for real.
 *
 * The fake matches on SQL substrings. That is loose, and deliberately: it is not a test
 * of the SQL, it is a harness that lets the branching be tested. The SQL itself is pinned
 * separately, at the bottom, by the assertions that matter to security.
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
    id: 'prov-1',
    email: null,
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
      provider: identity.provider ?? 'x',
      provider_user_id: identity.provider_user_id ?? 'prov-1',
      user_id: id,
      username: identity.username ?? 'existing',
    });
  }
  return user;
}

describe('SPEC §43 — who a completed sign-in belongs to', () => {
  it('returns the same account when a known identity comes back', async () => {
    const db = new FakeDb();
    seed(db, 'usr_existing', {}, { provider: 'x', provider_user_id: 'prov-1' });

    const result = await resolveLogin(db, { provider: 'x', profile: profile(), now: NOW });

    expect(result.outcome).toBe('existing');
    expect(result.user.id).toBe('usr_existing');
    // No new identity row: a returning reader must not accumulate one per sign-in.
    expect(db.identities).toHaveLength(1);
  });

  it('refreshes a stale name on a returning reader', async () => {
    const db = new FakeDb();
    seed(db, 'usr_existing', { display_name: 'old name' }, { provider: 'x', provider_user_id: 'prov-1' });

    const result = await resolveLogin(db, {
      provider: 'x',
      profile: profile({ displayName: 'new name' }),
      now: NOW,
    });

    expect(result.user.display_name).toBe('new name');
  });

  it('keeps a stored address when the provider stops returning one', async () => {
    // The Google reader returns null when `email_verified` is absent, and X never
    // returns one at all. Blanking the column on either would break the email lookup on
    // the next Google sign-in and quietly mint a second account.
    const db = new FakeDb();
    seed(db, 'usr_existing', { email: 'ada@example.com' }, {
      provider: 'google',
      provider_user_id: 'g-1',
    });

    await resolveLogin(db, { provider: 'google', profile: profile({ email: null }), now: NOW });

    expect(db.users.get('usr_existing')?.email).toBe('ada@example.com');
  });

  it('creates one account for a first-time reader, in a single batch', async () => {
    const db = new FakeDb();

    const result = await resolveLogin(db, { provider: 'x', profile: profile(), now: NOW });

    expect(result.outcome).toBe('created');
    expect(result.user.role).toBe('reader');
    // Two statements, one batch. An account row with no identity is a row nobody can sign
    // into, so a crash between two unbatched writes would be unrecoverable by hand.
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.identities[0]?.user_id).toBe(result.user.id);
  });

  describe('linking a second provider while signed in', () => {
    it('attaches the new identity to the current account', async () => {
      const db = new FakeDb();
      seed(db, 'usr_current');

      const result = await resolveLogin(db, {
        provider: 'google',
        profile: profile({ id: 'g-9', email: null }),
        linkToUserId: 'usr_current',
        now: NOW,
      });

      expect(result.outcome).toBe('linked_to_session');
      expect(result.user.id).toBe('usr_current');
      expect(db.identities.map((i) => i.provider)).toEqual(['google']);
    });

    it('does not steal an identity that already belongs to someone else', async () => {
      // The provider just proved this person is `usr_theirs`. A stale session for
      // `usr_mine` is weaker evidence than that, so the identity wins and the mismatch is
      // logged rather than resolved by overwriting somebody's account.
      const db = new FakeDb();
      seed(db, 'usr_mine');
      seed(db, 'usr_theirs', {}, { provider: 'x', provider_user_id: 'prov-1' });

      const result = await resolveLogin(db, {
        provider: 'x',
        profile: profile(),
        linkToUserId: 'usr_mine',
        now: NOW,
      });

      expect(result.user.id).toBe('usr_theirs');
      expect(db.identities).toHaveLength(1);
      expect(db.identities[0]?.user_id).toBe('usr_theirs');
    });

    it('falls through when the session row has gone', async () => {
      const db = new FakeDb();

      const result = await resolveLogin(db, {
        provider: 'x',
        profile: profile(),
        linkToUserId: 'usr_signed_out_elsewhere',
        now: NOW,
      });

      expect(result.outcome).toBe('created');
    });
  });

  describe('matching by address', () => {
    it('links a Google identity to an account already holding that address', async () => {
      const db = new FakeDb();
      seed(db, 'usr_existing', { email: 'ada@example.com' }, {
        provider: 'x',
        provider_user_id: 'x-77',
      });

      const result = await resolveLogin(db, {
        provider: 'google',
        profile: profile({ id: 'g-1', email: 'ada@example.com' }),
        now: NOW,
      });

      expect(result.outcome).toBe('linked_by_email');
      expect(result.user.id).toBe('usr_existing');
      expect(db.identities.map((i) => i.provider).sort()).toEqual(['google', 'x']);
    });

    it('never matches by address for X', async () => {
      // The whole reason `user_identities` is keyed on (provider, provider_user_id).
      // X hands out an address it has never verified and lets an account holder set an
      // arbitrary one, so matching on it would let anyone who sets `ada@example.com` on
      // an X account sign in as the Google holder of that address.
      const db = new FakeDb();
      seed(db, 'usr_google_holder', { email: 'ada@example.com' }, {
        provider: 'google',
        provider_user_id: 'g-1',
      });

      const result = await resolveLogin(db, {
        provider: 'x',
        // Defence in depth: the reader drops email entirely for X, but the branch is
        // keyed on the provider, not on the value being absent.
        profile: profile({ id: 'x-attacker', email: 'ada@example.com' }),
        now: NOW,
      });

      expect(result.outcome).toBe('created');
      expect(result.user.id).not.toBe('usr_google_holder');
    });

    it('makes a separate account per provider when nothing links them', async () => {
      // Stated as a test because it looks like a bug and is not: merging across
      // providers on an unverified address is the vulnerability above.
      const db = new FakeDb();
      seed(db, 'usr_x', {}, { provider: 'x', provider_user_id: 'x-1' });

      const result = await resolveLogin(db, {
        provider: 'google',
        profile: profile({ id: 'g-1', email: null }),
        now: NOW,
      });

      expect(result.outcome).toBe('created');
      expect(db.users.size).toBe(2);
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
    // RFC 7636 §4.2, pinned to a value computed independently. If this changes, every
    // provider rejects the exchange and the failure is opaque.
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

  it('is Lax so it survives the redirect back from the provider', () => {
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

describe('SPEC §43 — the pieces this depends on', () => {
  const migration = readFileSync(resolve('migrations/0008_user_accounts.sql'), 'utf8');
  const users = readFileSync(resolve('src/db/users.ts'), 'utf8');
  const oauth = readFileSync(resolve('src/lib/oauth.ts'), 'utf8');
  const header = readFileSync(resolve('src/components/SiteHeader.astro'), 'utf8');
  const middleware = readFileSync(resolve('src/middleware.ts'), 'utf8');
  const adminAuth = readFileSync(resolve('src/middleware/admin-auth.ts'), 'utf8');
  const css = readFileSync(resolve('public/site.css'), 'utf8');

  /** Source with its comments stripped, so an assertion is about code and not about prose. */
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('keys identity on the provider, not on an address', () => {
    expect(migration).toMatch(/PRIMARY KEY \(provider, provider_user_id\)/);
    // A unique index on email would make the address an identity by the back door.
    expect(migration).not.toMatch(/UNIQUE[^\n]*email/i);
    expect(code(migration)).not.toMatch(/REFERENCES users \(id\)[^\n]*ON DELETE SET NULL[\s\S]*email/);
  });

  it('spends an oauth state exactly once, in one statement', () => {
    // A SELECT followed by a DELETE would have a window in which two callbacks holding
    // the same `state` both read it and both proceed. D1 has no transaction across two
    // statements, so the read and the delete have to be the same statement.
    expect(users).toMatch(/DELETE FROM oauth_states WHERE state = \?1 AND expires_at > \?2 RETURNING/);
  });

  it('aliases both created_at columns in the session join', () => {
    // `user_sessions` and `users` each have one. Unaliased, the second silently wins and
    // `session.created_at` becomes the date the account was created — plausible enough
    // to pass a glance and wrong in every session audit.
    expect(users).toMatch(/s\.created_at\s+AS session_created_at/);
    expect(users).toMatch(/u\.created_at\s+AS user_created_at/);
  });

  it('takes the admin role from the row, not from the cookie', () => {
    expect(adminAuth).toMatch(/session\.user\.role !== 'admin'/);
    // A cookie carrying the role would be a value anyone can edit in their own browser.
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
    // An X outage or a disabled Google consent screen must not be able to lock the
    // operator out of their own site, and a mistake in the account branch must leave the
    // token working.
    expect(account).toBeGreaterThan(token);
  });

  it('derives the callback URL from the configured origin, not from the request', () => {
    // Both providers compare this string byte for byte. Assembling it from a Host header
    // would be an open redirect with an authorization code attached.
    expect(oauth).toMatch(/siteConfig\(env\)\.origin/);
    expect(code(oauth)).not.toMatch(/c\.req\.header\('host'\)|x-forwarded-host/);
  });

  it('never stores a provider access token', () => {
    // There is nothing to call after the profile is read, so persisting one would be a
    // credential with no use and a revocation problem.
    const login = readFileSync(resolve('src/routes/auth.ts'), 'utf8');
    expect(code(login)).not.toMatch(/INSERT INTO .*token|UPDATE .*token/);
  });

  it('keeps the reading pages out of the session', () => {
    // The cache story: the header is identical HTML for everyone, so `/` at s-maxage=60
    // and `/article/*` at 3600 stay shareable. If the header read the session, one
    // reader's name would be baked into a cached document and served to everyone.
    expect(code(header)).not.toMatch(/resolveSession|user_session/);
    expect(header).toMatch(/data-auth-slot/);
    // …and the identity arrives on a request that is never cached.
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
    // The nav was measured to fit at every width from 640px up. `.nav` is `flex: 1`, so
    // an unbounded display name would eat that headroom and start the nav scrolling.
    expect(css).toMatch(/\.auth-slot \{[^}]*flex: none/);
    expect(css).toMatch(/\.auth-slot \{[^}]*max-width/);
    expect(css).toMatch(/\.auth-name \{[^}]*text-overflow: ellipsis/);

    // The slot narrows at the same width the nav labels do. If it narrowed later — or
    // never — the two would shrink independently and the nav, which is the part that
    // must not lose content, would be the one paying for it.
    const labelShrink = /@media \(max-width: (\d+)px\) \{[^}]*\.nav-item \{[^}]*font-size: 13px/.exec(css)?.[1];
    const slotShrink = /@media \(max-width: (\d+)px\) \{\s*\.auth-slot \{ max-width/.exec(css)?.[1];
    expect(labelShrink, 'cannot find where the nav labels shrink').toBeDefined();
    expect(slotShrink, 'the slot must narrow somewhere, and at the nav\'s threshold').toBe(labelShrink);
  });

  it('registers a callback URL per provider that both providers can be told about', () => {
    for (const id of PROVIDER_IDS) {
      expect(callbackUri({ SITE_ORIGIN: 'https://example.test' }, id)).toBe(
        `https://example.test/auth/${id}/callback`,
      );
    }
  });

  it('treats a missing secret pair as a supported state, not a crash', () => {
    // Half a deployment is normal: `/account` shows one provider and says the other is
    // not configured, rather than 500ing.
    expect(oauth).toMatch(/if \(!clientId \|\| !clientSecret\) return null/);
  });

  it('requires both providers to speak the same PKCE flow', () => {
    expect(oauth).toContain("tokenAuth: 'basic'");
    expect(oauth).toContain("tokenAuth: 'body'");
    // X requires Basic on the token exchange even under PKCE; Google takes the body.
    expect(code(oauth)).toMatch(/if \(config\.tokenAuth === 'basic'\)/);
  });

  it('declares both provider scopes without asking for anything it will not use', () => {
    expect(oauth).toMatch(/scope: 'users\.read tweet\.read'/);
    expect(oauth).toMatch(/scope: 'openid email profile'/);
    // Matched against the comment-stripped source: the note above `scope` in oauth.ts names
    // `offline.access` to explain why it is absent, which is exactly the sort of thing a
    // bare `.not.toContain` catches.
    expect(code(oauth)).not.toContain('offline.access');
  });

  it('reports an unverified Google address as absent', () => {
    expect(oauth).toMatch(/body\.email_verified === true/);
  });
});