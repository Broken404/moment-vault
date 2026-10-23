import { expect, it, vi } from 'vitest';
import type { Material } from '../packages/shared/src/model';

it('wires the real manager selection, dirty-edit guard, single submission and merged detail', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  location.hash = 'draft';
  const files = [0, 1].map((n) => ({
    formatVersion: 1,
    id: String(n + 1).repeat(32),
    name: `草稿 ${n + 1}`,
    createdAt: '2026-10-23T12:00:00Z',
    attachments: [
      { id: `file${n}`, fileName: '视频-001.mp4', kind: 'video', bytes: 12, source: '', note: '' },
    ],
    note: '',
    revision: String(n).repeat(64),
    bucket: 'draft',
    folderName: `folder${n}`,
  })) as Material[];
  let current = files;
  let complete: (value: unknown) => void = () => {};
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      sendMessage: async (message: Record<string, unknown>) => {
        if (message.type === 'recording-jobs') return { ok: true, jobs: [] };
        if (message.op === 'ping')
          return {
            ok: true,
            result: {
              configured: true,
              config: { draftRoot: 'D:\\draft', libraryRoot: 'D:\\library' },
            },
          };
        if (message.op === 'items.list')
          return { ok: true, result: { items: current, total: current.length, warnings: [] } };
        if (message.op === 'items.merge') {
          calls.push(message);
          return new Promise((resolve) => {
            complete = resolve;
          });
        }
        throw new Error(`Unexpected manager request ${message.op}`);
      },
    },
  });
  await import('../apps/extension/src/manage');
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  await vi.waitFor(() => expect(document.querySelectorAll('.material-row')).toHaveLength(2));
  expect(button('合并为一条').disabled).toBe(true);
  const choices = document.querySelectorAll<HTMLInputElement>('.material-row input');
  choices[1].click();
  choices[0].click();
  await vi.waitFor(() => expect(button('合并为一条').disabled).toBe(false));
  const name = document.querySelector<HTMLInputElement>('.detail input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '未保存');
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(button('合并为一条').disabled).toBe(true));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
    name,
    files[0].name,
  );
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(button('合并为一条').disabled).toBe(false));
  button('合并为一条').click();
  button('合并为一条').click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect((calls[0].payload as { selection: { id: string }[] }).selection.map((s) => s.id)).toEqual(
    files.map((f) => f.id),
  );
  current = [
    {
      ...files[0],
      id: '9'.repeat(32),
      name: '合并草稿',
      attachments: files.flatMap((f) => f.attachments),
    },
  ];
  complete({ ok: true, result: { status: 'merged', item: current[0], retainedSourceIds: [] } });
  await vi.waitFor(() => expect(document.querySelectorAll('.material-row')).toHaveLength(1));
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLInputElement>('.detail input')?.value).toBe('合并草稿'),
  );
  expect(document.body.textContent).toContain('已将 2 条草稿合并为一条 · 2 个附件');
});
