/** A resumable, versioned Chinese translation of a published article. */
import type { ArticleDocument } from '../types/article-document';
import { readArticleDocument } from './archive';
import { CLASSIFY_MODEL } from './classify';
import { AppError } from '../lib/errors';

const TRANSLATION_VERSION = 1;
// Qwen can stop early even with finish_reason=stop when too many JSON entries are requested.
// Keep batches small so the entire translation fits comfortably in one response.
const BATCH_CHARS = 500;

type Progress = {
  sourceKey: string;
  translationVersion: number;
  cursor: number;
  texts: string[];
};

type Unit = { text: string; assign: (translated: string) => void };

function parseTranslations(response: unknown, expected: number): string[] | null {
  const result = response as { response?: unknown; choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  if (result.choices?.[0]?.finish_reason === 'length') return null;
  const raw = result.response ?? result.choices?.[0]?.message?.content;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const texts = (value as { translations?: unknown })?.translations;
    return Array.isArray(texts) && texts.length === expected &&
      texts.every((text) => typeof text === 'string' && text.trim()) ? texts as string[] : null;
  } catch { return null; }
}

function keys(articleId: string, sourceKey: string) {
  const version = /\/versions\/v(\d+)\/article\.json$/.exec(sourceKey)?.[1];
  if (!version) throw new AppError('BAD_REQUEST', 'Article document has no version', 400);
  const prefix = `articles/${articleId}/translations/v${version}/zh`;
  return { progress: `${prefix}.progress.json`, finished: `${prefix}.json` };
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
}

/** Reads only a complete translation of this exact source document. */
export async function readTranslation(bucket: R2Bucket, articleId: string, sourceKey: string): Promise<ArticleDocument | null> {
  const object = await bucket.get(keys(articleId, sourceKey).finished);
  if (!object) return null;
  try {
    const value = await object.json() as { sourceKey?: string; translationVersion?: number; document?: ArticleDocument };
    return value.sourceKey === sourceKey && value.translationVersion === TRANSLATION_VERSION &&
      value.document?.blocks?.length ? value.document : null;
  } catch {
    return null;
  }
}

/** Build one stable sequence of translatable text slots; metadata and embed cards remain original. */
export function translationUnits(doc: ArticleDocument): { units: Unit[]; translated: ArticleDocument } {
  const translated: ArticleDocument = structuredClone(doc);
  const units: Unit[] = [];
  const add = (text: string, assign: (value: string) => void) => {
    if (!text.trim()) return;
    // Very long spans are split on whitespace, then joined back into their original slot.
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 1200) {
      const boundary = rest.lastIndexOf(' ', 1200);
      const end = boundary > 600 ? boundary + 1 : 1200;
      chunks.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    chunks.push(rest);
    const values = Array<string>(chunks.length).fill('');
    chunks.forEach((chunk, index) => units.push({ text: chunk, assign: (value) => {
      values[index] = value;
      assign(values.join(''));
    } }));
  };
  add(doc.title, (value) => { translated.title = value; });
  for (const block of translated.blocks) {
    if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'quote') {
      for (const span of block.spans) {
        if (span.type !== 'code') add(span.text, (value) => { span.text = value; });
      }
    } else if (block.type === 'list') {
      for (const item of block.items) {
        for (const span of item) {
          if (span.type !== 'code') add(span.text, (value) => { span.text = value; });
        }
      }
    }
  }
  return { units, translated };
}

export async function translateArticleBatch(env: Env, articleId: string): Promise<{ done: boolean; translated: number; total: number }> {
  const row = await env.DB.prepare('SELECT status, display_mode, content_r2_key FROM articles WHERE id = ?1')
    .bind(articleId).first<{ status: string; display_mode: string; content_r2_key: string | null }>();
  if (row?.status !== 'published' || row.display_mode !== 'full' || !row.content_r2_key) {
    throw new AppError('BAD_REQUEST', 'Only published full-text articles can be translated', 400);
  }
  const sourceKey = row.content_r2_key;
  const source = await readArticleDocument(env.ARCHIVE, sourceKey);
  if (!source) throw new AppError('NOT_FOUND', 'The source document is missing from R2', 404);
  const paths = keys(articleId, sourceKey);
  const { units, translated } = translationUnits(source);
  if (await readTranslation(env.ARCHIVE, articleId, sourceKey)) return { done: true, translated: units.length, total: units.length };

  const saved = await env.ARCHIVE.get(paths.progress);
  let progress: Progress | null = null;
  if (saved) {
    try { progress = await saved.json() as Progress; } catch { /* restart corrupt checkpoint */ }
  }
  if (!progress || progress.sourceKey !== sourceKey || progress.translationVersion !== TRANSLATION_VERSION ||
      !Array.isArray(progress.texts) || progress.cursor !== progress.texts.length || progress.cursor > units.length ||
      progress.texts.some((s) => typeof s !== 'string' || !s.trim())) {
    progress = { sourceKey, translationVersion: TRANSLATION_VERSION, cursor: 0, texts: [] };
  }

  if (units.length === 0) throw new AppError('BAD_REQUEST', 'Article has no text to translate', 400);

  if (progress.cursor < units.length) {
    // Long input segments are sent alone; this model sometimes stops after one
    // translation despite reporting finish_reason=stop on longer two-item batches.
    let end = progress.cursor + 1;
    if (end < units.length && units[progress.cursor]!.text.length + units[end]!.text.length <= BATCH_CHARS) end++;
    const batch = units.slice(progress.cursor, end);
    const response = await env.AI.run(CLASSIFY_MODEL, {
      messages: [
        { role: 'system', content: 'Translate each text item faithfully into natural Simplified Chinese. Preserve code identifiers, names, links and technical terms. Return only a JSON object with a "translations" array of strings in the same order and length as the input. Do not explain or summarize. /no_think' },
        { role: 'user', content: JSON.stringify({ texts: batch.map((unit) => unit.text) }) },
      ],
      max_tokens: 2500,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    let texts = parseTranslations(response, batch.length);
    if (!texts && batch.length > 1) {
      // A partial two-item answer is not publishable. Retry both items separately;
      // only checkpoint after all the text for this batch has been validated.
      const singles: string[] = [];
      for (const unit of batch) {
        const single = await env.AI.run(CLASSIFY_MODEL, {
          messages: [
            { role: 'system', content: 'Translate this text faithfully into natural Simplified Chinese. Preserve code identifiers, names, links and technical terms. Return only a JSON object with a "translations" array containing exactly one string. /no_think' },
            { role: 'user', content: JSON.stringify({ texts: [unit.text] }) },
          ], max_tokens: 2500, temperature: 0.1, response_format: { type: 'json_object' },
        });
        const value = parseTranslations(single, 1)?.[0];
        if (!value) throw new AppError('SCHEMA_MISMATCH', `Model returned an invalid translation at item ${progress.cursor + singles.length}`, 502);
        singles.push(value);
      }
      texts = singles;
    }
    if (!texts) throw new AppError('SCHEMA_MISMATCH', `Model returned an invalid translation at item ${progress.cursor}`, 502);
    progress.texts.push(...texts);
    progress.cursor = end;
    await putJson(env.ARCHIVE, paths.progress, progress);
  }

  if (progress.cursor === units.length) {
    progress.texts.forEach((text, index) => units[index]!.assign(text));
    // Do not expose a translation if the source changed during the AI call.
    const current = await env.DB.prepare('SELECT content_r2_key, status, display_mode FROM articles WHERE id = ?1')
      .bind(articleId).first<{ content_r2_key: string | null; status: string; display_mode: string }>();
    if (current?.content_r2_key !== sourceKey || current.status !== 'published' || current.display_mode !== 'full') {
      throw new AppError('BAD_REQUEST', 'Source document or visibility changed during translation; restart from the current version', 409);
    }
    // The final file is written only after every block succeeds. Partial work is private.
    await putJson(env.ARCHIVE, paths.finished, { sourceKey, translationVersion: TRANSLATION_VERSION, document: translated });
    await env.ARCHIVE.delete(paths.progress);
    return { done: true, translated: units.length, total: units.length };
  }
  return { done: false, translated: progress.cursor, total: units.length };
}
