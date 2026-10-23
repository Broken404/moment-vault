import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Material } from '../packages/shared/src/model';
import { Thumbnail } from '../apps/extension/src/thumbnail';
import { thumbnails } from '../apps/extension/src/thumbnails';

let root: Root;
let observe: (entries: { isIntersecting: boolean }[]) => void;
let send: ReturnType<typeof vi.fn>;
const material = (id: string) =>
  ({
    id,
    revision: id,
    attachments: [
      { id: id + '-file', kind: 'video', fileName: 'video.mp4', sha256: id, bytes: 100 },
    ],
  }) as Material;
beforeEach(() => {
  observe = undefined!;
  document.body.innerHTML = '<div id="thumbnail-root"></div>';
  root = createRoot(document.getElementById('thumbnail-root')!);
  thumbnails.clear();
  send = vi.fn(async () => ({
    ok: true,
    result: { phase: 'ready', mime: 'image/png', base64: 'YQ==' },
  }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof observe) {
        observe = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => root.unmount());
const show = (id: string) =>
  root.render(
    createElement(Thumbnail, { scope: 'root', bucket: 'draft', item: material(id), refresh: 0 }),
  );

it('loads only near the viewport and releases displayed data when the row leaves', async () => {
  show('visible');
  await vi.waitFor(() => expect(observe).toBeTypeOf('function'));
  expect(send).not.toHaveBeenCalled();
  observe([{ isIntersecting: true }]);
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  expect(send.mock.calls[0][0].op).toBe('items.thumbnail');
  observe([{ isIntersecting: false }]);
  await vi.waitFor(() => expect(document.querySelector('img')).toBeNull());
  observe([{ isIntersecting: true }]);
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  expect(send).toHaveBeenCalledTimes(1);
});

it('a result for an old material cannot paint a replacement row', async () => {
  const done: ((result: unknown) => void)[] = [];
  send.mockImplementation(() => new Promise((resolve) => done.push(resolve)));
  show('old');
  await vi.waitFor(() => expect(observe).toBeTypeOf('function'));
  observe([{ isIntersecting: true }]);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  show('new');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  done[0]({ ok: true, result: { phase: 'ready', mime: 'image/png', base64: 'b2xk' } });
  await Promise.resolve();
  expect(document.querySelector('img')).toBeNull();
  done[1]({ ok: true, result: { phase: 'ready', mime: 'image/png', base64: 'bmV3' } });
  await vi.waitFor(() =>
    expect(document.querySelector('img')?.getAttribute('src')).toContain('bmV3'),
  );
});

it('a failed image decode keeps an operable type placeholder', async () => {
  show('decode-error');
  await vi.waitFor(() => expect(observe).toBeTypeOf('function'));
  observe([{ isIntersecting: true }]);
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull());
  document.querySelector('img')!.dispatchEvent(new Event('error'));
  await vi.waitFor(() => expect(document.querySelector('img')).toBeNull());
  expect(document.querySelector('.type-thumb')?.getAttribute('title')).toContain('本地打开');
});
