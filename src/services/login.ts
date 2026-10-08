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
 *   Identity is (provider, provider_user_id), full stop.
 *
 * Email is used in one place — a Google sign-in for an address already on file — and
 * only because Google asserts `email_verified`. X returns an address it has never
 * checked, so the X path never reaches that branch. Keying on email for both would let
 * anyone who can set an unverified address on an X account sign in as the matching
 * person; that is the whole reason `user_identities` is keyed the way it is.
 *
 * The consequence, stated plainly because it will otherwise look like a bug: **a person
 * who signs in with both X and Google in two separate browser sessions gets two
 * accounts.** Merging happens the supported way — sign in, then connect the second
 * provider while still holding that session — which is what `linkToUserId` is for, and
 * which is safe because the proof of ownership comes from the session cookie and not
 * from anything in the query string.
 */

import {
  findUserByEmail,
  findUserById,
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
 * `D1Database` satisfies it structurally, so nothing else in the codebase has to change
 * to pass a real binding, and `tests/unit/user-auth.test.ts` can pass a table-backed
 * fake. The `any` on `bind`'s return is what D1 itself declares; narrowing it further
 * would mean re-declaring `D1PreparedStatement` and drift out of sync with it.
 */
export interface AuthDb {
  prepare(sql: string): { bind(...args: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

export type LoginOutcome = 'existing' | 'linked_to_session' | 'linked_by_email' | 'created';

export interface LoginResult {
  user: UserRow;
  outcome: LoginOutcome;
}

export interface ResolveLoginOptions {
  provider: ProviderId;
  profile: OAuthProfile;
  /** Set when the flow was started while a valid session existed. */
  linkToUserId?: string | null;
  now: number;
}

export async function resolveLogin(db: AuthDb, opts: ResolveLoginOptions): Promise<LoginResult> {
  const { provider, profile, linkToUserId, now } = opts;

  // 1. The identity is already known. This is the overwhelmingly common path: almost
  //    every sign-in is a return visit by someone who has an account here.
  const known = (await findUserByIdentity(db as unknown as D1Database, provider, profile.id)) as UserRow | null;
  if (known) {
    // If the flow was started while signed in as somebody else, the identity still wins:
    // the provider just proved who this person is, which is a stronger statement than
    // which tab they happened to be logged into. Recorded because it is surprising and
    // an operator reading logs should be able to see it happened.
    if (linkToUserId && linkToUserId !== known.id) {
      log.warn('login_identity_owned_by_other', {
        linked_from_session: linkToUserId,
        signed_in_as: known.id,
        provider,
      });
    }
    await db.batch([updateUserProfile(db as unknown as D1Database, known.id, { ...profileFields(profile), now })]);
    return { user: known, outcome: 'existing' };
  }

  // 2. Already signed in, connecting a second provider to this account. This is the only
  //    cross-provider merge, and it is safe because the session cookie — not the query
  //    string — is what named the account.
  if (linkToUserId) {
    const target = (await findUserById(db as unknown as D1Database, linkToUserId)) as UserRow | null;
    if (target) {
      await db.batch([
        linkIdentity(db as unknown as D1Database, {
          provider,
          providerUserId: profile.id,
          userId: target.id,
          username: profile.username,
          now,
        }),
        updateUserProfile(db as unknown as D1Database, target.id, { ...profileFields(profile), now }),
      ]);
      log.info('login_identity_linked', { user_id: target.id, provider });
      return { user: target, outcome: 'linked_to_session' };
    }
    // The session was valid when the flow started but its row is gone now — signed out
    // in another tab, or expired. Fall through and resolve on the identity's own merits
    // rather than failing the sign-in.
    log.info('login_link_target_gone', { link_to_user_id: linkToUserId, provider });
  }

  // 3. Google-only: an address already on file. `profile.email` is non-null here only
  //    because Google's reader drops it unless `email_verified` was true.
  if (provider === 'google' && profile.email) {
    const byEmail = (await findUserByEmail(db as unknown as D1Database, profile.email)) as UserRow | null;
    if (byEmail) {
      await db.batch([
        linkIdentity(db as unknown as D1Database, {
          provider,
          providerUserId: profile.id,
          userId: byEmail.id,
          username: profile.username,
          now,
        }),
        updateUserProfile(db as unknown as D1Database, byEmail.id, { ...profileFields(profile), now }),
      ]);
      log.info('login_identity_linked', { user_id: byEmail.id, provider, via: 'email' });
      return { user: byEmail, outcome: 'linked_by_email' };
    }
  }

  // 4. A new person. Both statements go in one batch so there is never an account with
  //    no identity: that state cannot be signed into, so a row like it is unrecoverable
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
    insertUser(db as unknown as D1Database, {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      now,
    }),
    linkIdentity(db as unknown as D1Database, {
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