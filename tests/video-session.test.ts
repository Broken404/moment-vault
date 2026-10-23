import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoSession } from '../apps/extension/src/video/session';
import { sourceKey, type VideoTarget } from '../apps/extension/src/video/sites';

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

// Real session/cache/seek queue; only the browser decoder and layout observers are controlled.
function fixture() {
  let url = `https://www.youtube.com/watch?v=${crypto.randomUUID()}`,
    time = 2,
    seeking = false,
    width = 640,
    deliverFrames = true,
    next = 0;
  const player = document.createElement('div');
  player.innerHTML =
    '<video></video><div class="ytp-progress-bar-container"><div class="ytp-progress-bar"></div></div>';
  document.body.append(player);
  const video = player.querySelector('video')!,
    host = document.createElement('div'),
    callbacks = new Map<number, VideoFrameRequestCallback>(),
    seeks: number[] = [];
  const bounds = (top: number, height: number) =>
    ({
      x: 20,
      y: top,
      left: 20,
      right: 660,
      top,
      bottom: top + height,
      width: 640,
      height,
    }) as DOMRect;
  player.getBoundingClientRect = () => bounds(20, 360);
  for (const rail of player.querySelectorAll<HTMLElement>('[class]'))
    rail.getBoundingClientRect = () => bounds(360, 8);
  const present = (mediaTime: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback(0, { mediaTime } as VideoFrameCallbackMetadata);
  };
  Object.defineProperties(video, {
    currentTime: {
      get: () => time,
      set: (value: number) => {
        seeks.push(value);
        time = value;
        seeking = true;
        void Promise.resolve().then(() => {
          seeking = false;
          video.dispatchEvent(new Event('seeked'));
          if (deliverFrames) present(value);
        });
      },
    },
    currentSrc: { value: 'https://owned.invalid/video.mp4' },
    duration: { value: 30 },
    paused: { value: true },
    seeking: { get: () => seeking },
    readyState: { value: 4 },
    videoWidth: { get: () => width },
    videoHeight: { value: 360 },
    seekable: { value: { length: 1, start: () => 0, end: () => 30 } },
  });
  video.pause = vi.fn();
  video.requestVideoFrameCallback = vi.fn((callback) => {
    callbacks.set(++next, callback);
    return next;
  });
  video.cancelVideoFrameCallback = vi.fn((id) => {
    callbacks.delete(id);
  });
  const target: VideoTarget = {
    video,
    player,
    site: 'youtube',
    key: sourceKey(video, 'youtube', url),
  };
  const session = new VideoSession(target, host, () => {}, {
    url: () => url,
    targets: () => [target],
  });
  session.setCanvas(document.createElement('canvas'));
  return {
    session,
    video,
    seeks,
    callbacks,
    present,
    stopAtEnd() {
      time = 18.027;
      deliverFrames = false;
    },
    changeSource() {
      url += '-different';
    },
    changeResolution() {
      width = 1280;
      video.dispatchEvent(new Event('resize'));
    },
  };
}

describe('preview restoration after capture', () => {
  let owned: ReturnType<typeof fixture> | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    owned?.session.close();
    owned = undefined;
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function prepared() {
    owned = fixture();
    const { session, video } = owned;
    await flush();
    session.move('b', 18);
    await flush();
    expect(session.state.actual).toBe(18);
    expect(session.state.hasFrame).toBe(true);
    expect(await session.prepareCapture()).toBe(2);
    expect(video.currentTime).toBe(2); // Cached A must not bypass the actual capture-start seek.
    return owned;
  }

  it('restores the confirmed B frame after saving even when the paused decoder emits no new frame', async () => {
    const { session, seeks } = await prepared();
    owned!.stopAtEnd();
    const before = seeks.length;
    session.releaseCapture();
    await vi.advanceTimersByTimeAsync(8001);
    expect(session.state.message).toBe('');
    expect(session.state.loading).toBe(false);
    expect(session.state.actual).toBe(18);
    expect(session.state.cached).toBe(true);
    expect(seeks).toHaveLength(before);
  });

  it('handles repeated terminal notifications without starting another boundary decode', async () => {
    const { session, seeks } = await prepared();
    owned!.stopAtEnd();
    const before = seeks.length;
    session.releaseCapture();
    session.releaseCapture();
    await vi.advanceTimersByTimeAsync(8001);
    expect(session.state.message).toBe('');
    expect(session.state.actual).toBe(18);
    expect(session.state.cached).toBe(true);
    expect(seeks).toHaveLength(before);
  });

  it('does not restore an old boundary after the source identity changes', async () => {
    const { session, seeks } = await prepared();
    owned!.stopAtEnd();
    owned!.changeSource();
    const before = seeks.length;
    session.releaseCapture();
    await flush();
    expect(session.state.actual).toBe(2);
    expect(seeks).toHaveLength(before);
  });

  it('requires a new confirmed frame after the resolution changes during capture', async () => {
    const { session, present } = await prepared();
    owned!.stopAtEnd();
    owned!.changeResolution();
    session.releaseCapture();
    await flush();
    expect(session.state.loading).toBe(true);
    expect(session.state.actual).toBe(2);
    present(18);
    await flush();
    expect(session.state.loading).toBe(false);
    expect(session.state.actual).toBe(18);
    expect(session.state.cached).toBe(false);
  });
});
