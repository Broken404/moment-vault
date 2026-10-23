import { describe, expect, it, vi } from 'vitest';
import { keepVideoFramesActive } from '../apps/extension/src/recording/frame-consumer';

function frames() {
  let sequence = 0;
  const pending = new Map<number, VideoFrameRequestCallback>();
  const request = vi.fn((callback: VideoFrameRequestCallback) => {
    const id = ++sequence;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => pending.delete(id));
  return {
    video: {
      requestVideoFrameCallback: request,
      cancelVideoFrameCallback: cancel,
    } as unknown as HTMLVideoElement,
    request,
    cancel,
    pending,
    present() {
      const [id, callback] = pending.entries().next().value!;
      pending.delete(id);
      callback(0, {} as VideoFrameCallbackMetadata);
      return callback;
    },
  };
}
describe('offscreen input frame consumer lifecycle (not real browser acceptance)', () => {
  it('keeps receiving input frames without depending on the separate canvas draw timer', () => {
    const input = frames(),
      onFrame = vi.fn();
    const stop = keepVideoFramesActive(input.video, onFrame);
    expect(input.pending.size).toBe(1);
    input.present();
    input.present();
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(input.pending.size).toBe(1);
    stop();
    expect(input.pending.size).toBe(0);
  });
  it('ignores an in-flight callback after release and makes repeated cleanup safe', () => {
    const input = frames(),
      onFrame = vi.fn();
    const stop = keepVideoFramesActive(input.video, onFrame);
    expect(input.pending.size).toBe(1);
    const late = input.present();
    stop();
    stop();
    late(0, {} as VideoFrameCallbackMetadata);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(input.request).toHaveBeenCalledTimes(2);
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(input.pending.size).toBe(0);
  });
});
