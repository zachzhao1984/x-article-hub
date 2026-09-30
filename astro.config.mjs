// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// SPEC §3 — the public site is Astro on Workers, SSR so a newly published
// article is visible immediately (SPEC §23 caching is handled by CDN headers,
// not by a build-time snapshot).
export default defineConfig({
  output: 'server',

  // SPEC §16 — admin sessions are an HMAC cookie handled by src/middleware/admin-auth.ts,
  // so Astro's KV-backed session store is not needed and must not be provisioned.
  session: false,

  adapter: cloudflare({
    // No astro:assets usage; don't provision an Images binding we never call.
    imageService: 'passthrough',
  }),

  vite: {
    // SPEC §31 — readable stack traces in Workers logs (adapter guidance).
    build: { minify: false },
  },
});
