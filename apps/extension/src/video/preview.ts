export interface Frame {
  canvas: HTMLCanvasElement;
  target: number;
  actual: number;
  bytes: number;
}
export class FrameCache {
  private entries = new Map<string, Frame>();
  private pins = new Set<string>();
  bytes = 0;
  constructor(
    readonly maximumBytes = 8 * 1024 * 1024,
    readonly maximumEntries = 8,
  ) {}
  pin(keys: string[]) {
    this.pins = new Set(keys);
  }
  get(key: string): Frame | undefined {
    const frame = this.entries.get(key);
    if (frame) {
      this.entries.delete(key);
      this.entries.set(key, frame);
    }
    return frame;
  }
  set(key: string, frame: Frame) {
    this.remove(key);
    this.entries.set(key, frame);
    this.bytes += frame.bytes;
    while (this.bytes > this.maximumBytes || this.entries.size > this.maximumEntries) {
      const oldest =
        [...this.entries.keys()].find((k) => !this.pins.has(k)) ?? this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
  private remove(key: string) {
    const frame = this.entries.get(key);
    if (!frame) return;
    this.bytes -= frame.bytes;
    this.entries.delete(key);
    frame.canvas.width = frame.canvas.height = 0;
  }
  clear() {
    for (const key of this.entries.keys()) this.remove(key);
  }
  get size() {
    return this.entries.size;
  }
}

// At most one producer runs; intermediate requests never update the visible frame.
export class LatestPreview<T> {
  private sequence = 0;
  private pending: { id: number; time: number; resolve: (value: T | undefined) => void } | null =
    null;
  private running = false;
  private closed = false;
  private abort = new AbortController();
  constructor(
    private produce: (time: number, signal: AbortSignal) => Promise<T>,
    private accept: (value: T, time: number) => void,
    private fail: (message: string) => void,
    private discard: (value: T) => void = () => {},
  ) {}
  request(time: number): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    this.pending?.resolve(undefined);
    const id = ++this.sequence;
    const result = new Promise<T | undefined>((resolve) => {
      this.pending = { id, time, resolve };
    });
    void this.drain();
    return result;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending && !this.closed) {
        const request = this.pending;
        this.pending = null;
        try {
          const value = await this.produce(request.time, this.abort.signal);
          if (this.closed || request.id !== this.sequence) {
            this.discard(value);
            request.resolve(undefined);
          } else {
            this.accept(value, request.time);
            request.resolve(value);
          }
        } catch (error) {
          if (
            !this.closed &&
            request.id === this.sequence &&
            !(error instanceof DOMException && error.name === 'AbortError')
          )
            this.fail(error instanceof Error ? error.message : String(error));
          request.resolve(undefined);
        }
      }
    } finally {
      this.running = false;
    }
  }
  cancel() {
    this.sequence++;
    this.pending?.resolve(undefined);
    this.pending = null;
    this.abort.abort();
    this.abort = new AbortController();
  }
  close() {
    this.closed = true;
    this.cancel();
  }
}

export function copyFrame(
  video: HTMLVideoElement,
  actual = video.currentTime,
  target = actual,
): Frame {
  const scale = Math.min(1, 640 / video.videoWidth, 360 / video.videoHeight);
  if (!(scale > 0) || video.readyState < 2 || video.seeking)
    throw new Error('视频画面尚未就绪，请重试。');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { canvas, actual, target, bytes: canvas.width * canvas.height * 4 };
}
export function seekFrame(
  video: HTMLVideoElement,
  target: number,
  signal: AbortSignal,
  valid: () => boolean,
): Promise<Frame> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || !valid()) {
      reject(new DOMException('Preview ended', 'AbortError'));
      return;
    }
    video.pause();
    // An already displayed paused frame needs no new decode callback.
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.001) {
      resolve(copyFrame(video, video.currentTime, target));
      return;
    }
    let callback: number | undefined,
      finished = false;
    let presentedTime: number | undefined;
    const finish = (error?: Error, actual?: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (callback !== undefined) video.cancelVideoFrameCallback(callback);
      signal.removeEventListener('abort', aborted);
      video.removeEventListener('error', failed);
      video.removeEventListener('seeked', seeked);
      if (error) reject(error);
      else {
        try {
          resolve(copyFrame(video, actual!, target));
        } catch (error) {
          reject(error);
        }
      }
    };
    const aborted = () => finish(new DOMException('Preview ended', 'AbortError'));
    const failed = () => finish(new Error('视频定位失败，请检查网络后重试。'));
    const timer = setTimeout(() => finish(new Error('还没等到目标画面，请检查网络后重试。')), 8000);
    const verify = () => {
      if (!valid()) {
        aborted();
        return;
      }
      if (
        presentedTime !== undefined &&
        !video.seeking &&
        video.readyState >= 2 &&
        Math.abs(video.currentTime - target) < 0.15 &&
        Math.abs(presentedTime - target) < 0.15
      )
        finish(undefined, presentedTime);
    };
    const seeked = () => verify();
    const presented: VideoFrameRequestCallback = (_now, metadata) => {
      presentedTime = metadata.mediaTime;
      verify();
      if (!finished) callback = video.requestVideoFrameCallback(presented);
    };
    signal.addEventListener('abort', aborted, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.addEventListener('seeked', seeked);
    if (!video.requestVideoFrameCallback) {
      finish(new Error('当前浏览器无法核对预览画面，请更新 Edge 后重试。'));
      return;
    }
    try {
      callback = video.requestVideoFrameCallback(presented);
      video.currentTime = target;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface Watching {
  time: number;
  paused: boolean;
  rate: number;
  volume: number;
  muted: boolean;
}
type Lease = { original: Watching; restoring: boolean; abort: AbortController; key: string };
const leases = new WeakMap<HTMLVideoElement, Lease>();
export function watchLease(
  video: HTMLVideoElement,
  key: string,
  valid: () => boolean,
  inherited?: Watching,
) {
  const previous = leases.get(video);
  previous?.abort.abort();
  const original =
    inherited ??
    (previous?.restoring && previous.key === key
      ? previous.original
      : {
          time: video.currentTime,
          paused: video.paused,
          rate: video.playbackRate,
          volume: video.volume,
          muted: video.muted,
        });
  const lease: Lease = { original, key, restoring: false, abort: new AbortController() };
  leases.set(video, lease);
  video.pause();
  return {
    original,
    release(restore: boolean) {
      if (leases.get(video) !== lease) return;
      if (!restore || !valid()) {
        leases.delete(video);
        return;
      }
      lease.restoring = true;
      video.pause();
      video.playbackRate = original.rate;
      video.volume = original.volume;
      video.muted = original.muted;
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', complete);
        lease.abort.signal.removeEventListener('abort', done);
        if (leases.get(video) === lease) leases.delete(video);
      };
      const complete = () => {
        if (leases.get(video) !== lease || lease.abort.signal.aborted || !valid()) {
          done();
          return;
        }
        if (video.seeking || Math.abs(video.currentTime - original.time) > 0.15) return;
        if (!original.paused) void video.play().catch(() => {});
        done();
      };
      lease.abort.signal.addEventListener('abort', done, { once: true });
      video.addEventListener('seeked', complete);
      timer = setTimeout(done, 8000);
      try {
        video.currentTime = original.time;
        if (!video.seeking) complete();
      } catch {
        done();
      }
    },
  };
}
