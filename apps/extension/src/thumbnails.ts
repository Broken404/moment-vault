import type { Attachment, Bucket, Material } from '@shared/model';
import { host } from './api';

export interface ThumbnailReply {
  phase: 'loading' | 'ready' | 'unavailable';
  base64?: string;
  mime?: string;
}
type Request = (bucket: Bucket, id: string, attachmentId: string) => Promise<ThumbnailReply>;
interface Subscriber {
  resolve: (value: string | null) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}
interface Job {
  key: string;
  bucket: Bucket;
  item: Material;
  subscribers: Set<Subscriber>;
  controller: AbortController;
}
const aborted = () => new DOMException('Thumbnail no longer visible', 'AbortError');

// Cache only small generated PNGs, never entire source images or videos.
export class ThumbnailLoader {
  private cache = new Map<string, string>();
  private cacheBytes = 0;
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active = 0;
  constructor(
    private request: Request,
    private capacity = 16 * 1024 * 1024,
    private concurrency = 2,
    private pause = (signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(aborted());
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, 250);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
  ) {}
  private key(scope: string, bucket: Bucket, item: Material): string {
    return JSON.stringify([
      scope,
      bucket,
      item.id,
      item.revision,
      item.attachments.map((a) => [a.id, a.fileName, a.sha256, a.bytes]),
    ]);
  }
  load(scope: string, bucket: Bucket, item: Material, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return Promise.reject(aborted());
    const key = this.key(scope, bucket, item);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, bucket, item, subscribers: new Set(), controller: new AbortController() };
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    const current = job;
    const result = new Promise<string | null>((resolve, reject) => {
      const subscriber: Subscriber = {
        resolve,
        reject,
        signal,
        abort: () => {
          signal.removeEventListener('abort', subscriber.abort);
          current.subscribers.delete(subscriber);
          reject(aborted());
          if (!current.subscribers.size) {
            current.controller.abort();
            this.queue = this.queue.filter((j) => j !== current);
            if (this.jobs.get(key) === current) this.jobs.delete(key);
          }
        },
      };
      current.subscribers.add(subscriber);
      signal.addEventListener('abort', subscriber.abort, { once: true });
    });
    this.pump();
    return result;
  }
  clear(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }
  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.controller.signal.aborted) continue;
      this.active++;
      void this.render(job)
        .then(
          (value) => {
            if (job.controller.signal.aborted) return;
            if (value && value.length * 2 <= this.capacity) {
              this.cache.set(job.key, value);
              this.cacheBytes += value.length * 2;
              while (this.cacheBytes > this.capacity || this.cache.size > 150) {
                const oldest = this.cache.keys().next().value!;
                this.cacheBytes -= this.cache.get(oldest)!.length * 2;
                this.cache.delete(oldest);
              }
            }
            for (const subscriber of job.subscribers) subscriber.resolve(value);
          },
          (error: unknown) => {
            for (const subscriber of job.subscribers) subscriber.reject(error);
          },
        )
        .finally(() => {
          for (const subscriber of job.subscribers)
            subscriber.signal.removeEventListener('abort', subscriber.abort);
          if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
          this.active--;
          this.pump();
        });
    }
  }
  private async render(job: Job): Promise<string | null> {
    const signal = job.controller.signal;
    const deadline = Date.now() + 35_000;
    for (const file of job.item.attachments) {
      while (!signal.aborted && Date.now() < deadline) {
        const result = await this.read(job, file.id, deadline);
        if (signal.aborted) throw aborted();
        if (
          result.phase === 'ready' &&
          result.mime === 'image/png' &&
          result.base64 &&
          result.base64.length <= 220_000
        )
          return `data:image/png;base64,${result.base64}`;
        if (result.phase !== 'loading') break;
        await this.pause(signal);
      }
      if (signal.aborted) throw aborted();
      if (Date.now() >= deadline) break;
    }
    return null;
  }
  private read(job: Job, attachmentId: string, deadline: number): Promise<ThumbnailReply> {
    const signal = job.controller.signal;
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        clean();
        reject(aborted());
      };
      const timer = setTimeout(
        () => {
          clean();
          reject(new Error('缩略图读取超时'));
        },
        Math.max(1, deadline - Date.now()),
      );
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        this.request(job.bucket, job.item.id, attachmentId).then(
          (value) => {
            clean();
            resolve(value);
          },
          (error: unknown) => {
            clean();
            reject(error);
          },
        );
      } catch (error) {
        clean();
        reject(error);
      }
    });
  }
}

export const thumbnails = new ThumbnailLoader((bucket, id, attachmentId) =>
  host<ThumbnailReply>('items.thumbnail', { bucket, id, attachmentId }),
);

export function attachmentCounts(files: Attachment[]): string {
  const images = files.filter((file) => file.kind === 'image').length;
  const videos = files.length - images;
  return [images ? `${images} 张图片` : '', videos ? `${videos} 段视频` : '']
    .filter(Boolean)
    .join(' · ');
}
