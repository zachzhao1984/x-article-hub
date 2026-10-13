import { expect, it, vi } from 'vitest';
import { ensureArticleCover } from '../../src/services/cover';

it('skips AI generation when an archived card image already exists', async () => {
  const first = vi.fn().mockResolvedValue({ id: 'body_image' });
  const prepare = vi.fn().mockReturnValue({ bind: () => ({ first }) });
  const run = vi.fn();
  const env = { DB: { prepare }, AI: { run } } as unknown as Env;
  expect(await ensureArticleCover(env, 'a')).toBeNull();
  expect(prepare.mock.calls[0]?.[0]).toContain("kind IN ('body', 'cover')");
  expect(run).not.toHaveBeenCalled();
});

it('starts generation when no card image exists', async () => {
  const first = vi.fn().mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'a', title: 'Title', category_name: null })
    .mockResolvedValueOnce(null);
  const run = vi.fn().mockRejectedValue(new Error('daily quota exhausted'));
  const env = { DB: { prepare: () => ({ bind: () => ({ first }) }) }, AI: { run } } as unknown as Env;
  expect(await ensureArticleCover(env, 'a')).toMatchObject({ ok: false, errorCode: 'MODEL_UNAVAILABLE' });
  expect(run).toHaveBeenCalledOnce();
});
