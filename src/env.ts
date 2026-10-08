/**
 * Ambient type augmentation for the Worker.
 *
 * `Env` itself is declared by `worker-configuration.d.ts` (`npm run cf-typegen`),
 * which also gives the `vars` literal types that the Cloudflare adapter's `cf()`
 * middleware expects — so it must not be shadowed by a hand-written interface.
 *
 * Secret bindings never appear in the generated file because they only exist at
 * runtime, so they are merged into the same global interface here.
 *
 * These live in a `.ts` file rather than a `.d.ts` because tsc's `include` was
 * silently not picking the declaration file up.
 */

declare global {
  interface Env {
    /** SPEC §24 — local-dev shim only. Production gates admin with Cloudflare Access. */
    ADMIN_TOKEN?: string;
    ENVIRONMENT?: string;

    /**
     * SPEC §26 item 2 — X session cookies as Puppeteer `setCookie` objects.
     *
     * X does not use HTTP Basic auth, so the documented `authenticate` option
     * cannot log in. Without a signed-in session, X serves its login wall instead
     * of the article body and every crawl fails with LOGIN_REQUIRED.
     */
    X_COOKIES_JSON?: string;

    /** SPEC §39 — the screenshot is optional and the priciest format; opt in per env. */
    CRAWL_SCREENSHOT?: string;

    /**
     * SPEC §43 — OAuth client credentials, one pair per provider.
     *
     * Secrets, not `vars`: these are `wrangler secret put` values and must never be
     * committed. A missing pair is a supported state, not an error — `providerConfig`
     * returns null for it and `/account` renders that provider as unavailable, so a
     * deployment with only Google configured still signs in normally and says plainly
     * that X is not set up.
     *
     * The callback URI both providers compare against is derived from `SITE_ORIGIN` in
     * `callbackUri()`, and it has to be registered byte for byte at the provider:
     *
     *   https://<SITE_ORIGIN>/auth/x/callback
     *   https://<SITE_ORIGIN>/auth/google/callback
     *
     * Neither path may sit behind Cloudflare Access: the provider redirects here from
     * the reader's browser, and Access would answer that navigation with its own login
     * before the Worker ever saw the code.
     */
    X_CLIENT_ID?: string;
    X_CLIENT_SECRET?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;

    /**
     * SPEC §43 — peppers `user_sessions.ip_hash`.
     *
     * A bare SHA-256 of an IPv4 address is reversible by anyone willing to try 2^32
     * candidates, so storing one would be privacy in name only. Salted with this, a D1
     * dump on its own yields nothing.
     */
    USER_SESSION_SECRET?: string;
  }

  // Astro 6 removed `Astro.locals.runtime`; bindings come from `cloudflare:workers`.
  // The adapter still exposes the ExecutionContext here, which is what `waitUntil`
  // is read from.
  namespace App {
    interface Locals {
      cfContext: ExecutionContext;
    }
  }
}

export {};
