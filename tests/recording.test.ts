import { describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
  CaptureCoordinator,
  type CaptureDependencies,
} from '../apps/extension/src/recording/coordinator';
import { publishRecording } from '../apps/extension/src/recording/publish';
import {
  captureGeometry,
  type JobStore,
  type RecordingHost,
  type RecordingJob,
  type CaptureSelection,
} from '../apps/extension/src/recording/types';
import { statusPosition, videoCapture } from '../apps/extension/src/video/capture';
import { sourceKey } from '../apps/extension/src/video/sites';
import type { VideoSession } from '../apps/extension/src/video/session';

const selection: CaptureSelection = {
  a: 2,
  b: 4,
  actualStart: 2,
  source: 'https://youtube.com/watch?v=owned',
  title: 'Owned',
  viewport: { width: 1000, height: 800 },
  rect: { x: 20, y: 40, width: 640, height: 360 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function coordinator() {
  const events: string[] = [];
  const tell = vi.fn(async (_tab: number, type: string) => {
    events.push(type);
    return type === 'capture-prepare'
      ? { ok: true, selection }
      : type === 'capture-finish'
        ? { ok: true, actualEnd: 4.02 }
        : { ok: true };
  });
  const media = vi.fn(async (type: string) => {
    events.push(type);
    return { ok: true };
  });
  const deps = {
    ping: vi.fn(async () => ({ configured: true, recordingToolsAvailable: true })),
    tell,
    media,
    streamId: vi.fn(async () => 'owned-stream'),
    persist: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
  };
  return { engine: new CaptureCoordinator(deps as unknown as CaptureDependencies), deps, events };
}
describe('recording coordination', () => {
  it('does not play the source until the recorder is really started, and preserves actual end on stop', async () => {
    const { engine, deps, events } = coordinator();
    await engine.start(7);
    expect(events.indexOf('start')).toBeLessThan(events.indexOf('capture-play'));
    expect(engine.current?.phase).toBe('recording');
    await engine.stop('manual-shortcut');
    expect(deps.media).toHaveBeenLastCalledWith(
      'stop',
      expect.objectContaining({
        end: { actualStart: 2, actualEnd: 4.02, stopReason: 'manual-shortcut' },
      }),
    );
    expect(engine.current?.phase).toBe('processing');
  });
  it('cancels during pending stream preparation without a late start or source play', async () => {
    const { engine, deps } = coordinator(),
      ready = deferred<{ ok: boolean }>();
    deps.media.mockImplementation(async (type) =>
      type === 'prepare' ? ready.promise : { ok: true },
    );
    const started = engine.start(7);
    await vi.waitFor(() => expect(deps.media).toHaveBeenCalledWith('prepare', expect.anything()));
    await engine.stop('mode-closed');
    ready.resolve({ ok: true });
    await started;
    expect(engine.current?.phase).toBe('cancelled');
    expect(deps.media.mock.calls.some(([type]) => type === 'start')).toBe(false);
    expect(deps.tell.mock.calls.some(([, type]) => type === 'capture-play')).toBe(false);
  });
  it('coalesces simultaneous stop requests and never awaits MP4 conversion before returning stopped', async () => {
    const { engine, deps } = coordinator(),
      stopped = deferred<{ ok: boolean }>();
    await engine.start(7);
    deps.media.mockImplementation(async (type) =>
      type === 'stop' ? stopped.promise : { ok: true },
    );
    const a = engine.stop('selected-end'),
      b = engine.stop('mode-closed');
    await vi.waitFor(() =>
      expect(deps.media.mock.calls.filter(([type]) => type === 'stop')).toHaveLength(1),
    );
    stopped.resolve({ ok: true });
    await Promise.all([a, b]);
    expect(engine.current?.phase).toBe('processing');
  });
  it('requires configured helper tools before acquiring any capture stream', async () => {
    const { engine, deps } = coordinator();
    deps.ping.mockResolvedValue({ configured: true, recordingToolsAvailable: false });
    await engine.start(7);
    expect(deps.streamId).not.toHaveBeenCalled();
    expect(engine.current?.phase).toBe('failed');
  });
  it('does not stop or update a new recording from an obsolete save completion', async () => {
    const { engine } = coordinator();
    await engine.start(7);
    const old = engine.current!.id;
    await engine.stop('selected-end');
    await engine.receive({ id: old, phase: 'saved', name: 'old', message: 'saved' });
    await engine.start(8);
    const next = engine.current!.id;
    await engine.receive({ id: old, phase: 'saved', name: 'old', message: 'late' });
    expect(engine.current?.id).toBe(next);
    expect(engine.current?.phase).toBe('recording');
    await engine.stop('manual-shortcut');
  });
});

function fixture() {
  const job: RecordingJob = {
    id: 'owned',
    attachmentId: 'file',
    tabId: 7,
    name: 'Owned',
    selection,
    phase: 'processing',
    end: { actualStart: 2, actualEnd: 4.02, stopReason: 'selected-end' },
    parts: 2,
    bytes: 250000,
    lastTime: 4.02,
    createdAt: '2026-10-22T12:00:00Z',
  };
  const parts = [
    new NodeBlob([new Uint8Array(200000).fill(3)]),
    new NodeBlob([new Uint8Array(50000).fill(4)]),
  ];
  const store = {
    put: vi.fn(async () => {}),
    part: vi.fn(),
    readPart: vi.fn(async (_id: string, index: number) => parts[index]),
    list: vi.fn(),
    remove: vi.fn(async () => {}),
  };
  return { job, store: store as unknown as JobStore, spies: store };
}
describe('durable recording publication', () => {
  it('replays identical chunk identities after a lost acknowledgement and removes data only after a confirmed item', async () => {
    const { job, store, spies } = fixture();
    const received = new Map<number, string>();
    let first = true;
    const calls = vi.fn(async (op: string, payload: Record<string, unknown>) => {
      if (op === 'items.append') {
        const index = Number(payload.sequence),
          data = String(payload.base64);
        if (received.has(index)) expect(received.get(index)).toBe(data);
        received.set(index, data);
        if (first) {
          first = false;
          throw new Error('acknowledgement lost');
        }
      }
      if (op === 'recordings.process') return { phase: 'processing' };
      if (op === 'recordings.status') return { phase: 'saved', item: { id: 'owned' } };
      return {};
    });
    const host = calls as unknown as RecordingHost;
    await expect(publishRecording(job, store, host, vi.fn(), async () => {})).rejects.toThrow(
      'lost',
    );
    expect(spies.remove).not.toHaveBeenCalled();
    await publishRecording(job, store, host, vi.fn(), async () => {});
    expect(received.size).toBe(3);
    expect(spies.remove).toHaveBeenCalledExactlyOnceWith('owned');
    expect(calls).toHaveBeenCalledWith('items.finishFile', {
      uploadId: 'owned',
      attachmentId: 'file',
      chunks: 3,
      bytes: 250000,
    });
  });
  it('keeps the original data on MP4 failure and retries processing without re-uploading complete WebM', async () => {
    const { job, store, spies } = fixture();
    const host = vi.fn(async (op: string) =>
      op === 'recordings.process' ? { phase: 'failed', error: 'decode failed' } : {},
    );
    await expect(
      publishRecording(job, store, host as RecordingHost, vi.fn(), async () => {}),
    ).rejects.toThrow('decode failed');
    expect(job.uploaded).toBe(true);
    expect(spies.remove).not.toHaveBeenCalled();
    host.mockClear();
    const recovered = vi.fn(async () => ({ phase: 'saved', item: { id: 'owned' } }));
    await publishRecording(job, store, recovered as RecordingHost, vi.fn(), async () => {});
    expect(recovered).toHaveBeenCalledExactlyOnceWith('recordings.process', {
      uploadId: job.id,
      end: job.end,
    });
  });
  it('does not publish or delete incomplete recording metadata', async () => {
    const { job, store, spies } = fixture();
    job.end = undefined;
    const host = vi.fn();
    await expect(publishRecording(job, store, host, vi.fn(), async () => {})).rejects.toThrow(
      '有效片段',
    );
    expect(host).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });
  it('keeps a confirmed save successful when local cache cleanup fails', async () => {
    const { job, store, spies } = fixture();
    job.uploaded = true;
    spies.remove.mockRejectedValue(new Error('local cache busy'));
    const changed = vi.fn(async () => {});
    await publishRecording(
      job,
      store,
      (async () => ({ phase: 'saved', item: { id: 'owned' } })) as RecordingHost,
      changed,
      async () => {},
    );
    expect(job.phase).toBe('saved');
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ phase: 'saved' }));
  });
});
describe('capture geometry and status placement', () => {
  it('prepares recording when a two-line status bar needs more than its minimum height', async () => {
    const video = document.createElement('video'),
      player = document.createElement('div'),
      layer = document.createElement('div'),
      bar = document.createElement('section');
    player.append(video);
    document.body.append(player, layer);
    bar.className = 'recording-bar';
    layer.append(bar);
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(new DOMRect(162, 68, 885, 664));
    vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(
      () =>
        new DOMRect(
          Number.parseFloat(bar.style.left) || 0,
          Number.parseFloat(bar.style.top) || 0,
          310,
          60,
        ),
    );
    vi.stubGlobal('innerWidth', 1699);
    vi.stubGlobal('innerHeight', 780);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const hooks = videoCapture(
      {
        target: { video, player, site: 'youtube', key: sourceKey(video, 'youtube') },
        validSource: () => true,
        prepareCapture: async () => 0,
        releaseCapture: () => {},
        state: { selection: { a: 0, b: 2 } },
      } as unknown as VideoSession,
      layer,
      (position) => {
        if (position)
          Object.assign(bar.style, { left: `${position.left}px`, top: `${position.top}px` });
      },
    );
    try {
      await expect(hooks.prepare('owned-layout')).resolves.toMatchObject({ a: 0, b: 2 });
      hooks.check('owned-layout');
    } finally {
      hooks.release();
      player.remove();
      layer.remove();
      vi.unstubAllGlobals();
    }
  });
  it('maps a letterboxed capture frame, keeps even output dimensions and rejects clipped sources', () => {
    expect(captureGeometry({ width: 1600, height: 900 }, selection)).toMatchObject({
      x: 260,
      y: 45,
      width: 720,
      height: 405,
      outputWidth: 720,
      outputHeight: 404,
    });
    expect(() =>
      captureGeometry(
        { width: 1600, height: 900 },
        { ...selection, rect: { x: -1, y: 0, width: 640, height: 360 } },
      ),
    ).toThrow('完整视频');
  });
  it('places the status bar outside the captured picture and refuses a full viewport with no room', () => {
    const position = statusPosition(selection.rect, selection.viewport);
    expect(position.top).toBeGreaterThan(selection.rect.y + selection.rect.height);
    expect(() =>
      statusPosition({ x: 0, y: 0, width: 1000, height: 800 }, selection.viewport),
    ).toThrow('留一点空间');
  });
});
