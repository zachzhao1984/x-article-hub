/**
 * SPEC §43 — deciding whose account a completed OAuth round-trip belongs to.
 *
 * This is the only place in §43 that makes a security decision, so it is separated from
 * the transport around it and given a narrow interface instead of `D1Database`. The
 * narrowness is the point: it makes the function testable against a fake that answers
 * from a table, so the branching below can be exercised for real rather than asserted
 * against source text.
 *
 * ## The rule
 *
 *   Identity is (provider, provider_user_id) — for one provider, Google's `sub`.
 *
 * Not the address. Google verifies the addresses it holds, so that is not the argument any
 * more; the argument is that a Google account holder can *change* their address, and
 * whoever holds it afterwards would inherit the identity. `sub` is assigned once and does
 * not move.
 *
 * ## Why there is no "link to the account you are already signed in to"
 *
 * With two providers this file had a branch that attached a second provider's identity to
 * the current account. It was the supported way to merge one person's accounts, and it was
 * safe because the proof of ownership came from the session cookie rather than from
 * anything in the query string.
 *
 * With one provider it stops being a merge and becomes an accident waiting to happen.
 * Signed in as A, then sign in with a *different, unknown* Google account, and that
 * identity is attached to A: B and A become one person, and B neither consented nor can
 * see that it happened. A's row would simply gain a second identity, and both sessions
 * would then resolve to the same user — nothing anywhere would look wrong.
 *
 * So a sign-in always resolves on the identity's own merits, and `link_to_user_id` is
 * gone from the schema with it (migration 0009).
 */

import {
  findUserByEmail,
  findUserByIdentity,
  insertUser,
  linkIdentity,
  updateUserProfile,
  type UserRow,
} from '../db/users';
import { newId } from '../lib/ids';
import type { OAuthProfile, ProviderId } from '../lib/oauth';
import { log } from '../lib/logger';

/**
 * The slice of `D1Database` this module uses.
 *
 * `D1Database` satisfies it structurally, so nothing else in the codebase has to change to
 * pass a real binding, and `tests/unit/user-auth.test.ts` can pass a table-backed fake.
 * The `any` on `bind`'s return is what D1 itself declares; narrowing it further would mean
 * re-declaring `D1PreparedStatement` and drifting out of sync with it.
 */
export interface AuthDb {
  prepare(sql: string): { bind(...args: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

export type LoginOutcome = 'existing' | 'linked_by_email' | 'created';

export interface LoginResult {
  user: UserRow;
  outcome: LoginOutcome;
}

export interface ResolveLoginOptions {
  provider: ProviderId;
  profile: OAuthProfile;
  now: number;
}

export async function resolveLogin(db: AuthDb, opts: ResolveLoginOptions): Promise<LoginResult> {
  const { provider, profile, now } = opts;
  const asDb = db as unknown as D1Database;

  // 1. The identity is already known. This is the overwhelmingly common path: almost
  //    every sign-in is a return visit by someone who has an account here.
  const known = (await findUserByIdentity(asDb, provider, profile.id)) as UserRow | null;
  if (known) {
    await db.batch([updateUserProfile(asDb, known.id, { ...profileFields(profile), now })]);
    return { user: known, outcome: 'existing' };
  }

  // 2. An unknown Google identity whose verified address is already on file. This is the
  //    one match on address, and it is safe for exactly one reason: `profile.email` is
  //    non-null only because the profile reader saw `email_verified === true`.
  //
  //    It is not "link to whoever is signed in" — the caller who signed in is not
  //    consulted. Someone signed in as A and then signing in as B signs them into B.
  if (profile.email) {
    const byEmail = (await findUserByEmail(asDb, profile.email)) as UserRow | null;
    if (byEmail) {
      await db.batch([
        linkIdentity(asDb, {
          provider,
          providerUserId: profile.id,
          userId: byEmail.id,
          username: profile.username,
          now,
        }),
        updateUserProfile(asDb, byEmail.id, { ...profileFields(profile), now }),
      ]);
      log.info('login_identity_linked', { user_id: byEmail.id, provider, via: 'email' });
      return { user: byEmail, outcome: 'linked_by_email' };
    }
  }

  // 3. A new person. Both statements go in one batch so there is never an account with no
  //    identity: that state cannot be signed into, so a row like it is unrecoverable
  //    except by hand, and a crash between two unbatched statements could create one.
  const user: UserRow = {
    id: newId('usr'),
    email: profile.email,
    display_name: profile.displayName,
    avatar_url: profile.avatarUrl,
    role: 'reader',
    created_at: now,
    updated_at: now,
  };
  await db.batch([
    insertUser(asDb, {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      now,
    }),
    linkIdentity(asDb, {
      provider,
      providerUserId: profile.id,
      userId: user.id,
      username: profile.username,
      now,
    }),
  ]);
  log.info('login_created', { user_id: user.id, provider, has_email: profile.email !== null });
  return { user, outcome: 'created' };
}

function profileFields(profile: OAuthProfile) {
  return {
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    email: profile.email,
  };
}