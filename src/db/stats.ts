/** SPEC §16.1 — dashboard counters. */

import type { ArticleStatus } from '../jobs/types';

export interface DashboardStats {
  articles: Record<string, number>;
  today: { imported: number; published: number; failed: number };
  total: number;
}

export async function dashboardStats(db: D1Database): Promise<DashboardStats> {
  const byStatus = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM articles GROUP BY status`)
    .all<{ status: ArticleStatus; n: number }>();

  const articles: Record<string, number> = {};
  let total = 0;
  for (const row of byStatus.results) {
    articles[row.status] = row.n;
    total += row.n;
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const since = startOfToday.getTime();

  const todayRow = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN imported_at >= ?1 THEN 1 ELSE 0 END) AS imported,
         SUM(CASE WHEN status = 'published' AND updated_at >= ?1 THEN 1 ELSE 0 END) AS published,
         SUM(CASE WHEN status = 'failed' AND updated_at >= ?1 THEN 1 ELSE 0 END) AS failed
       FROM articles`,
    )
    .bind(since)
    .first<{ imported: number | null; published: number | null; failed: number | null }>();

  return {
    articles,
    total,
    today: {
      imported: todayRow?.imported ?? 0,
      published: todayRow?.published ?? 0,
      failed: todayRow?.failed ?? 0,
    },
  };
}
