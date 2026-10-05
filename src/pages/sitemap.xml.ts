// SPEC §33 — /sitemap.xml
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listCategoriesWithCounts, listPublishedArticles, listTagsWithCounts } from '../db/public';

const ORIGIN = ((env.SITE_ORIGIN as string) || 'https://x-article-hub.workers.dev').replace(/\/+$/, '');

export const GET: APIRoute = async () => {
  const db = env.DB as unknown as D1Database;

  const [articles, categories, tags] = await Promise.all([
    listPublishedArticles(db, { sort: 'latest', limit: 100 }),
    listCategoriesWithCounts(db),
    listTagsWithCounts(db, 200),
  ]);

  const now = new Date().toISOString().slice(0, 10);

  const urls: string[] = [
    `  <url><loc>${ORIGIN}/</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${ORIGIN}/latest</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>0.9</priority></url>`,
    `  <url><loc>${ORIGIN}/trending</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>0.8</priority></url>`,
    `  <url><loc>${ORIGIN}/rising</loc><lastmod>${now}</lastmod><changefreq>hourly</changefreq><priority>0.8</priority></url>`,
    // Editor's Pick sits below the three score boards: it is the smallest and the most
    // volatile, since it holds nothing until an editor flags something.
    `  <url><loc>${ORIGIN}/featured</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`,
    `  <url><loc>${ORIGIN}/about</loc><lastmod>${now}</lastmod><changefreq>monthly</changefreq><priority>0.3</priority></url>`,
    ...categories.map(
      (c) =>
        `  <url><loc>${ORIGIN}/category/${c.slug}</loc><changefreq>daily</changefreq><priority>0.6</priority></url>`,
    ),
    ...tags.map(
      (t) => `  <url><loc>${ORIGIN}/tag/${t.slug}</loc><changefreq>weekly</changefreq><priority>0.4</priority></url>`,
    ),
    ...articles
      .filter((a) => a.slug)
      .map((a) => {
        const lastmod = new Date(a.published_at ?? a.imported_at).toISOString().slice(0, 10);
        return `  <url><loc>${ORIGIN}/article/${a.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
      }),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};
