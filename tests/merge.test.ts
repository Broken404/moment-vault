import { beforeEach, expect, it, vi } from 'vitest';
import type { Material, MergeResult } from '../packages/shared/src/model';
import { pendingMerge, prepareMerge, submitMerge } from '../apps/extension/src/merge';

const items = ['a', 'b', 'c'].map((letter, index) => ({
  id: letter.repeat(32),
  revision: String(index).repeat(64),
})) as Material[];
let stored: Record<string, unknown>;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stored = {};
  send = vi.fn();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
        },
        remove: async (key: string) => {
          delete stored[key];
        },
      },
    },
    runtime: { sendMessage: send },
  });
});

it('uses visible list order rather than checkbox click order and refuses unloaded selections', () => {
  const request = prepareMerge(items, [items[2].id, items[0].id], 'D:\\draft');
  expect(request.selection.map((s) => s.id)).toEqual([items[0].id, items[2].id]);
  expect(() => prepareMerge(items, [items[0].id], 'D:\\draft')).toThrow();
  expect(() => prepareMerge(items, [items[0].id, 'unloaded'], 'D:\\draft')).toThrow();
});

it('persists before sending and reuses the same operation after a lost successful reply', async () => {
  const request = prepareMerge(items, [items[0].id, items[1].id], 'D:\\draft');
  send
    .mockImplementationOnce(async () => {
      expect(await pendingMerge('d:\\draft\\')).toEqual(request);
      throw new Error('lost reply after commit');
    })
    .mockResolvedValueOnce({
      ok: true,
      result: { status: 'merged', item: { id: request.operationId }, retainedSourceIds: [] },
    });
  await expect(submitMerge(request)).rejects.toThrow('lost reply');
  const restored = await pendingMerge('D:\\draft');
  expect(restored).toEqual(request);
  await submitMerge(restored!);
  expect(send.mock.calls[0][0].payload).toEqual(send.mock.calls[1][0].payload);
  expect(await pendingMerge('D:\\draft')).toBeNull();
});

it('keeps the recovery request when the verified result still has source cleanup pending', async () => {
  const request = prepareMerge(items, [items[0].id, items[1].id], 'D:\\draft');
  send.mockResolvedValue({
    ok: true,
    result: {
      status: 'source-retained',
      item: items[0],
      retainedSourceIds: [items[0].id],
    } satisfies Partial<MergeResult>,
  });
  await submitMerge(request);
  expect(await pendingMerge('D:\\draft')).toEqual(request);
  expect(await pendingMerge('E:\\another-draft')).toBeNull();
});

it('clears a rejected pre-publication choice but keeps an ambiguous or changed-target result', async () => {
  const request = prepareMerge(items, [items[0].id, items[1].id], 'D:\\draft');
  send.mockResolvedValueOnce({
    ok: false,
    error: { code: 'merge-not-created', message: 'source changed' },
  });
  await expect(submitMerge(request)).rejects.toThrow('source changed');
  expect(await pendingMerge('D:\\draft')).toBeNull();
  send.mockResolvedValueOnce({
    ok: false,
    error: { code: 'merge-target-changed', message: 'inspect target' },
  });
  await expect(submitMerge(request)).rejects.toThrow('inspect target');
  expect(await pendingMerge('D:\\draft')).toEqual(request);
});

it('does not send a merge if persisting its retry identity fails', async () => {
  chrome.storage.local.set = vi.fn().mockRejectedValue(new Error('storage unavailable'));
  await expect(
    submitMerge(prepareMerge(items, [items[0].id, items[1].id], 'D:\\draft')),
  ).rejects.toThrow('storage unavailable');
  expect(send).not.toHaveBeenCalled();
});
