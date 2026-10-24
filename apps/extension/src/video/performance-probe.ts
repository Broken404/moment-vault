// Explicit test builds only. No persistence, network requests or media capture.
import type { SelectionState, VideoSession } from './session';
import type { VideoTarget } from './sites';

declare const __MV_VIDEO_PERFORMANCE_LAB__: boolean;

export function videoPerformanceProbe(target: VideoTarget, host: HTMLElement) {
  if (typeof __MV_VIDEO_PERFORMANCE_LAB__ === 'undefined' || !__MV_VIDEO_PERFORMANCE_LAB__)
    return null;
  const started = performance.now();
  const ranges = (value: TimeRanges) =>
    Array.from({ length: value.length }, (_, i) => [value.start(i), value.end(i)]);
  const heap = () =>
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
    null;
  const report = {
    site: target.site,
    startedAtUtc: new Date().toISOString(),
    duration: target.video.duration,
    width: target.video.videoWidth,
    height: target.video.videoHeight,
    heapBefore: heap(),
    maxCacheBytes: 0,
    maxCacheEntries: 0,
    inputToNextRaf: [] as { type: string; ms: number; a: string | null; b: string | null }[],
    ready: [] as {
      target: number;
      actual: number | null;
      ms: number;
      cached: boolean;
      error: string;
    }[],
    mediaEvents: [] as { type: string; atMs: number; currentTime: number; readyState: number }[],
    requests: [] as { target: number; atMs: number; buffered: number[][]; seekable: number[][] }[],
    closed: false,
    afterClose: null as null | Record<string, unknown>,
  };
  let node = document.querySelector<HTMLElement>('[data-moment-vault-performance-report]');
  if (!node) {
    node = document.createElement('pre');
    node.dataset.momentVaultPerformanceReport = 'test-build-only';
    node.hidden = true;
    document.body.append(node);
  }
  let previous: unknown[] = [];
  try {
    previous = JSON.parse(node.textContent || '[]') as unknown[];
  } catch {
    /* empty fixture */
  }
  const history = [...previous.slice(-7), report];
  const publish = () => {
    node!.textContent = JSON.stringify(history);
  };
  let pending: { time: number; at: number } | null = null;
  let lastReady = '';
  const media = (event: Event) => {
    if (report.mediaEvents.length < 300)
      report.mediaEvents.push({
        type: event.type,
        atMs: performance.now() - started,
        currentTime: target.video.currentTime,
        readyState: target.video.readyState,
      });
    publish();
  };
  const events = ['seeking', 'seeked', 'waiting', 'stalled', 'playing', 'canplay', 'error'];
  for (const event of events) target.video.addEventListener(event, media);
  const input = (event: Event) => {
    if (!event.composedPath().includes(host)) return;
    const at = performance.now();
    requestAnimationFrame(() => {
      if (report.closed || report.inputToNextRaf.length >= 300) return;
      const root = host.shadowRoot;
      report.inputToNextRaf.push({
        type: event.type,
        ms: performance.now() - at,
        a: root?.querySelector('.endpoint.a')?.getAttribute('aria-valuenow') ?? null,
        b: root?.querySelector('.endpoint.b')?.getAttribute('aria-valuenow') ?? null,
      });
      publish();
    });
  };
  for (const event of ['pointermove', 'keydown', 'click'])
    document.addEventListener(event, input, true);
  return {
    update(state: SelectionState) {
      if (report.closed) return;
      report.maxCacheBytes = Math.max(report.maxCacheBytes, state.cacheBytes);
      report.maxCacheEntries = Math.max(report.maxCacheEntries, state.cacheEntries);
      if (state.loading && (!pending || pending.time !== state.requested)) {
        pending = { time: state.requested, at: performance.now() };
        if (report.requests.length < 300)
          report.requests.push({
            target: state.requested,
            atMs: performance.now() - started,
            buffered: ranges(target.video.buffered),
            seekable: ranges(target.video.seekable),
          });
      }
      if (!state.loading && !state.playing && pending) {
        const key = `${pending.at}:${state.actual}:${state.message}`;
        if (key !== lastReady && report.ready.length < 300) {
          report.ready.push({
            target: state.requested,
            actual: state.actual,
            ms: performance.now() - pending.at,
            cached: state.cached,
            error: state.message,
          });
          lastReady = key;
        }
        pending = null;
      }
      publish();
    },
    close(session?: VideoSession) {
      report.closed = true;
      for (const event of events) target.video.removeEventListener(event, media);
      for (const event of ['pointermove', 'keydown', 'click'])
        document.removeEventListener(event, input, true);
      if (!session) {
        report.afterClose = { creationFailed: true };
        publish();
        return;
      }
      // Read our own controller after close, without adding a product API.
      const internals = session as unknown as {
        cache: { bytes: number; size: number };
        queue: { closed: boolean; pending: unknown; running: boolean };
      };
      setTimeout(() => {
        report.afterClose = {
          cacheBytes: internals.cache.bytes,
          cacheEntries: internals.cache.size,
          queueClosed: internals.queue.closed,
          queuePending: internals.queue.pending !== null,
          queueRunning: internals.queue.running,
          hostConnected: host.isConnected,
          videoTime: target.video.currentTime,
          paused: target.video.paused,
          heapAfter: heap(),
        };
        publish();
      }, 300);
      publish();
    },
  };
}
