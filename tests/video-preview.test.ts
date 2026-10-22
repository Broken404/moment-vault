import { describe, expect, it, vi } from 'vitest';
import {
  FrameCache,
  LatestPreview,
  seekFrame,
  watchLease,
  type Frame,
} from '../apps/extension/src/video/preview';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('latest preview work', () => {
  it('serializes decoding, drops intermediate requests and never publishes an obsolete frame', async () => {
    const first = deferred<string>(),
      last = deferred<string>();
    const produce = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const accept = vi.fn(),
      discard = vi.fn(),
      fail = vi.fn();
    const queue = new LatestPreview(produce, accept, fail, discard);
    const a = queue.request(1),
      b = queue.request(2),
      c = queue.request(3);
    expect(await b).toBeUndefined();
    expect(produce).toHaveBeenCalledTimes(1);
    first.resolve('obsolete');
    expect(await a).toBeUndefined();
    expect(discard).toHaveBeenCalledWith('obsolete');
    expect(accept).not.toHaveBeenCalled();
    expect(produce.mock.calls.map((call) => call[0])).toEqual([1, 3]);
    last.resolve('newest');
    expect(await c).toBe('newest');
    expect(accept).toHaveBeenCalledExactlyOnceWith('newest', 3);
    expect(fail).not.toHaveBeenCalled();
    queue.close();
  });
  it('suppresses failures from superseded work and publishes the current failure', async () => {
    const old = deferred<string>();
    const fail = vi.fn();
    const produce = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error('current network failure'));
    const queue = new LatestPreview(produce, vi.fn(), fail);
    const a = queue.request(1),
      b = queue.request(2);
    old.reject(new Error('stale failure'));
    await a;
    await b;
    expect(fail).toHaveBeenCalledExactlyOnceWith('current network failure');
    queue.close();
  });
  it('cancels pending work on close and rejects late publication even if the producer ignores abort', async () => {
    const work = deferred<string>(),
      accept = vi.fn(),
      discard = vi.fn();
    let signal!: AbortSignal;
    const queue = new LatestPreview(
      (_time, value) => {
        signal = value;
        return work.promise;
      },
      accept,
      vi.fn(),
      discard,
    );
    const a = queue.request(1),
      b = queue.request(2);
    queue.close();
    expect(signal.aborted).toBe(true);
    expect(await b).toBeUndefined();
    work.resolve('late');
    expect(await a).toBeUndefined();
    expect(accept).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith('late');
    expect(await queue.request(3)).toBeUndefined();
  });
});

function frame(bytes = 40): Frame {
  const canvas = document.createElement('canvas');
  canvas.width = 10;
  canvas.height = 1;
  return { canvas, bytes, actual: 1, target: 1 };
}
describe('bounded frame ownership', () => {
  it('keeps pinned boundaries, evicts least recent unpinned frames and releases their canvas storage', () => {
    const cache = new FrameCache(120, 3),
      a = frame(),
      b = frame(),
      c = frame(),
      d = frame();
    cache.pin(['a', 'b']);
    cache.set('a', a);
    cache.set('b', b);
    cache.set('c', c);
    cache.set('d', d);
    expect(cache.get('a')).toBe(a);
    expect(cache.get('b')).toBe(b);
    expect(cache.get('c')).toBeUndefined();
    expect(c.canvas.width).toBe(0);
    expect(cache.bytes).toBe(120);
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
    expect(d.canvas.width).toBe(0);
  });
  it('honors the byte limit even when every entry is pinned and uses exact boundary keys', () => {
    const cache = new FrameCache(60, 8),
      a = frame(),
      b = frame();
    cache.pin(['1.000', '1.001']);
    cache.set('1.000', a);
    cache.set('1.001', b);
    expect(cache.get('1.000')).toBeUndefined();
    expect(cache.get('1.001')).toBe(b);
    expect(cache.get('1.002')).toBeUndefined();
    expect(cache.bytes).toBe(40);
    cache.clear();
  });
});

function media() {
  const video = document.createElement('video');
  let time = 8,
    paused = false,
    seeking = false;
  const writes: number[] = [];
  Object.defineProperties(video, {
    currentTime: {
      get: () => time,
      set: (value) => {
        writes.push(value);
        time = value;
        seeking = true;
      },
    },
    paused: { get: () => paused },
    seeking: { get: () => seeking },
  });
  video.play = vi.fn(async () => {
    paused = false;
  });
  video.pause = vi.fn(() => {
    paused = true;
  });
  const seeked = () => {
    seeking = false;
    video.dispatchEvent(new Event('seeked'));
  };
  return { video, writes, seeked };
}
describe('watch state restoration lease', () => {
  it('restores settings and original playback only after the correct seek completes', () => {
    const { video, writes, seeked } = media();
    video.volume = 0.4;
    video.playbackRate = 1.5;
    video.muted = true;
    const lease = watchLease(video, 'one', () => true);
    video.currentTime = 3;
    seeked();
    video.volume = 0.8;
    lease.release(true);
    expect(writes).toEqual([3, 8]);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.volume).toBe(0.4);
    expect(video.playbackRate).toBe(1.5);
    expect(video.muted).toBe(true);
    seeked();
    expect(video.play).toHaveBeenCalledTimes(1);
  });
  it('rapid re-entry preserves the original watch state and cancels the previous restore callback', () => {
    const { video, seeked } = media();
    const first = watchLease(video, 'one', () => true);
    video.currentTime = 3;
    seeked();
    first.release(true);
    const second = watchLease(video, 'one', () => true);
    expect(second.original.time).toBe(8);
    expect(second.original.paused).toBe(false);
    seeked();
    expect(video.play).not.toHaveBeenCalled();
    video.currentTime = 4;
    seeked();
    second.release(true);
    seeked();
    expect(video.currentTime).toBe(8);
    expect(video.play).toHaveBeenCalledTimes(1);
  });
  it('does not write an old time into a new source or resume it from a stale seek event', () => {
    const { video, writes, seeked } = media();
    let valid = true;
    const lease = watchLease(video, 'one', () => valid);
    valid = false;
    lease.release(true);
    expect(writes).toEqual([]);
    seeked();
    expect(video.play).not.toHaveBeenCalled();
    valid = true;
    const restoring = watchLease(video, 'two', () => valid);
    restoring.release(true);
    valid = false;
    seeked();
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe('frame confirmation', () => {
  function decoder() {
    const video = document.createElement('video');
    let time = 0,
      next = 0;
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => time,
        set: (value) => {
          time = value;
        },
      },
      readyState: { value: 4 },
      seeking: { value: false, writable: true },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
    });
    video.pause = vi.fn();
    video.requestVideoFrameCallback = vi.fn((callback) => {
      callbacks.set(++next, callback);
      return next;
    });
    video.cancelVideoFrameCallback = vi.fn((id) => {
      callbacks.delete(id);
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const present = (mediaTime: number) => {
      const current = [...callbacks.values()];
      callbacks.clear();
      for (const callback of current) callback(0, { mediaTime } as VideoFrameCallbackMetadata);
    };
    return { video, callbacks, present };
  }
  it('does not call a stale presented frame the requested boundary merely because currentTime changed', async () => {
    const { video, present } = decoder();
    const accepted = vi.fn();
    const work = seekFrame(video, 8, new AbortController().signal, () => true).then(accepted);
    present(2);
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    present(8);
    await work;
    expect(accepted).toHaveBeenCalledOnce();
    expect(accepted.mock.calls[0][0].actual).toBe(8);
  });
  it('accepts a matching presented frame when seek completion arrives after the frame callback', async () => {
    const { video, present } = decoder(),
      abort = new AbortController(),
      accepted = vi.fn();
    Object.defineProperty(video, 'seeking', { value: true });
    const work = seekFrame(video, 8, abort.signal, () => true)
      .then(accepted)
      .catch(() => {});
    present(8);
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    Object.defineProperty(video, 'seeking', { value: false });
    video.dispatchEvent(new Event('seeked'));
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(accepted).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      await work;
    }
  });
  it('cancels registered frame callbacks on abort and on seek assignment failure', async () => {
    const { video, callbacks } = decoder();
    const abort = new AbortController();
    const work = seekFrame(video, 8, abort.signal, () => true);
    abort.abort();
    await expect(work).rejects.toHaveProperty('name', 'AbortError');
    expect(callbacks.size).toBe(0);
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => {
        throw new Error('seek unavailable');
      },
    });
    await expect(seekFrame(video, 8, new AbortController().signal, () => true)).rejects.toThrow(
      'seek unavailable',
    );
    expect(callbacks.size).toBe(0);
  });
});
