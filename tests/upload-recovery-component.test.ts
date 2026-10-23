import { afterEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement, useState } from 'react';
import { UploadRecovery } from '../apps/extension/src/upload-recovery';
import type { UploadProgress, UploadSummary } from '../apps/extension/src/api';

let mounted: Root | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});
const id = 'a'.repeat(32),
  root = 'D:\\draft';
function fixture(complete: boolean) {
  const summary: UploadSummary = {
    id,
    name: '重启后保留的素材',
    createdAt: '',
    fileCount: 2,
    completeFiles: complete ? 2 : 1,
    receivedBytes: 12,
    totalBytes: 16,
  };
  const progress: UploadProgress = {
    phase: 'pending',
    id,
    name: summary.name,
    createdAt: '',
    files: [
      {
        id: 'b'.repeat(32),
        fileName: '图片-001.png',
        originalName: 'finished.png',
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
        bytes: 4,
        lastModified: 123,
        complete,
        receivedBytes: 0,
      },
    ],
  };
  let jobs = [summary];
  const calls: { op: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: (typeof calls)[number]) => {
        calls.push(message);
        if (message.op === 'uploads.list')
          return { ok: true, result: { items: jobs, total: jobs.length, warnings: [] } };
        if (message.op === 'uploads.get') return { ok: true, result: progress };
        if (message.op === 'items.commit' || message.op === 'uploads.discard') jobs = [];
        return { ok: true, result: { id } };
      },
    },
  });
  return { calls };
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  )!;
}
function mount() {
  document.body.innerHTML = '<div id="recovery"></div>';
  const changed = vi.fn(async () => {}),
    show = vi.fn();
  function Harness() {
    const [busy, setBusy] = useState(false);
    return createElement(UploadRecovery, {
      root,
      disabled: busy,
      refreshKey: 0,
      busy: setBusy,
      changed,
      show,
    });
  }
  mounted = createRoot(document.getElementById('recovery')!);
  mounted.render(createElement(Harness));
  return { changed, show };
}

it('finds all-received work after remount and double clicks publish once without selecting files', async () => {
  const { calls } = fixture(true);
  mount();
  await vi.waitFor(() => expect(button('继续保存')).toBeTruthy());
  mounted!.unmount();
  mounted = undefined;
  const { changed, show } = mount();
  await vi.waitFor(() => expect(button('继续保存')).toBeTruthy());
  const resume = button('继续保存');
  resume.click();
  resume.click();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(id));
  expect(calls.filter((c) => c.op === 'items.commit')).toHaveLength(1);
  expect(calls.some((c) => c.op === 'items.begin' || c.op === 'items.append')).toBe(false);
  expect(show).toHaveBeenCalledWith('已继续保存到草稿箱');
});
it('shows only missing originals, ignores a cancelled picker and keeps a mismatched selection retryable', async () => {
  const { calls } = fixture(false);
  const { changed } = mount();
  await vi.waitFor(() => expect(button('选择原文件继续')).toBeTruthy());
  button('选择原文件继续').click();
  await vi.waitFor(() =>
    expect(document.querySelector('.recovery-choice')?.textContent).toContain('remaining.png'),
  );
  expect(document.querySelector('.recovery-choice')?.textContent).not.toContain('finished.png');
  const picker = document.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: [], configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(calls.filter((c) => c.op === 'items.append')).toHaveLength(0);
  Object.defineProperty(picker, 'files', {
    value: [new File(['xxxx'], 'wrong.png', { lastModified: 123 })],
    configurable: true,
  });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[role=alert]')?.textContent).toContain('原文件不匹配'),
  );
  expect(calls.some((c) => c.op === 'items.append' || c.op === 'items.commit')).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(button('选择原文件继续').disabled).toBe(false);
  button('选择原文件继续').click();
  await vi.waitFor(() => expect(document.querySelector('.recovery-choice')).toBeTruthy());
  const selected = new File(['xxxx'], 'remaining.png', { type: 'image/png', lastModified: 123 });
  Object.defineProperty(selected, 'slice', {
    value: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }),
  });
  Object.defineProperty(picker, 'files', { value: [selected], configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(id));
  expect(calls.filter((c) => c.op === 'items.append')).toHaveLength(1);
  expect(calls.filter((c) => c.op === 'items.commit')).toHaveLength(1);
});
it('deletes only the selected pending work after one explicit confirmation', async () => {
  const { calls } = fixture(false);
  const { changed } = mount();
  await vi.waitFor(() => expect(button('删除未完成保存')).toBeTruthy());
  button('删除未完成保存').click();
  await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).toBeTruthy());
  expect(calls.some((c) => c.op === 'uploads.discard')).toBe(false);
  button('取消').click();
  await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull());
  button('删除未完成保存').click();
  await vi.waitFor(() => expect(button('确认删除')).toBeTruthy());
  button('确认删除').click();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(id));
  expect(calls.filter((c) => c.op === 'uploads.discard')).toEqual([
    {
      target: 'background',
      type: 'host',
      op: 'uploads.discard',
      payload: { draftRoot: root, uploadId: id, confirmed: true },
    },
  ]);
  expect(calls.some((c) => c.op === 'items.delete')).toBe(false);
});
it('does not display a late pending list from a directory that was switched away', async () => {
  let oldReply: (value: unknown) => void = () => {};
  let oldRequested = false;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (message: { payload: { draftRoot: string } }) => {
        if (message.payload.draftRoot === root) {
          oldRequested = true;
          return new Promise((resolve) => {
            oldReply = resolve;
          });
        }
        return { ok: true, result: { items: [], total: 0, warnings: [] } };
      },
    },
  });
  document.body.innerHTML = '<div id="recovery"></div>';
  mounted = createRoot(document.getElementById('recovery')!);
  const props = {
    disabled: false,
    refreshKey: 0,
    busy: () => {},
    changed: async () => {},
    show: () => {},
  };
  mounted.render(createElement(UploadRecovery, { ...props, root }));
  await vi.waitFor(() => expect(oldRequested).toBe(true));
  mounted.render(createElement(UploadRecovery, { ...props, root: 'E:\\another' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  oldReply({ ok: true, result: { items: [{ id, name: '旧目录任务' }], total: 1, warnings: [] } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.body.textContent).not.toContain('旧目录任务');
});
