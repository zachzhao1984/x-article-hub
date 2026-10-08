-- SPEC §43 — user accounts: identity, sessions, and the OAuth round-trip's state.
--
-- Three tables for three different lifetimes. `users` is a person and outlives every
-- login. `user_identities` is a credential they can log in with, and there may be more
-- than one per person. `user_sessions` and `oauth_states` are per-attempt and are
-- discarded; keeping them apart from the person is what lets a revoked session be
-- deleted without touching the account.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  -- Nullable on purpose. Google returns an address it has verified; X hands out an
  -- address X has never checked, and X lets a user set an arbitrary one. Storing it
  -- is fine; treating it as proof of anything is not, which is why nothing in §43
  -- keys on it (see the note above `user_identities`).
  email        TEXT,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  -- SPEC §43.4 — admin access for a real account. Granted out of band by a D1 UPDATE,
  -- never by anything a provider can assert, because a provider cannot be asked
  -- "is this person an editor" any more honestly than it can be asked to vouch for an
  -- address.
  role         TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('reader', 'admin')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;

-- Deliberately keyed on (provider, provider_user_id) and never on email.
--
-- `provider_user_id` is the only value in this schema that the provider itself vouches
-- for: X's numeric user id and Google's `sub` are assigned by the platform and cannot be
-- chosen by whoever holds the account. Email is not, so a row keyed on it would let
-- anyone who can set an unverified address on an X account walk in as the matching
-- person here. Cross-provider merging is therefore explicit instead of automatic —
-- see `resolveLogin` in src/services/login.ts, which links a second provider only when
-- the request already carries a valid session for the account being linked.
CREATE TABLE user_identities (
  provider         TEXT NOT NULL CHECK (provider IN ('x', 'google')),
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- X handle / Google's local part. Display only, and not unique: X handles are
  -- recycled, so treating one as an identity would let a later holder in.
  username         TEXT,
  linked_at        INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX idx_identities_user ON user_identities (user_id);

-- Sessions live in D1 rather than KV on purpose.
--
-- KV is eventually consistent, up to 60s stale on read. That breaks login in the
-- direction nobody notices: the callback writes the session, the next request reads a
-- replica that has not caught up, and the reader is logged out for a minute after a
-- successful sign-in — and, worse, appears to still be signed in after signing out. A
-- lookup that cannot be trusted to see its own writes cannot carry an auth decision.
--
-- The row holds a hash, not the token. The cookie carries 256 bits of randomness; a
-- D1 dump yields no usable credential.
CREATE TABLE user_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  -- Both of these are attacker-influenced free text, so they are stored for an operator
  -- to read and are never parsed. The address is hashed rather than kept, because the
  -- reason to keep it ("is this one account bouncing across addresses") does not need
  -- the address itself.
  user_agent   TEXT,
  ip_hash      TEXT
);

CREATE INDEX idx_sessions_user ON user_sessions (user_id);
CREATE INDEX idx_sessions_expiry ON user_sessions (expires_at);

-- SPEC §43 — the PKCE verifier has to outlive a redirect to a third party and come back.
--
-- This is the second thing that cannot go in a cookie: it would have to be signed with a
-- secret this Worker holds, and the whole point of PKCE is that the verifier is never
-- anywhere but the server that issued the challenge. Same eventual-consistency argument
-- as `user_sessions` applies, for the same reason.
--
-- `state` is the CSRF binding and `code_verifier` the PKCE secret; they are deleted on
-- read so a code can never be redeemed twice, even by a replayed callback.
CREATE TABLE oauth_states (
  state           TEXT PRIMARY KEY,
  provider        TEXT NOT NULL CHECK (provider IN ('x', 'google')),
  code_verifier   TEXT NOT NULL,
  -- Only ever a site-relative path, and re-validated on read (see `safeRedirectPath`).
  -- An absolute URL here would be an open redirect: the attacker supplies it and the
  -- victim arrives from a link on this site, so the address bar still says it is us.
  redirect_to     TEXT NOT NULL,
  -- Set when the flow was started while already signed in, which is the one case where
  -- a second provider may be attached to the *current* account rather than resolving
  -- on its own merits. Proof of the account comes from the session cookie, not from
  -- this column.
  link_to_user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX idx_oauth_states_expiry ON oauth_states (expires_at);