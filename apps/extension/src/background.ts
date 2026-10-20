import { DEFAULT_PREFERENCES, errorMessage, validatePreferences } from '@shared/model';
import type { HostOperation, HostRequest, HostResponse } from '@shared/model';

let port: chrome.runtime.Port | null = null;
const pending = new Map<
  string,
  { resolve: (response: HostResponse) => void; timer: ReturnType<typeof setTimeout> }
>();
function connect(): chrome.runtime.Port {
  if (port) return port;
  const connection = chrome.runtime.connectNative('com.momentvault.host');
  port = connection;
  connection.onMessage.addListener((response: HostResponse) => {
    const request = pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(response.id);
    request.resolve(response);
  });
  connection.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    if (port === connection) port = null;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({
        id,
        ok: false,
        error: {
          code: 'helper-disconnected',
          message: detail ? `本地助手未连接：${detail}` : '本地助手已断开，请重新检测',
          retryable: true,
        },
      });
    }
    pending.clear();
  });
  return connection;
}
export async function requestHost(
  op: HostOperation,
  payload: Record<string, unknown>,
): Promise<HostResponse> {
  const id = crypto.randomUUID();
  try {
    const connection = connect();
    return await new Promise<HostResponse>((resolve) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          resolve({
            id,
            ok: false,
            error: {
              code: 'helper-timeout',
              message: '本地操作尚未返回，请检查后重试；不要重复提交删除',
              retryable: true,
            },
          });
        },
        op === 'folder.pick' ? 10 * 60_000 : 120_000,
      );
      pending.set(id, { resolve, timer });
      const message: HostRequest = { protocol: 1, id, op, payload };
      connection.postMessage(message);
    });
  } catch (error) {
    const request = pending.get(id);
    if (request) clearTimeout(request.timer);
    pending.delete(id);
    return {
      id,
      ok: false,
      error: { code: 'helper-unavailable', message: errorMessage(error), retryable: true },
    };
  }
}

async function manager(page = 'draft') {
  const url = chrome.runtime.getURL('manage.html');
  const tabs = await chrome.tabs.query({ url: url + '*' });
  if (tabs[0]?.id !== undefined) {
    await chrome.tabs.update(tabs[0].id, {
      active: true,
      url: `${url}#${encodeURIComponent(page)}`,
    });
    if (tabs[0].windowId !== undefined)
      await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url: `${url}#${encodeURIComponent(page)}` });
}

let prefQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const isManager =
    sender.url?.startsWith(chrome.runtime.getURL('manage.html')) === true &&
    !sender.tab?.url?.startsWith('https:');
  const task = (async () => {
    if (message.type === 'host') {
      const contentOperations = [
        'ping',
        'items.begin',
        'items.append',
        'items.finishFile',
        'items.commit',
      ];
      if (!isManager && !contentOperations.includes(message.op))
        throw new Error('此操作只能从素材管理页面进行');
      return requestHost(message.op, message.payload ?? {});
    }
    if (message.type === 'preferences') {
      let result = DEFAULT_PREFERENCES;
      prefQueue = prefQueue
        .catch(() => {})
        .then(async () => {
          const current = validatePreferences(
            (await chrome.storage.local.get('preferences')).preferences,
          );
          result = validatePreferences({ ...current, ...message.patch });
          await chrome.storage.local.set({ preferences: result });
        });
      await prefQueue;
      return result;
    }
    if (message.type === 'open-manager') {
      await manager(message.page);
      return { ok: true };
    }
    if (message.type === 'commands') return chrome.commands.getAll();
    throw new Error('未知操作');
  })();
  task.then(respond).catch((error) =>
    respond({
      ok: false,
      error: { code: 'operation-failed', message: errorMessage(error), retryable: true },
    }),
  );
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  const current = validatePreferences((await chrome.storage.local.get('preferences')).preferences);
  await chrome.storage.local.set({ preferences: { ...current, petHidden: false } });
  if (tab.id === undefined || !/^https?:/.test(tab.url ?? '')) {
    await manager('settings');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'toggle-menu' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }
});
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') await manager('settings');
});
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { target: 'content', type: command });
  } catch {
    await manager('settings');
  }
});
