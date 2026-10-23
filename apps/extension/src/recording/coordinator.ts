import { errorMessage, type HostStatus } from '@shared/model';
import type { CaptureEnd, CapturePhase, CaptureSelection, CaptureStatus } from './types';

export interface CaptureTask {
  id: string;
  tabId: number;
  phase: CapturePhase;
  name: string;
  selection?: CaptureSelection;
  lastTime: number;
  cancelled?: boolean;
}
export interface CaptureDependencies {
  ping(): Promise<HostStatus>;
  tell<T = Record<string, unknown>>(
    tabId: number,
    type: string,
    data: Record<string, unknown>,
  ): Promise<T>;
  media(type: string, data: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  streamId(tabId: number): Promise<string>;
  persist(task: CaptureTask): Promise<void>;
  notify(task: CaptureTask, status: CaptureStatus): Promise<void>;
}
export class CaptureCoordinator {
  current: CaptureTask | null = null;
  private stopping?: Promise<void>;
  constructor(private deps: CaptureDependencies) {}
  private async update(task: CaptureTask, phase: CapturePhase, message: string) {
    task.phase = phase;
    await this.deps.persist(task);
    if (this.current !== task || task.phase !== phase) return;
    await this.deps.notify(task, { id: task.id, name: task.name, phase, message });
  }
  private valid(task: CaptureTask) {
    return this.current === task && !task.cancelled && task.phase === 'preparing';
  }
  async start(tabId: number) {
    if (this.current && !['saved', 'failed', 'cancelled'].includes(this.current.phase))
      throw new Error('上次录制仍在进行或保存，请稍候。');
    const task: CaptureTask = {
      id: crypto.randomUUID().replaceAll('-', ''),
      tabId,
      phase: 'preparing',
      name: '视频片段',
      lastTime: 0,
    };
    this.current = task;
    try {
      await this.update(task, 'preparing', '正在准备录制…');
      const status = await this.deps.ping();
      if (!this.valid(task)) return;
      if (!status.configured || status.storageError)
        throw new Error(status.storageError ?? '请先配置有效的草稿箱和资产库。');
      if (!status.recordingToolsAvailable)
        throw new Error('请更新配套本地助手的视频处理组件，再开始录制。');
      const prepared = await this.deps.tell<{
        ok: boolean;
        selection?: CaptureSelection;
        error?: string;
      }>(tabId, 'capture-prepare', { id: task.id });
      if (!this.valid(task)) return;
      if (!prepared.ok || !prepared.selection)
        throw new Error(prepared.error ?? '请先打开视频选段并选择 A/B。');
      task.selection = prepared.selection;
      task.lastTime = prepared.selection.actualStart;
      const date = new Date();
      const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      task.name = `${day}-${prepared.selection.title.slice(0, 100) || '视频片段'}`;
      await this.deps.persist(task);
      const streamId = await this.deps.streamId(tabId);
      if (!this.valid(task)) return;
      const ready = await this.deps.media('prepare', {
        streamId,
        job: {
          id: task.id,
          attachmentId: crypto.randomUUID().replaceAll('-', ''),
          tabId,
          name: task.name,
          selection: task.selection,
          phase: 'preparing',
          parts: 0,
          bytes: 0,
          lastTime: task.lastTime,
          createdAt: new Date().toISOString(),
        },
      });
      if (!this.valid(task)) return;
      if (!ready.ok) throw new Error(ready.error ?? '录制流准备失败。');
      const armed = await this.deps.tell<{ ok: boolean; error?: string }>(tabId, 'capture-check', {
        id: task.id,
      });
      if (!this.valid(task)) return;
      if (!armed.ok) throw new Error(armed.error ?? '视频来源或位置已改变。');
      const started = await this.deps.media('start', { id: task.id });
      if (!this.valid(task)) return;
      if (!started.ok) throw new Error(started.error ?? '录制器未能启动。');
      // Status storage and rendering must not hold a recording on its paused A frame.
      const [, played] = await Promise.all([
        this.update(task, 'recording', '录制中'),
        this.deps.tell<{ ok: boolean; error?: string }>(tabId, 'capture-play', { id: task.id }),
      ]);
      if (task.cancelled || task.phase !== 'recording') return;
      if (!played.ok) throw new Error(played.error ?? '原视频未能播放。');
    } catch (error) {
      if (task.cancelled) return;
      await this.stop('start-failed').catch(() => {});
      await this.update(task, 'failed', errorMessage(error));
    }
  }
  async stop(reason: string) {
    const task = this.current;
    if (!task) return;
    if (this.stopping) return this.stopping;
    if (!['preparing', 'recording', 'stopping'].includes(task.phase)) return;
    const cancelled = task.phase === 'preparing';
    task.cancelled = cancelled;
    this.stopping = (async () => {
      // Pause the source and stop the recorder without waiting for UI acknowledgements.
      await Promise.all([
        this.update(task, 'stopping', cancelled ? '正在取消准备…' : '正在结束录制…'),
        (async () => {
          let actualEnd = task.lastTime;
          try {
            const result = await this.deps.tell<{ actualEnd?: number }>(
              task.tabId,
              'capture-finish',
              {
                id: task.id,
              },
            );
            if (Number.isFinite(result.actualEnd)) actualEnd = result.actualEnd!;
          } catch {}
          const end: CaptureEnd | undefined =
            !cancelled && task.selection && actualEnd > task.selection.actualStart
              ? { actualStart: task.selection.actualStart, actualEnd, stopReason: reason }
              : undefined;
          const stopped = await this.deps.media('stop', { id: task.id, end });
          if (!stopped.ok) throw new Error(stopped.error ?? '录制结束时出错，原始数据已保留。');
        })(),
      ]);
      if (cancelled) await this.update(task, 'cancelled', '已取消录制');
      else if (task.phase === 'stopping') await this.update(task, 'processing', '正在保存 MP4…');
    })()
      .catch(async (error) => {
        await this.update(task, 'failed', errorMessage(error));
      })
      .finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }
  async receive(status: CaptureStatus) {
    const task = this.current;
    if (!task || task.id !== status.id) return;
    task.phase = status.phase;
    await this.deps.persist(task);
    await this.deps.notify(task, status);
  }
  progress(id: string, time: number) {
    const task = this.current;
    if (!task || task.id !== id || task.phase !== 'recording' || !Number.isFinite(time)) return;
    task.lastTime = time;
    void this.deps.persist(task);
    void this.deps.notify(task, {
      id: task.id,
      name: task.name,
      phase: task.phase,
      message: '录制中',
      elapsed: Math.max(0, time - (task.selection?.actualStart ?? time)),
    });
    void this.deps.media('progress', { id, time }).catch(() => {});
  }
}
