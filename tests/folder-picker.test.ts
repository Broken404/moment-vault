import { afterEach, expect, it, vi } from 'vitest';
import { host } from '../apps/extension/src/api';

const managerUrl = 'chrome-extension://hpchplafhkkndbocdiopnbmkkhbjokii/manage.html';

afterEach(() => vi.unstubAllGlobals());

it('opens successive folder pickers from the settings page instead of the windowless worker', async () => {
  vi.stubGlobal('location', { href: managerUrl + '#settings' });
  const sendMessage = vi.fn(async () => ({ ok: true, result: { cancelled: true, path: null } }));
  const sendNativeMessage = vi.fn(async (_name, request) => ({
    id: request.id,
    ok: true,
    result: {
      cancelled: false,
      path: request.payload.title === '选择草稿箱' ? 'C:\\draft' : 'D:\\library',
    },
  }));
  vi.stubGlobal('chrome', {
    runtime: { getURL: () => managerUrl, sendMessage, sendNativeMessage },
  });
  expect(await host('folder.pick', { title: '选择草稿箱', initial: '' })).toEqual({
    cancelled: false,
    path: 'C:\\draft',
  });
  expect(await host('folder.pick', { title: '选择资产库', initial: '' })).toEqual({
    cancelled: false,
    path: 'D:\\library',
  });
  expect(sendNativeMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(sendNativeMessage.mock.calls[0][0]).toBe('com.momentvault.host');
  expect(sendNativeMessage.mock.calls[0][1].protocol).toBe(1);
  expect(sendNativeMessage.mock.calls[0][1].op).toBe('folder.pick');
});

it('keeps folder picking unavailable to ordinary content scripts', async () => {
  vi.stubGlobal('location', { href: 'https://example.com/manage.html#settings' });
  const sendMessage = vi.fn(async () => ({ ok: true, result: {} }));
  const sendNativeMessage = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { getURL: () => managerUrl, sendMessage, sendNativeMessage },
  });
  await expect(host('folder.pick')).rejects.toThrow('设置页');
  expect(sendNativeMessage).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

it('allows retry after a cancelled picker and leaves ordinary operations on the worker', async () => {
  vi.stubGlobal('location', { href: managerUrl + '#settings' });
  const sendMessage = vi.fn(async () => ({ ok: true, result: { configured: true } }));
  const sendNativeMessage = vi.fn(async (_name, request) => ({
    id: request.id,
    ok: true,
    result: { cancelled: true, path: null },
  }));
  vi.stubGlobal('chrome', {
    runtime: { getURL: () => managerUrl, sendMessage, sendNativeMessage },
  });
  expect(await host('folder.pick')).toEqual({ cancelled: true, path: null });
  expect(await host('folder.pick')).toEqual({ cancelled: true, path: null });
  expect(sendNativeMessage).toHaveBeenCalledTimes(2);
  expect(await host('ping')).toEqual({ configured: true });
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
