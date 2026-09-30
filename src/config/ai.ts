/**
 * SPEC §32 — Workers AI configuration.
 *
 * SPEC §32: "模型选择不要硬编码成永久标准" (do not hard-code the model as a permanent
 * standard) — the catalogue moves, so the model id is a single overridable value
 * and Phase 4 must read the live catalogue before assuming a default still exists.
 *
 * Phase 1 defines the config only; no AI call happens before Phase 4.
 */

export interface AiConfig {
  model: string;
  embeddingModel: string;
  /** SPEC §13.4 — never hand arbitrary HTML to a model; cap the plain-text input. */
  maxInputChars: number;
  /** SPEC §13.2 — retry on schema mismatch before giving up. */
  maxSchemaAttempts: number;
  /** SPEC §36 — AI is only re-run when one of these actually changes. */
  promptVersion: number;
}

export const AI_CONFIG: AiConfig = {
  model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  embeddingModel: '@cf/baai/bge-base-en-v1.5',
  maxInputChars: 30000,
  maxSchemaAttempts: 3,
  promptVersion: 1,
};

/** SPEC §13.5 — top-level categories. Topics are tags, assigned in Phase 4. */
export const CATEGORY_SLUGS = ['ai', 'technology', 'business', 'science', 'ideas'] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];
