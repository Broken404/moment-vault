import { sourceKey } from './sites';
import type { VideoSession } from './session';
import type { CaptureSelection } from '../recording/types';

export interface CaptureHooks {
  prepare(id: string): Promise<CaptureSelection>;
  check(id: string): void;
  play(id: string): Promise<void>;
  finish(id: string): number | undefined;
  release(): void;
}
export function statusPosition(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  size = { width: 310, height: 44 },
) {
  const width = Math.min(size.width, viewport.width - 16),
    height = size.height;
  if (rect.y + rect.height + height + 12 <= viewport.height)
    return {
      left: Math.max(8, Math.min(viewport.width - width - 8, rect.x)),
      top: rect.y + rect.height + 8,
    };
  if (rect.y >= height + 12)
    return {
      left: Math.max(8, Math.min(viewport.width - width - 8, rect.x)),
      top: rect.y - height - 8,
    };
  if (rect.x + rect.width + width + 12 <= viewport.width)
    return { left: rect.x + rect.width + 8, top: Math.max(8, rect.y) };
  if (rect.x >= width + 12) return { left: rect.x - width - 8, top: Math.max(8, rect.y) };
  throw new Error('视频画面占满了网页，请缩小播放器，为录制状态条留一点空间。');
}
export function videoCapture(
  session: VideoSession,
  layer: HTMLElement,
  onLayout: (position: { left: number; top: number } | null) => void,
): CaptureHooks {
  let id = '',
    selection: CaptureSelection | undefined,
    lastTime = 0,
    timer: ReturnType<typeof setInterval> | undefined,
    cleanup = () => {},
    playing = false,
    ended = false,
    frame: number | undefined;
  const valid = () =>
    session.validSource() &&
    sourceKey(session.target.video, session.target.site) === session.target.key;
  const rect = () => {
    const r = session.target.video.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const stop = (reason: string) => {
    if (ended) return;
    ended = true;
    const pausedAt =
      valid() && session.target.video.paused ? session.target.video.currentTime : undefined;
    if (pausedAt !== undefined) {
      clear();
      playing = false;
    }
    void chrome.runtime
      .sendMessage({
        target: 'background',
        type: 'capture-ended',
        id,
        reason,
        ...(pausedAt !== undefined ? { pausedAt } : {}),
      })
      .catch(() => {});
  };
  const check = () => {
    if (!selection || !valid()) throw new Error('视频来源已改变，录制已停止。');
    const current = rect();
    if (
      innerWidth !== selection.viewport.width ||
      innerHeight !== selection.viewport.height ||
      (['x', 'y', 'width', 'height'] as const).some(
        (key) => Math.abs(current[key] - selection!.rect[key]) > 2,
      )
    )
      throw new Error('页面或视频位置已变化，已结束当前录制。');
    if (document.fullscreenElement || document.hidden)
      throw new Error('页面不可见或进入全屏，已结束当前录制。');
    const bar = layer.querySelector('.recording-bar')?.getBoundingClientRect();
    if (
      bar &&
      bar.width > 0 &&
      bar.left < current.x + current.width &&
      bar.right > current.x &&
      bar.top < current.y + current.height &&
      bar.bottom > current.y
    )
      throw new Error('录制状态条会遮住视频，请调整播放器大小后重试。');
    if (
      !playing &&
      (!session.target.video.paused ||
        Math.abs(session.target.video.currentTime - selection.actualStart) > 0.15)
    )
      throw new Error('起点位置已改变，请重新开始录制。');
  };
  const tick = () => {
    try {
      check();
      if (!playing) return;
      const video = session.target.video;
      lastTime = video.currentTime;
      void chrome.runtime
        .sendMessage({ target: 'background', type: 'capture-progress', id, time: lastTime })
        .catch(() => {});
      if (lastTime >= selection!.b || video.ended) {
        video.pause();
        stop('selected-end');
      } else if (video.paused) stop('source-paused');
    } catch {
      stop('source-or-layout-changed');
    }
  };
  const clear = () => {
    clearInterval(timer);
    timer = undefined;
    if (frame !== undefined) session.target.video.cancelVideoFrameCallback(frame);
    frame = undefined;
  };
  const release = () => {
    clear();
    playing = false;
    cleanup();
    cleanup = () => {};
    delete layer.dataset.capture;
    onLayout(null);
    session.releaseCapture();
    selection = undefined;
  };
  return {
    async prepare(value) {
      id = value;
      ended = false;
      playing = false;
      try {
        const actualStart = await session.prepareCapture();
        if (!valid()) throw new Error('视频来源已改变。');
        const viewport = { width: innerWidth, height: innerHeight },
          bounds = rect();
        if (
          bounds.x < 0 ||
          bounds.y < 0 ||
          bounds.x + bounds.width > innerWidth + 0.5 ||
          bounds.y + bounds.height > innerHeight + 0.5
        )
          throw new Error('请先让完整的视频画面处于网页可见区域。');
        onLayout(statusPosition(bounds, viewport));
        selection = {
          ...session.state.selection,
          actualStart,
          source: location.href,
          title: document.title,
          rect: bounds,
          viewport,
        };
        lastTime = actualStart;
        const target = session.target,
          token = crypto.randomUUID(),
          previous = target.player.getAttribute('data-mv-recording');
        target.player.setAttribute('data-mv-recording', token);
        const style = document.createElement('style');
        const selectors =
          target.site === 'youtube'
            ? [
                '.ytp-chrome-bottom',
                '.ytp-chrome-top',
                '.ytp-gradient-bottom',
                '.ytp-pause-overlay',
              ]
            : target.site === 'bilibili'
              ? [
                  '.bpx-player-control-wrap',
                  '.bpx-player-control-bottom',
                  '.bpx-player-control-top',
                ]
              : target.site === 'owned'
                ? ['[data-mv-owned-controls]']
                : [];
        style.textContent =
          selectors.map((s) => `[data-mv-recording="${token}"] ${s}`).join(',') +
          (selectors.length ? '{opacity:0!important;visibility:hidden!important;}' : '');
        const hidden: HTMLElement[] = [];
        if (target.site === 'x') {
          for (const thumb of target.player.querySelectorAll<HTMLElement>('[role="slider"]')) {
            if (!/seek|progress|进度|進度/i.test(thumb.getAttribute('aria-label') ?? '')) continue;
            let parent = thumb.parentElement,
              candidate = parent;
            for (
              let i = 0;
              parent && parent !== target.player && i < 6;
              i++, parent = parent.parentElement
            ) {
              if (parent.getBoundingClientRect().height > 90) break;
              candidate = parent;
            }
            if (candidate) {
              candidate.setAttribute('data-mv-hidden-control', token);
              hidden.push(candidate);
            }
          }
          // X mounts a separate mute badge after playback starts, outside the seek controls.
          // Scope its live selector to this recording so newly mounted badges stay hidden too.
          style.textContent =
            [
              `[data-mv-hidden-control="${token}"]`,
              `[data-mv-recording="${token}"] button[aria-label="Mute"]`,
              `[data-mv-recording="${token}"] button[aria-label="Unmute"]`,
            ].join(',') + '{opacity:0!important;visibility:hidden!important;}';
        }
        document.head.append(style);
        cleanup = () => {
          style.remove();
          for (const element of hidden) element.removeAttribute('data-mv-hidden-control');
          if (previous === null) target.player.removeAttribute('data-mv-recording');
          else target.player.setAttribute('data-mv-recording', previous);
        };
        layer.dataset.capture = 'true';
        timer = setInterval(tick, 200);
        const rendered = () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        await rendered();
        const bar = layer.querySelector('.recording-bar')?.getBoundingClientRect();
        if (bar?.width && bar.height) {
          onLayout(statusPosition(bounds, viewport, { width: bar.width, height: bar.height }));
          await rendered();
        }
        check();
        return selection;
      } catch (error) {
        release();
        throw error;
      }
    },
    check(value) {
      if (value !== id) throw new Error('录制会话已失效。');
      check();
    },
    async play(value) {
      if (value !== id) throw new Error('录制会话已失效。');
      check();
      session.target.video.playbackRate = 1;
      playing = true;
      const watch: VideoFrameRequestCallback = () => {
        if (!playing || ended) return;
        const video = session.target.video;
        if (valid() && video.currentTime >= selection!.b) {
          lastTime = video.currentTime;
          video.pause();
          stop('selected-end');
          return;
        }
        frame = video.requestVideoFrameCallback(watch);
      };
      frame = session.target.video.requestVideoFrameCallback(watch);
      await session.target.video.play();
      tick();
    },
    finish(value) {
      if (value !== id) return undefined;
      clear();
      playing = false;
      if (valid()) {
        session.target.video.pause();
        lastTime = session.target.video.currentTime;
      }
      return lastTime;
    },
    release,
  };
}
