import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — pure logic, no Cloudflare runtime.
 *
 * Everything that needs a real resource (D1, R2, Browser Run) is verified
 * against the deployed Worker instead, via scripts/smoke.sh and
 * scripts/smoke-site.sh. A local workerd pool was evaluated and dropped: it would
 * have required stubbing the one binding that actually matters, so the tests
 * would have asserted against my own assumptions rather than the platform.
 *
 * SPEC §42 asks for real capture tests rather than invented fixtures — the
 * fixtures in tests/unit/crawl-recognition.test.ts are verbatim Browser Run
 * output captured from live X.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
