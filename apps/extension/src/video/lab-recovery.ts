// Owned browser fault injection only; imported by lab.tsx, never by the extension entry points.
import type { CaptureHooks } from './capture';
import type { SelectionState } from './session';

export async function checkSavedPreview(
  video: HTMLVideoElement,
  hooks: CaptureHooks,
  state: () => SelectionState | null,
  progress: (message: string) => void,
) {
  const before = state();
  if (!before || before.active !== 'b' || before.loading)
    throw new Error('请先点击终点 B，并等待边界画面就绪。');
  const selected = await hooks.prepare('owned-preview-recovery'),
    original = video.requestVideoFrameCallback;
  let released = false,
    blocked = false,
    requests = 0;
  try {
    hooks.finish('owned-preview-recovery'); // Clear capture monitoring; the fixture drives playback.
    await new Promise<void>((resolve, reject) => {
      let frame: number;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        video.cancelVideoFrameCallback(frame);
        video.pause();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('自制播放检查未到达终点。')), 20000);
      const watch: VideoFrameRequestCallback = () => {
        if (!video.isConnected) finish(new Error('自制播放器已移除。'));
        else if (video.currentTime >= selected.b) finish();
        else frame = video.requestVideoFrameCallback(watch);
      };
      frame = video.requestVideoFrameCallback(watch);
      void video.play().catch((error) => finish(error));
    });
    progress(`自制视频已暂停于 ${video.currentTime.toFixed(6)} 秒，模拟处理完成后不再返回新帧…`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    video.requestVideoFrameCallback = () => {
      requests++;
      return original.call(video, () => {});
    };
    blocked = true;
    hooks.release();
    released = true;
    await new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 9000;
      const check = () => {
        const current = state();
        if (!current || !video.isConnected) reject(new Error('自制会话已关闭。'));
        else if (!current.loading) {
          if (current.message) reject(new Error(current.message));
          else resolve();
        } else if (performance.now() >= deadline) reject(new Error('预览未在九秒内结束等待。'));
        else setTimeout(check, 20);
      };
      setTimeout(check, 20);
    });
    const current = state()!;
    if (!current.cached || current.requested !== selected.b || requests !== 0)
      throw new Error(`未复用已确认的 B 画面；新增取帧请求 ${requests} 次。`);
    return `恢复通过：B=${selected.b.toFixed(3)} 秒，画面 ${current.actual?.toFixed(3)} 秒，复用缓存，新增取帧请求 ${requests} 次`;
  } finally {
    if (blocked) video.requestVideoFrameCallback = original;
    if (!released) hooks.release();
  }
}
