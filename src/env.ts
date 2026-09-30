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
