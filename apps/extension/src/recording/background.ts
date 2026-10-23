import type { HostResponse, HostStatus } from '@shared/model';
import { CaptureCoordinator, type CaptureTask } from './coordinator';
import type { CaptureStatus } from './types';

export function recordingBackground(
  requestHost: (
    op:
      | 'ping'
      | 'recordings.begin'
      | 'recordings.process'
      | 'recordings.status'
      | 'items.append'
      | 'items.finishFile',
    payload: Record<string, unknown>,
  ) => Promise<HostResponse>,
) {
  let creating: Promise<void> | undefined;
  async function ensure() {
    if (
      (
        await chrome.runtime.getContexts({
          contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        })
      ).length
    )
      return;
    creating ??= chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification:
          'Record only the video segment explicitly started with the extension shortcut; retain unsaved data for local retry.',
      })
      .finally(() => {
        creating = undefined;
      });
    await creating;
  }
  const coordinator = new CaptureCoordinator({
    async ping() {
      const response = await requestHost('ping', {});
      if (!response.ok) throw new Error(response.error?.message);
      return response.result as HostStatus;
    },
    tell(tabId, type, data) {
      return chrome.tabs.sendMessage(tabId, { target: 'content', type, ...data });
    },
    async media(type, data) {
      if (
        type === 'stop' &&
        !(
          await chrome.runtime.getContexts({
            contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
          })
        ).length
      )
        return { ok: true };
      await ensure();
      return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
    },
    streamId(tabId) {
      return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    },
    persist(task) {
      return chrome.storage.session.set({ captureCurrent: task });
    },
    async notify(task, status) {
      await chrome.storage.session.set({ captureLatest: status });
      await chrome.tabs
        .sendMessage(task.tabId, { target: 'content', type: 'capture-state', status })
        .catch(() => {});
    },
  });
  const loaded = chrome.storage.session.get('captureCurrent').then((data) => {
    coordinator.current = (data.captureCurrent as CaptureTask | undefined) ?? null;
  });
  let lastCommand = 0;
  async function command(tabId: number) {
    await loaded;
    if (Date.now() - lastCommand < 400) return;
    lastCommand = Date.now();
    if (coordinator.current?.phase === 'recording') await coordinator.stop('manual-shortcut');
    else if (
      coordinator.current?.phase === 'preparing' ||
      coordinator.current?.phase === 'stopping' ||
      coordinator.current?.phase === 'processing'
    )
      return;
    else await coordinator.start(tabId);
  }
  async function handle(
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
    isManager: boolean,
  ) {
    await loaded;
    const offscreen = sender.url === chrome.runtime.getURL('offscreen.html') && !sender.tab;
    if (message.type === 'recording-host') {
      if (
        !offscreen ||
        ![
          'recordings.begin',
          'recordings.process',
          'recordings.status',
          'items.append',
          'items.finishFile',
        ].includes(String(message.op))
      )
        throw new Error('无效的录制保存请求。');
      return requestHost(
        message.op as 'recordings.begin',
        message.payload as Record<string, unknown>,
      );
    }
    if (message.type === 'capture-status') {
      if (!offscreen) throw new Error('无效的录制状态。');
      await coordinator.receive(message.status as CaptureStatus);
      return { ok: true };
    }
    if (message.type === 'capture-ended') {
      if (!offscreen && sender.tab?.id !== coordinator.current?.tabId)
        throw new Error('无效的录制结束请求。');
      if (message.id === coordinator.current?.id)
        await coordinator.stop(
          String(message.reason).slice(0, 80),
          sender.tab?.id === coordinator.current?.tabId && typeof message.pausedAt === 'number'
            ? message.pausedAt
            : undefined,
        );
      return { ok: true, stopped: true };
    }
    if (message.type === 'capture-close') {
      if (sender.tab?.id !== coordinator.current?.tabId) return { ok: true, stopped: true };
      await coordinator.stop('mode-closed');
      return { ok: true, stopped: true };
    }
    if (message.type === 'capture-progress') {
      if (sender.tab?.id === coordinator.current?.tabId)
        coordinator.progress(String(message.id), Number(message.time));
      return { ok: true };
    }
    if (message.type === 'recording-jobs' || message.type === 'recording-retry') {
      if (!isManager) throw new Error('请从素材管理页重试未完成的录制。');
      await ensure();
      return chrome.runtime.sendMessage({
        target: 'offscreen',
        type: message.type === 'recording-jobs' ? 'jobs' : 'retry',
        id: message.id,
      });
    }
    if (message.type === 'capture-current') {
      if (sender.tab?.id !== coordinator.current?.tabId) return { ok: true, status: null };
      return {
        ok: true,
        status: (await chrome.storage.session.get('captureLatest')).captureLatest ?? null,
      };
    }
    return null;
  }
  chrome.tabs.onRemoved.addListener((tabId) => {
    void loaded.then(() => {
      if (coordinator.current?.tabId === tabId) void coordinator.stop('source-tab-closed');
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === 'loading')
      void loaded.then(() => {
        if (coordinator.current?.tabId === tabId) void coordinator.stop('source-navigation');
      });
  });
  return { command, handle };
}
