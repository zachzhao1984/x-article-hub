-- SPEC §43 — Google is the only provider.
--
-- 0008 shipped with X alongside Google and this revision removes it. Two schema facts
-- change with it, and neither is reachable from application code any more, so both are
-- corrected here rather than left as permissiveness nobody would notice:
--
--   1. `provider` was constrained to IN ('x', 'google') and can now only ever be
--      'google'. The column stays, because `(provider, provider_user_id)` is the correct
--      composite key for "which account at which provider" and a future provider should
--      not require rethinking it. Only the permitted set narrows.
--   2. `link_to_user_id` is **removed**, and this one is not cosmetic — see below.
--
-- ## Why `link_to_user_id` had to go
--
-- With two providers it was the supported way to merge one person's accounts: sign in,
-- then connect the second provider while still holding that session. The proof of
-- ownership came from the session cookie, not from the query string, so it was safe.
--
-- With one provider it stops being a merge and becomes an account takeover by accident.
-- Signed in as account A, then sign in with a *different, unknown* Google account, and
-- that identity is attached to A — so B and A become one person, and B did not consent to
-- it and cannot see that it happened. Nothing would have looked wrong: A's row gains a
-- second identity and both sessions then resolve to the same user.
--
-- So a sign-in now always resolves on the identity's own merits, and `link_to_user_id`
-- is not merely unused — the branch that read it is removed with it. See
-- `resolveLogin` in src/services/login.ts.
--
-- ## Why the rebuild rather than a relaxed constraint
--
-- SQLite cannot ALTER a CHECK, and 0008 is already applied to production, so editing it
-- would leave local databases and the deployed one disagreeing with the repository. Both
-- tables are empty, which is the only reason this is cheap: the rebuild is a create, an
-- INSERT ... SELECT of zero rows, a drop and a rename.

-- --- user_identities -------------------------------------------------------

CREATE TABLE user_identities_new (
  provider         TEXT NOT NULL CHECK (provider IN ('google')),
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Google's local part. Display only, and not unique — a Google account holder can
  -- change the address, so this is not an identity and never becomes one.
  username         TEXT,
  linked_at        INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

INSERT INTO user_identities_new (provider, provider_user_id, user_id, username, linked_at)
SELECT provider, provider_user_id, user_id, username, linked_at FROM user_identities;

DROP TABLE user_identities;
ALTER TABLE user_identities_new RENAME TO user_identities;

CREATE INDEX idx_identities_user ON user_identities (user_id);

-- --- oauth_states ----------------------------------------------------------

CREATE TABLE oauth_states_new (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('google')),
  code_verifier TEXT NOT NULL,
  -- Only ever a site-relative path, re-validated on read by `safeRedirectPath`. An
  -- absolute URL here would be an open redirect: the attacker supplies it and the victim
  -- arrives from a link on this site, so the address bar still says it is us.
  redirect_to   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

INSERT INTO oauth_states_new (state, provider, code_verifier, redirect_to, created_at, expires_at)
SELECT state, provider, code_verifier, redirect_to, created_at, expires_at FROM oauth_states;

DROP TABLE oauth_states;
ALTER TABLE oauth_states_new RENAME TO oauth_states;

CREATE INDEX idx_oauth_states_expiry ON oauth_states (expires_at);