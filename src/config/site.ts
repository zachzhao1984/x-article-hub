/** SPEC §33 — SEO base values. */

export interface SiteConfig {
  name: string;
  origin: string;
  description: string;
  locale: string;
}

const FALLBACK: SiteConfig = {
  name: 'X Article Hub',
  origin: 'https://x-article-hub.workers.dev',
  description: 'A curated, archived and searchable library of X Articles.',
  locale: 'en',
};

export const FALLBACK_SITE_NAME = FALLBACK.name;

export function siteConfig(env: { SITE_NAME?: string; SITE_ORIGIN?: string }): SiteConfig {
  const origin = (env.SITE_ORIGIN || FALLBACK.origin).replace(/\/+$/, '');
  return {
    ...FALLBACK,
    name: env.SITE_NAME || FALLBACK.name,
    origin,
  };
}
