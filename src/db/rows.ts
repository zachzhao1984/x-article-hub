/** SPEC §11 — row shapes for the tables this phase touches. */

import type { ArticleStatus, DisplayMode, JobStatus, JobType } from '../jobs/types';

export interface ArticleRow {
  id: string;
  source_url: string;
  canonical_url: string;
  x_article_id: string | null;
  x_post_id: string | null;
  slug: string | null;
  title: string;
  excerpt: string | null;
  author_id: string | null;
  author_name: string | null;
  author_username: string | null;
  author_avatar: string | null;
  published_at: number | null;
  imported_at: number;
  status: ArticleStatus;
  category_id: string | null;
  ai_summary: string | null;
  ai_category: string | null;
  ai_confidence: number | null;
  editor_category_id: string | null;
  editor_summary: string | null;
  quality_score: number | null;
  popularity_score: number | null;
  velocity_score: number | null;
  editor_score: number | null;
  final_score: number | null;
  parser_version: number;
  content_r2_key: string | null;
  raw_r2_key: string | null;
  featured: 0 | 1;
  display_mode: DisplayMode;
  takedown_requested_at: number | null;
  takedown_reason: string | null;
  word_count: number;
  block_count: number;
  created_at: number;
  updated_at: number;
}

export interface CrawlJobRow {
  id: string;
  article_id: string;
  job_type: JobType;
  status: JobStatus;
  attempt_count: number;
  deliveries: number;
  last_delivered_at: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CurationEventRow {
  id: string;
  article_id: string;
  action: string;
  actor: string;
  note: string | null;
  created_at: number;
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: number;
}

export interface TagRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
}
