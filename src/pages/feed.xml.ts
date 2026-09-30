// SPEC §33 — /feed.xml (RSS 2.0)
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listPublishedArticles } from '../db/public';

const ORIGIN = ((env.SITE_ORIGIN as string) || 'https://x-article-hub.workers.dev').replace(/\/+$/, '');
const SITE_NAME = (env.SITE_NAME as string) || 'X Article Hub';
const DESCRIPTION = 'A human-curated, machine-archived library of X Articles.';

/** SPEC §33 — escape XML text so an author name with & or < cannot break the feed. */
function xml(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const GET: APIRoute = async () => {
  const db = env.DB as unknown as D1Database;
  const articles = await listPublishedArticles(db, { sort: 'latest', limit: 50 });

  const items = articles
    .filter((a) => a.slug)
    .map((a) => {
      const link = `${ORIGIN}/article/${a.slug}`;
      const pubDate = new Date(a.published_at ?? a.imported_at).toUTCString();
      return `    <item>
      <title>${xml(a.title)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="true">${xml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${xml(a.excerpt ?? '')}</description>
      ${a.author_username ? `<author>https://x.com/${xml(a.author_username)} (${xml(a.author_username)})</author>` : ''}
      ${a.category_name ? `<category>${xml(a.category_name)}</category>` : ''}
    </item>`;
    })
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(SITE_NAME)}</title>
    <link>${xml(ORIGIN)}</link>
    <atom:link href="${xml(`${ORIGIN}/feed.xml`)}" rel="self" type="application/rss+xml" />
    <description>${xml(DESCRIPTION)}</description>
    <language>en</language>
${items}
  </channel>
</rss>
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=900, s-maxage=900',
    },
  });
};
