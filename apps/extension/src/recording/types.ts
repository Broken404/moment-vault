import type { Material, RecordingProgress } from '@shared/model';

export type CapturePhase =
  'preparing' | 'recording' | 'stopping' | 'processing' | 'saved' | 'failed' | 'cancelled';
export interface CaptureStatus {
  id: string;
  phase: CapturePhase;
  name: string;
  message: string;
  elapsed?: number;
  itemId?: string;
}
export interface CaptureSelection {
  a: number;
  b: number;
  actualStart: number;
  source: string;
  title: string;
  viewport: { width: number; height: number };
  rect: { x: number; y: number; width: number; height: number };
}
export interface CaptureEnd {
  actualStart: number;
  actualEnd: number;
  stopReason: string;
}
export interface RecordingJob {
  id: string;
  attachmentId: string;
  tabId: number;
  name: string;
  selection: CaptureSelection;
  phase: CapturePhase;
  end?: CaptureEnd;
  error?: string;
  uploaded?: boolean;
  itemId?: string;
  parts: number;
  bytes: number;
  lastTime: number;
  createdAt: string;
}
export interface RecordingHost {
  <T = unknown>(
    op:
      | 'recordings.begin'
      | 'recordings.process'
      | 'recordings.status'
      | 'items.append'
      | 'items.finishFile',
    payload: Record<string, unknown>,
  ): Promise<T>;
}
export interface JobStore {
  put(job: RecordingJob): Promise<void>;
  part(id: string, index: number, blob: Blob): Promise<void>;
  readPart(id: string, index: number): Promise<Blob>;
  list(): Promise<RecordingJob[]>;
  remove(id: string): Promise<void>;
}
export function publicStatus(job: RecordingJob): CaptureStatus {
  return {
    id: job.id,
    phase: job.phase,
    name: job.name,
    itemId: job.itemId,
    message:
      job.error ??
      {
        preparing: '正在准备录制…',
        recording: '录制中',
        stopping: '正在结束录制…',
        processing: '正在保存 MP4…',
        saved: '已存入草稿箱',
        failed: '保存失败，原始数据已保留',
        cancelled: '已取消录制',
      }[job.phase],
  };
}
export type PublishResult = RecordingProgress & { item?: Material };

export function captureGeometry(
  frame: { width: number; height: number },
  selection: Pick<CaptureSelection, 'viewport' | 'rect'>,
) {
  const { viewport, rect } = selection;
  if (
    ![
      frame.width,
      frame.height,
      viewport.width,
      viewport.height,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    ].every(Number.isFinite) ||
    Math.min(frame.width, frame.height, viewport.width, viewport.height, rect.width, rect.height) <=
      0 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > viewport.width + 0.5 ||
    rect.y + rect.height > viewport.height + 0.5
  )
    throw new Error('请将完整视频画面放在网页可见区域后再录制。');
  const scale = Math.min(frame.width / viewport.width, frame.height / viewport.height);
  const paddingX = (frame.width - viewport.width * scale) / 2,
    paddingY = (frame.height - viewport.height * scale) / 2;
  return {
    x: paddingX + rect.x * scale,
    y: paddingY + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
    outputWidth: Math.max(2, Math.floor((rect.width * scale) / 2) * 2),
    outputHeight: Math.max(2, Math.floor((rect.height * scale) / 2) * 2),
  };
}
