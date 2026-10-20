import { beforeEach, expect, it, vi } from 'vitest';
import { beginUpload, setPreferences, uploadFiles } from '../apps/extension/src/api';

beforeEach(() => {
  vi.unstubAllGlobals();
});

function image(name = 'picture.png', size = 250_000): File {
  // jsdom's File has no arrayBuffer; this represents actual file bytes at the
  // browser API boundary, without claiming PNG decode or browser integration.
  const file = new File([new Uint8Array(size).fill(17)], name, { type: 'image/png' });
  Object.defineProperty(file, 'slice', { value: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(end, size) - start).fill(17).buffer }) });
  return file;
}

it('groups two files into one material and waits for each acknowledged chunk', async () => {
  const calls: { op: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message) => {
    calls.push(message);
    return { ok: true, result: message.op === 'items.commit' ? { id: message.payload.uploadId, attachments: [{}, {}] } : {} };
  }) } });
  const files = [image('one.png'), image('two.png', 12)];
  const batch = beginUpload(files);
  await uploadFiles(files, batch, () => {});
  expect(calls.filter(c => c.op === 'items.begin')).toHaveLength(1);
  expect(calls.filter(c => c.op === 'items.commit')).toHaveLength(1);
  const chunks = calls.filter(c => c.op === 'items.append');
  expect(chunks).toHaveLength(3);
  expect(chunks.map(c => c.payload.sequence)).toEqual([0, 1, 0]);
  expect(atob(chunks[0].payload.base64 as string)).toHaveLength(192 * 1024);
});

it('retries a lost chunk acknowledgement with the same upload and attachment IDs', async () => {
  let fail = true;
  const calls: { op: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message) => {
    calls.push(message);
    if (message.op === 'items.append' && message.payload.sequence === 1 && fail) { fail = false; throw new Error('connection lost after write'); }
    return { ok: true, result: { id: message.payload.uploadId } };
  }) } });
  const files = [image()]; const batch = beginUpload(files);
  await expect(uploadFiles(files, batch, () => {})).rejects.toThrow('connection lost');
  await uploadFiles(files, batch, () => {});
  const begins = calls.filter(c => c.op === 'items.begin');
  expect(begins[0].payload).toEqual(begins[1].payload);
  expect(calls.filter(c => c.op === 'items.append').map(c => c.payload.sequence)).toEqual([0, 1, 1]);
});

it('does not re-upload completed files when the commit response was lost', async () => {
  let lost = true; let writes = 0;
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message) => {
    if (message.op === 'items.append') writes++;
    if (message.op === 'items.commit' && lost) { lost = false; throw new Error('reply lost'); }
    return { ok: true, result: { id: message.payload.uploadId } };
  }) } });
  const files = [image('one.png', 12)]; const batch = beginUpload(files);
  await expect(uploadFiles(files, batch, () => {})).rejects.toThrow('reply lost');
  await uploadFiles(files, batch, () => {});
  expect(writes).toBe(1);
});

it('does not report failed preference persistence as saved', async () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ok: false, error: { message: 'storage unavailable' } }) } });
  await expect(setPreferences({ theme: 'dark' })).rejects.toThrow('storage unavailable');
});
