/**
 * SPEC §43 — users, identities, sessions and OAuth state.
 *
 * Every statement here is a single one. D1 rejects explicit `BEGIN`/`COMMIT`, so a
 * multi-statement operation is either `db.batch()` (which is a transaction) or a single
 * statement that happens to be atomic on its own — and `takeOAuthState` is the second
 * kind, deliberately: see the note there.
 *
 * Columns are selected explicitly rather than with `*`, except on the two single-table
 * lookups where `*` is the whole row. Migration 0007 renamed FTS display columns and
 * `articles` has grown a lot; the habit of naming columns is what keeps a migration
 * from silently changing the shape of an unrelated query.
 */

import type { ProviderId } from '../lib/oauth';

export type UserRole = 'reader' | 'admin';

export interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  role: UserRole;
  created_at: number;
  updated_at: number;
}

export interface IdentityRow {
  provider: ProviderId;
  provider_user_id: string;
  user_id: string;
  username: string | null;
  linked_at: number;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
  ip_hash: string | null;
}

/** A session joined to the account it belongs to, which is the only shape callers want. */
export interface SessionWithUser {
  session: SessionRow;
  user: UserRow;
}

export interface OAuthStateRow {
  state: string;
  provider: ProviderId;
  code_verifier: string;
  redirect_to: string;
  created_at: number;
  expires_at: number;
}

/**
 * SPEC §43.4 — how admin is granted.
 *
 * Exported so the exact statement is tested rather than retyped at the prompt, and
 * because the rule is worth stating: a provider can tell us who someone is, but it
 * cannot tell us whether they are an editor of this site. That is an operator decision,
 * made against a D1 row, and it is the only path to `role = 'admin'`.
 */
export const GRANT_ADMIN_SQL = `UPDATE users SET role = 'admin', updated_at = ?1 WHERE email = ?2`;

const USER_COLUMNS = 'id, email, display_name, avatar_url, role, created_at, updated_at';

export function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`)
    .bind(id)
    .first<UserRow>();
}

/**
 * Resolve an identity to its account, in one query.
 *
 * This is the lookup that runs on every authenticated request, so it is a single joined
 * read against two primary/unique keys rather than a find-then-fetch.
 */
export function findUserByIdentity(
  db: D1Database,
  provider: ProviderId,
  providerUserId: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS.split(', ')
        .map((c) => `u.${c}`)
        .join(', ')}
         FROM user_identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = ?1 AND i.provider_user_id = ?2`,
    )
    .bind(provider, providerUserId)
    .first<UserRow>();
}

/**
 * By verified email address.
 *
 * Reached from exactly one place — an unknown Google identity whose address is already on
 * file — and safe there for one reason: `profile.email` is non-null only when the profile
 * reader saw `email_verified === true`. This is not the generic "find the person" lookup it
 * looks like, and identity is never keyed on it: `sub` is assigned once by Google and does
 * not move, whereas the address belongs to the account holder and can be changed. See
 * `resolveLogin` in src/services/login.ts.
 */
export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?1 LIMIT 1`)
    .bind(email)
    .first<UserRow>();
}

export function insertUser(
  db: D1Database,
  user: { id: string; email: string | null; displayName: string; avatarUrl: string | null; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, email, display_name, avatar_url, role, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'reader', ?5, ?5)`,
    )
    .bind(user.id, user.email, user.displayName, user.avatarUrl, user.now);
}

export function linkIdentity(
  db: D1Database,
  identity: {
    provider: ProviderId;
    providerUserId: string;
    userId: string;
    username: string | null;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO user_identities (provider, provider_user_id, user_id, username, linked_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(identity.provider, identity.providerUserId, identity.userId, identity.username, identity.now);
}

/**
 * Refresh the cached profile on every sign-in.
 *
 * People change their name and picture, and nothing in §43 lets a reader edit their own
 * profile, so the provider's copy is the only copy there is and it should win. `email`
 * is the exception: it is coalesced, because a provider that stops returning an address
 * is not a provider revoking it, and blanking the column would quietly break
 * `findUserByEmail` on the next Google sign-in and mint a second account.
 */
export function updateUserProfile(
  db: D1Database,
  id: string,
  profile: { displayName: string; avatarUrl: string | null; email: string | null; now: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users
          SET display_name = ?2,
              avatar_url   = COALESCE(?3, avatar_url),
              email        = COALESCE(?4, email),
              updated_at   = ?5
        WHERE id = ?1`,
    )
    .bind(id, profile.displayName, profile.avatarUrl, profile.email, profile.now);
}

export function listIdentities(db: D1Database, userId: string): Promise<IdentityRow[]> {
  return db
    .prepare(
      `SELECT provider, provider_user_id, user_id, username, linked_at
         FROM user_identities WHERE user_id = ?1 ORDER BY linked_at ASC`,
    )
    .bind(userId)
    .all<IdentityRow>()
    .then((r) => r.results);
}

export function insertSession(
  db: D1Database,
  session: {
    tokenHash: string;
    userId: string;
    expiresAt: number;
    now: number;
    userAgent: string | null;
    ipHash: string | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?3, ?5, ?6)`,
    )
    .bind(session.tokenHash, session.userId, session.now, session.expiresAt, session.userAgent, session.ipHash);
}

/**
 * The one auth read, and the reason sessions are in D1.
 *
 * The expiry test lives in the SQL rather than in JS so an expired row is invisible to
 * every caller, and it is checked against the value passed in rather than
 * `Date.now()`, which keeps the function testable without a fake clock and keeps one
 * `now` per request — otherwise a session could be accepted by a reader that ran after
 * midnight and rejected by the next one, within the same request.
 *
 * Both `created_at` columns are aliased. `user_sessions` and `users` each have one, and
 * an unaliased join returns them under the same key — where the second silently wins,
 * so `session.created_at` would have been the date the *account* was created, which is
 * plausible enough to pass a glance and wrong in every session audit. Aliasing makes the
 * collision impossible rather than merely unlikely.
 */
export function findSessionWithUser(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<SessionWithUser | null> {
  interface JoinRow {
    token_hash: string;
    user_id: string;
    session_created_at: number;
    expires_at: number;
    last_seen_at: number;
    user_agent: string | null;
    ip_hash: string | null;
    id: string;
    email: string | null;
    display_name: string;
    avatar_url: string | null;
    role: UserRole;
    user_created_at: number;
    updated_at: number;
  }

  return db
    .prepare(
      `SELECT s.token_hash,
              s.user_id,
              s.created_at   AS session_created_at,
              s.expires_at,
              s.last_seen_at,
              s.user_agent,
              s.ip_hash,
              u.id,
              u.email,
              u.display_name,
              u.avatar_url,
              u.role,
              u.created_at   AS user_created_at,
              u.updated_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<JoinRow>()
    .then((row) =>
      row
        ? {
            session: {
              token_hash: row.token_hash,
              user_id: row.user_id,
              created_at: row.session_created_at,
              expires_at: row.expires_at,
              last_seen_at: row.last_seen_at,
              user_agent: row.user_agent,
              ip_hash: row.ip_hash,
            },
            user: {
              id: row.id,
              email: row.email,
              display_name: row.display_name,
              avatar_url: row.avatar_url,
              role: row.role,
              created_at: row.user_created_at,
              updated_at: row.updated_at,
            },
          }
        : null,
    );
}

/**
 * `last_seen_at` is deliberately coarse and deliberately not read on the hot path.
 *
 * Writing it on every request would turn one indexed read into one indexed read plus
 * one write on every page view, for a value nobody looks at. The account page reads it
 * instead, so the column is current enough to be useful and cheap enough to ignore.
 */
export function touchSession(db: D1Database, tokenHash: string, now: number): D1PreparedStatement {
  return db.prepare(`UPDATE user_sessions SET last_seen_at = ?2 WHERE token_hash = ?1`).bind(tokenHash, now);
}

export function deleteSession(db: D1Database, tokenHash: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM user_sessions WHERE token_hash = ?1`).bind(tokenHash);
}

/** Sign out everywhere. Not surfaced in §43's UI — it is the operator's remedy for a stolen cookie. */
export function deleteSessionsForUser(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM user_sessions WHERE user_id = ?1`).bind(userId);
}

export function insertOAuthState(
  db: D1Database,
  state: {
    state: string;
    provider: ProviderId;
    codeVerifier: string;
    redirectTo: string;
    now: number;
    expiresAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO oauth_states (state, provider, code_verifier, redirect_to, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      state.state,
      state.provider,
      state.codeVerifier,
      state.redirectTo,
      state.now,
      state.expiresAt,
    );
}

/**
 * Read and destroy the state in one statement.
 *
 * `DELETE ... RETURNING` is used instead of a SELECT followed by a DELETE because D1
 * will not run a transaction across two statements, and a two-statement read-then-delete
 * has a window in which two concurrent callbacks holding the same `state` both read it
 * and both proceed. One statement closes that window: whichever callback deletes the row
 * gets the row back, and the other gets nothing.
 *
 * The `expires_at` test is in the same statement for the same reason — an expired row
 * must not be observable, not merely unused.
 */
export function takeOAuthState(db: D1Database, state: string, now: number): Promise<OAuthStateRow | null> {
  return db
    .prepare(
      `DELETE FROM oauth_states WHERE state = ?1 AND expires_at > ?2 RETURNING
         state, provider, code_verifier, redirect_to, created_at, expires_at`,
    )
    .bind(state, now)
    .first<OAuthStateRow>();
}

/**
 * Housekeeping, run from the same place as the rest of the periodic work.
 *
 * `oauth_states` rows are the ones that matter: they are pure garbage once spent, and an
 * abandoned `/auth/x/start` (someone closed the tab) leaves one behind every time.
 */
export function deleteStaleAuthRows(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?1`).bind(now),
    db.prepare(`DELETE FROM user_sessions WHERE expires_at <= ?1`).bind(now),
  ];
}
// --- SPEC §43 — saved articles -----------------------------------------------

/** A saved row with just enough of the article to link to it. */
export interface SavedArticleRow {
  article_id: string;
  saved_at: number;
  slug: string | null;
  title: string;
  excerpt: string | null;
  author_username: string | null;
  author_name: string | null;
  published_at: number | null;
  /**
   * Carried so the card can compute its reading time. Without it every saved card would
   * claim "1 min read", because `ArticleCard` floors the division at 1 — a wrong number
   * rather than a missing one, which is the harder kind to notice.
   */
  word_count: number;
  /**
   * The card's cover, as a `media_objects` id, or null.
   *
   * The saved list renders the same `ArticleCard` as every board, so it needs the same
   * shape — otherwise a saved card would lose its image and its counters the moment it was
   * saved, which reads as the act of saving having changed the article.
   */
  cover_image_id: string | null;
  metric_views: number | null;
  metric_likes: number | null;
  metric_reposts: number | null;
  metric_replies: number | null;
  metric_bookmarks: number | null;
}

/**
 * Save, idempotently.
 *
 * `ON CONFLICT DO NOTHING` rather than a check-then-insert: the pair is the primary key, so
 * this is one statement with no window between the read and the write. Two rapid taps on the
 * button in a browser that fired both requests would otherwise race, and the loser would get
 * a UNIQUE violation surfaced as an error for something that already succeeded.
 *
 * `savedAt` is only used when the row is actually created — a second save must not move the
 * article to the top of the reader's list.
 */
export function saveArticle(
  db: D1Database,
  userId: string,
  articleId: string,
  savedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO saved_articles (user_id, article_id, saved_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id, article_id) DO NOTHING`,
    )
    .bind(userId, articleId, savedAt);
}

/** Unsave. Deleting a row that is not there is not an error — the end state is the same. */
export function unsaveArticle(db: D1Database, userId: string, articleId: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM saved_articles WHERE user_id = ?1 AND article_id = ?2`)
    .bind(userId, articleId);
}

export function isSaved(db: D1Database, userId: string, articleId: string): Promise<{ ok: number } | null> {
  return db
    .prepare(`SELECT 1 AS ok FROM saved_articles WHERE user_id = ?1 AND article_id = ?2`)
    .bind(userId, articleId)
    .first<{ ok: number }>();
}

/**
 * A reader's saves, newest first.
 *
 * `published_at` is the article's own date rather than the save time: the card renders the
 * publication date, and `saved_at` only orders the list.
 *
 * Inner joins on both sides, and the predicate on `articles` is deliberate: a saved article
 * that has since been unpublished, taken down or archived must not appear. The reader saved
 * something they could read; if the editors have withdrawn it, the list has to agree with
 * every other surface rather than leaking it back through a join that forgot to check.
 *
 * The cascade would normally handle a hard-deleted article, so the join cannot find a
 * dangling row — this predicate is about visibility, not existence.
 */
export function listSavedArticles(db: D1Database, userId: string, limit = 100): Promise<SavedArticleRow[]> {
  return db
    .prepare(
      `SELECT s.article_id, s.saved_at,
              a.slug, a.title, a.excerpt, a.word_count,
              a.author_username, a.author_name,
              a.published_at,
              (SELECT m.id FROM media_objects m
                WHERE m.article_id = a.id AND m.kind = 'body' AND m.r2_key IS NOT NULL
                ORDER BY m.position ASC LIMIT 1) AS cover_image_id,
              (SELECT m2.views     FROM article_metrics m2 WHERE m2.article_id = a.id
                ORDER BY m2.captured_at DESC LIMIT 1) AS metric_views,
              (SELECT m2.likes     FROM article_metrics m2 WHERE m2.article_id = a.id
                ORDER BY m2.captured_at DESC LIMIT 1) AS metric_likes,
              (SELECT m2.reposts   FROM article_metrics m2 WHERE m2.article_id = a.id
                ORDER BY m2.captured_at DESC LIMIT 1) AS metric_reposts,
              (SELECT m2.replies   FROM article_metrics m2 WHERE m2.article_id = a.id
                ORDER BY m2.captured_at DESC LIMIT 1) AS metric_replies,
              (SELECT m2.bookmarks FROM article_metrics m2 WHERE m2.article_id = a.id
                ORDER BY m2.captured_at DESC LIMIT 1) AS metric_bookmarks
         FROM saved_articles s
         JOIN articles a ON a.id = s.article_id
        WHERE s.user_id = ?1
          AND a.status = 'published'
          AND a.display_mode != 'takedown'
        ORDER BY s.saved_at DESC
        LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<SavedArticleRow>()
    .then((r) => r.results);
}

export function countSavedArticles(db: D1Database, userId: string): Promise<{ n: number } | null> {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM saved_articles WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
}

/**
 * Whether a reader has saved a batch of articles, as a set.
 *
 * The article page needs one answer, but a list view needs many, and asking per-card is the
 * shape that turns a page into N queries. One `IN (…)` returns the whole set.
 *
 * Not currently called with more than one id — it exists because the alternative is the
 * per-card query being written later by someone who has not read this note.
 */
export function listSavedIds(
  db: D1Database,
  userId: string,
  articleIds: string[],
): Promise<Array<{ article_id: string }>> {
  if (articleIds.length === 0) return Promise.resolve([]);
  const placeholders = articleIds.map((_, i) => `?${i + 2}`).join(', ');
  return db
    .prepare(`SELECT article_id FROM saved_articles WHERE user_id = ?1 AND article_id IN (${placeholders})`)
    .bind(userId, ...articleIds)
    .all<{ article_id: string }>()
    .then((r) => r.results);
}
