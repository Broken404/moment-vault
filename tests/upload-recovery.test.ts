import { beforeEach, expect, it, vi } from 'vitest';
import {
  beginUpload,
  resumeUpload,
  uploadFiles,
  type UploadProgress,
} from '../apps/extension/src/api';

const root = 'D:\\draft';
const id = 'a'.repeat(32);
const original = (name = 'remaining.png', size = 250_000, stamp = 123): File => {
  const file = new File([new Uint8Array(size)], name, { type: 'image/png', lastModified: stamp });
  Object.defineProperty(file, 'slice', {
    value: (start: number, end: number) => ({
      arrayBuffer: async () => new Uint8Array(Math.min(end, size) - start).fill(17).buffer,
    }),
  });
  return file;
};
function progress(): UploadProgress {
  return {
    phase: 'pending',
    id,
    name: '原素材名称',
    createdAt: '',
    files: [
      {
        id: 'b'.repeat(32),
        fileName: '图片-001.png',
        originalName: 'complete.png',
        extension: 'png',
        kind: 'image',
        mime: 'image/png',
        bytes: 12,
        lastModified: 123,
        complete: true,
        receivedBytes: 12,
      },
      {
        id: 'c'.repeat(32),
        fileName: '图片-002.png',
        originalName: 'remaining.png',
        extension: 'png',
        kind: 'image',
        mime: 'image/png',
        bytes: 250_000,
        lastModified: 123,
        complete: false,
        receivedBytes: 192 * 1024,
      },
    ],
  };
}
beforeEach(() => vi.unstubAllGlobals());
function backend(value = progress(), failPrefix = false) {
  const calls: { op: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: (typeof calls)[number]) => {
        calls.push(message);
        if (message.op === 'uploads.get') return { ok: true, result: value };
        if (message.op === 'items.append' && failPrefix)
          return { ok: false, error: { code: 'chunk-conflict', message: '已收到的内容不一致' } };
        return { ok: true, result: { id } };
      },
    },
  });
  return calls;
}

it('recovers after all page state was lost, rechecks the retained prefix and keeps completed attachments', async () => {
  const calls = backend();
  await resumeUpload(root, id, [original()], () => {});
  expect(calls.map((c) => c.op)).toEqual([
    'uploads.get',
    'items.append',
    'items.append',
    'items.finishFile',
    'items.commit',
  ]);
  expect(calls.filter((c) => c.op === 'items.append').map((c) => c.payload.sequence)).toEqual([
    0, 1,
  ]);
  expect(calls.every((c) => c.payload.draftRoot === root && c.payload.uploadId === id)).toBe(true);
  expect(calls.some((c) => c.payload.attachmentId === 'b'.repeat(32))).toBe(false);
});
it('rejects wrong or changed originals before transmitting any content', async () => {
  for (const input of [
    original('wrong.png'),
    original('remaining.png', 249_999),
    original('remaining.png', 250_000, 124),
  ]) {
    const calls = backend();
    await expect(resumeUpload(root, id, [input], () => {})).rejects.toThrow('原文件不匹配');
    expect(calls.map((c) => c.op)).toEqual(['uploads.get']);
  }
});
it('stops at a conflicting retained prefix and never finishes or commits', async () => {
  const calls = backend(progress(), true);
  await expect(resumeUpload(root, id, [original()], () => {})).rejects.toThrow('内容不一致');
  expect(calls.map((c) => c.op)).toEqual(['uploads.get', 'items.append']);
});
it('finishes an all-received upload without asking for files, or returns an already saved result', async () => {
  const value = progress();
  value.files.forEach((f) => (f.complete = true));
  const calls = backend(value);
  await resumeUpload(root, id, [], () => {});
  expect(calls.map((c) => c.op)).toEqual(['uploads.get', 'items.commit']);
  value.phase = 'saved';
  value.item = { id } as NonNullable<UploadProgress['item']>;
  const replay = backend(value);
  expect((await resumeUpload(root, id, [], () => {})).id).toBe(id);
  expect(replay.map((c) => c.op)).toEqual(['uploads.get']);
});
it('matches reselected originals in any order while transmitting attachments in their original order', async () => {
  const value = progress();
  value.files[0] = { ...value.files[0], complete: false, receivedBytes: 0 };
  const calls = backend(value);
  await resumeUpload(root, id, [original(), original('complete.png', 12)], () => {});
  expect(
    calls.filter((c) => c.op === 'items.finishFile').map((c) => c.payload.attachmentId),
  ).toEqual(value.files.map((f) => f.id));
});
it('uses native completion after a lost finish acknowledgement instead of appending to a closed attachment', async () => {
  const files = [original('complete.png', 12)];
  const batch = { ...beginUpload(files), draftRoot: root };
  const calls: string[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: { op: string }) => {
        calls.push(message.op);
        return {
          ok: true,
          result:
            message.op === 'items.begin'
              ? { recovery: { phase: 'pending', files: [{ complete: true }] } }
              : { id: batch.uploadId },
        };
      },
    },
  });
  await uploadFiles(files, batch, () => {});
  expect(calls).toEqual(['items.begin', 'items.commit']);
});
