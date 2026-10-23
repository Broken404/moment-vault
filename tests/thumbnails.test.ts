import { expect, it, vi } from 'vitest';
import type { Material } from '../packages/shared/src/model';
import {
  attachmentCounts,
  ThumbnailLoader,
  type ThumbnailReply,
} from '../apps/extension/src/thumbnails';

const item = (id: string) =>
  ({
    id,
    revision: id,
    attachments: [
      { id: 'file-' + id, kind: 'image', fileName: id + '.png', sha256: id, bytes: 10 },
    ],
  }) as Material;
const ready: ThumbnailReply = { phase: 'ready', mime: 'image/png', base64: 'YQ==' };

it('limits active requests and starts queued work only after a slot is released', async () => {
  const finish: ((value: ThumbnailReply) => void)[] = [];
  const request = vi.fn(() => new Promise<ThumbnailReply>((resolve) => finish.push(resolve)));
  const loader = new ThumbnailLoader(request);
  const jobs = ['a', 'b', 'c'].map((id) =>
    loader.load('root', 'draft', item(id), new AbortController().signal),
  );
  expect(request).toHaveBeenCalledTimes(2);
  finish[0](ready);
  await jobs[0];
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  finish[1](ready);
  finish[2](ready);
  await Promise.all(jobs);
});

it('shares in-flight work while allowing one subscriber to leave without cancelling another', async () => {
  let finish: (value: ThumbnailReply) => void = () => {};
  const request = vi.fn(
    () =>
      new Promise<ThumbnailReply>((resolve) => {
        finish = resolve;
      }),
  );
  const loader = new ThumbnailLoader(request);
  const first = new AbortController();
  const a = loader.load('root', 'draft', item('a'), first.signal);
  const b = loader.load('root', 'draft', item('a'), new AbortController().signal);
  const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
  first.abort();
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  finish(ready);
  expect(await b).toContain('data:image/png');
  await loader.load('root', 'draft', item('a'), new AbortController().signal);
  expect(request).toHaveBeenCalledTimes(1);
});

it('drops invisible queued work and never caches a cancelled active result', async () => {
  let finish: (value: ThumbnailReply) => void = () => {};
  const request = vi.fn(
    () =>
      new Promise<ThumbnailReply>((resolve) => {
        finish = resolve;
      }),
  );
  const loader = new ThumbnailLoader(request, 1000, 1);
  const active = new AbortController(),
    queued = new AbortController();
  const a = loader.load('root', 'draft', item('a'), active.signal);
  const b = loader.load('root', 'draft', item('b'), queued.signal);
  const ar = expect(a).rejects.toMatchObject({ name: 'AbortError' });
  const br = expect(b).rejects.toMatchObject({ name: 'AbortError' });
  queued.abort();
  active.abort();
  finish(ready);
  await Promise.all([ar, br]);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  request.mockResolvedValue(ready);
  await loader.load('root', 'draft', item('a'), new AbortController().signal);
  expect(request).toHaveBeenCalledTimes(2);
});

it('frees a cancelled slot immediately even if the old native response never arrives', async () => {
  const request = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(ready);
  const loader = new ThumbnailLoader(request, 1000, 1);
  const controller = new AbortController();
  const old = loader.load('root', 'draft', item('old'), controller.signal);
  const next = loader.load('root', 'draft', item('next'), new AbortController().signal);
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejected;
  expect(await next).toContain('data:image/png');
  expect(request).toHaveBeenCalledTimes(2);
});

it('isolates directories and revisions and evicts the oldest entries to respect the memory budget', async () => {
  const request = vi.fn(async () => ready);
  const loader = new ThumbnailLoader(request, 110);
  for (const id of ['a', 'b', 'c'])
    await loader.load('root', 'draft', item(id), new AbortController().signal);
  await loader.load('root', 'draft', item('a'), new AbortController().signal);
  expect(request).toHaveBeenCalledTimes(4);
  await loader.load('other-root', 'draft', item('a'), new AbortController().signal);
  await loader.load(
    'other-root',
    'draft',
    { ...item('a'), revision: 'changed' },
    new AbortController().signal,
  );
  expect(request).toHaveBeenCalledTimes(6);
});

it('polls only pending work and tries the next attachment when a cover is unavailable', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ phase: 'loading' })
    .mockResolvedValueOnce({ phase: 'unavailable' })
    .mockResolvedValueOnce(ready);
  const pause = vi.fn(async () => {});
  const loader = new ThumbnailLoader(request, 1000, 2, pause);
  const mixed = { ...item('a'), attachments: [...item('a').attachments, ...item('b').attachments] };
  expect(await loader.load('root', 'draft', mixed, new AbortController().signal)).toContain(
    'data:image/png',
  );
  expect(request.mock.calls.map((call) => call[2])).toEqual(['file-a', 'file-a', 'file-b']);
  expect(pause).toHaveBeenCalledTimes(1);
});

it('rejects oversized previews and reports image/video counts without loading originals', async () => {
  const request = vi.fn(
    async () =>
      ({ phase: 'ready', mime: 'image/png', base64: 'A'.repeat(220_001) }) as ThumbnailReply,
  );
  expect(
    await new ThumbnailLoader(request).load(
      'root',
      'draft',
      item('a'),
      new AbortController().signal,
    ),
  ).toBeNull();
  expect(
    attachmentCounts([
      { kind: 'image' },
      { kind: 'video' },
      { kind: 'image' },
    ] as Material['attachments']),
  ).toBe('2 张图片 · 1 段视频');
});
