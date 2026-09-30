/** SPEC §11.9 — the audit trail. Every state change an editor makes is recorded. */

import type { CurationEventRow } from './rows';
import { newId } from '../lib/ids';

export type CurationAction =
  | 'import'
  | 'publish'
  | 'reject'
  | 'archive'
  | 'restore'
  | 'takedown'
  | 'category_override'
  | 'summary_override'
  | 'featured'
  | 'unfeatured'
  | 'retry';

export async function recordEvent(
  db: D1Database,
  articleId: string,
  action: CurationAction,
  actor: string,
  note?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO curation_events (id, article_id, action, actor, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(newId('evt'), articleId, action, actor, note ?? null, Date.now())
    .run();
}

export function listEvents(db: D1Database, articleId: string, limit = 50): Promise<CurationEventRow[]> {
  return db
    .prepare(`SELECT * FROM curation_events WHERE article_id = ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(articleId, limit)
    .all<CurationEventRow>()
    .then((r) => r.results);
}

export function listRecentEvents(db: D1Database, limit = 25): Promise<CurationEventRow[]> {
  return db
    .prepare(`SELECT * FROM curation_events ORDER BY created_at DESC LIMIT ?1`)
    .bind(limit)
    .all<CurationEventRow>()
    .then((r) => r.results);
}
