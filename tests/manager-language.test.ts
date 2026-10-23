import { expect, it, vi } from 'vitest';
import { act } from 'react';
import { DEFAULT_PREFERENCES, type Material } from '../packages/shared/src/model';

it('loads the saved override, persists a switch and synchronizes an open dirty material without changing data', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  location.hash = 'settings';
  let stored = { ...DEFAULT_PREFERENCES, language: 'en' as 'en' | 'zh-CN' | 'system' };
  let failSave = false;
  const changes = new Set<(change: object, area: string) => void>();
  const notify = () => changes.forEach((fn) => fn({ preferences: { newValue: stored } }, 'local'));
  const material = {
    formatVersion: 1,
    id: '1'.repeat(32),
    name: '草稿箱',
    note: '设置是我的创作备注',
    revision: 'a'.repeat(64),
    createdAt: '2026-10-24T04:00:00Z',
    bucket: 'draft',
    folderName: 'owned-material',
    attachments: [
      {
        id: 'f1',
        kind: 'video',
        fileName: '视频-001.mp4',
        bytes: 12,
        source: 'https://example.com/草稿箱',
        note: '已保存',
      },
    ],
  } as Material;
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === 'preferences') {
      if (failSave) return { ok: false, error: { message: '设置保存失败' } };
      stored = { ...stored, ...(message.patch as object) };
      notify();
      return stored;
    }
    if (message.type === 'commands')
      return [
        { name: 'record-selection', shortcut: 'Ctrl+Shift+9', description: '开始录制／提前结束' },
      ];
    if (message.type === 'recording-jobs')
      return {
        ok: true,
        jobs: [
          {
            id: 'r1',
            name: '录制素材的原名称',
            phase: 'failed',
            message: '没有收到录制画面，原录制已保留',
          },
        ],
      };
    if (message.op === 'ping')
      return {
        ok: true,
        result: {
          configured: true,
          config: { draftRoot: 'D:\\draft', libraryRoot: 'D:\\library' },
        },
      };
    if (message.op === 'items.list')
      return { ok: true, result: { items: [material], total: 1, warnings: [] } };
    if (message.op === 'uploads.list')
      return { ok: true, result: { items: [], total: 0, warnings: [] } };
    throw new Error('Unexpected request ' + message.op);
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('chrome', {
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: {
      local: {
        get: async () => ({ preferences: stored }),
        set: async () => {},
        remove: async () => {},
      },
      onChanged: {
        addListener: (fn: (change: object, area: string) => void) => changes.add(fn),
        removeListener: (fn: (change: object, area: string) => void) => changes.delete(fn),
      },
    },
    runtime: { sendMessage: send },
  });
  await import('../apps/extension/src/manage');
  const heading = () => document.querySelector('h1')?.textContent;
  await vi.waitFor(() => expect(heading()).toBe('Settings'));
  expect(document.documentElement.lang).toBe('en');
  expect(document.title).toBe('Moment Vault');
  expect(document.body.textContent).toContain('Start recording / stop early');
  const language = document.querySelector<HTMLSelectElement>('select[name="language"]')!;
  expect(language.value).toBe('en');
  language.value = 'zh-CN';
  language.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(heading()).toBe('设置'));
  expect(stored.language).toBe('zh-CN');
  await vi.waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('已保存'));
  failSave = true;
  language.value = 'en';
  language.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('设置保存失败'),
  );
  expect(stored.language).toBe('zh-CN');
  expect(heading()).toBe('设置');
  location.hash = 'draft';
  await vi.waitFor(() => expect(document.querySelectorAll('.material-row')).toHaveLength(1));
  await vi.waitFor(() => expect(document.querySelector('.detail input')).toBeTruthy());
  // Flush initial detail effects before simulating a human editing the painted form.
  await act(async () => {});
  const name = document.querySelector<HTMLInputElement>('.detail input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
    name,
    '未保存的中文标题',
  );
  name.dispatchEvent(new Event('input', { bubbles: true }));
  await act(async () => {});
  stored = { ...stored, language: 'en' };
  notify();
  await vi.waitFor(() => expect(heading()).toBe('Drafts'));
  expect(name.value).toBe('未保存的中文标题');
  expect(document.querySelector('.material-row b')?.textContent).toBe('草稿箱');
  expect(document.querySelector('.material-row small')?.textContent).toContain('1 attachment');
  expect(document.querySelector('.attachment-fields b')?.textContent).toBe('视频-001.mp4');
  expect(document.querySelector<HTMLTextAreaElement>('.attachment-fields textarea')?.value).toBe(
    '已保存',
  );
  expect(document.querySelectorAll<HTMLTextAreaElement>('.detail textarea')[1]?.value).toBe(
    '设置是我的创作备注',
  );
  expect(send.mock.calls.filter(([message]) => message.op === 'items.update')).toHaveLength(0);
});
