import type { Material, MergeResult } from '@shared/model';
import { host, HostError } from './api';

export interface PendingMerge {
  operationId: string;
  draftRoot: string;
  selection: { id: string; revision: string }[];
}

function key(root: string): string {
  return 'pendingMerge:' + root.replace(/[\\/]+$/, '').toLowerCase();
}

export function prepareMerge(
  items: Material[],
  selected: string[],
  draftRoot: string,
): PendingMerge {
  // Checkbox click order must not reorder attachments: use the visible list.
  const selection = items.filter((item) => selected.includes(item.id));
  if (selection.length < 2 || selection.length > 200 || selection.length !== selected.length)
    throw new Error('请选择列表中的 2–200 条草稿');
  return {
    operationId: crypto.randomUUID().replaceAll('-', ''),
    draftRoot,
    selection: selection.map(({ id, revision }) => ({ id, revision })),
  };
}

export async function pendingMerge(root: string): Promise<PendingMerge | null> {
  const value = (await chrome.storage.local.get(key(root)))[key(root)] as
    Partial<PendingMerge> | undefined;
  return value &&
    typeof value.operationId === 'string' &&
    /^[a-f0-9]{32}$/.test(value.operationId) &&
    typeof value.draftRoot === 'string' &&
    key(value.draftRoot) === key(root) &&
    Array.isArray(value.selection) &&
    value.selection.length >= 2 &&
    value.selection.length <= 200 &&
    value.selection.every(
      (s) =>
        typeof s?.id === 'string' &&
        /^[a-f0-9]{32}$/.test(s.id) &&
        typeof s?.revision === 'string' &&
        /^[a-f0-9]{64}$/.test(s.revision),
    )
    ? (value as PendingMerge)
    : null;
}

export async function submitMerge(request: PendingMerge): Promise<MergeResult> {
  const storageKey = key(request.draftRoot);
  // Persist before sending, so a page reload or a lost native response can retry
  // the same operation rather than create another material.
  await chrome.storage.local.set({ [storageKey]: request });
  try {
    const result = await host<MergeResult>('items.merge', {
      operationId: request.operationId,
      draftRoot: request.draftRoot,
      selection: request.selection,
    });
    if (result.status === 'merged') await chrome.storage.local.remove(storageKey);
    return result;
  } catch (error) {
    if (error instanceof HostError && error.code === 'merge-not-created')
      await chrome.storage.local.remove(storageKey);
    throw error;
  }
}
