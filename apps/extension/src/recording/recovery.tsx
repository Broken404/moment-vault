import { useEffect, useRef, useState } from 'react';
import type { CaptureStatus } from './types';
import { errorMessage } from '@shared/model';

export function RecordingRecovery({ changed }: { changed: () => void }) {
  const [jobs, setJobs] = useState<CaptureStatus[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const result = await chrome.runtime.sendMessage({
          target: 'background',
          type: 'recording-jobs',
        });
        if (!result?.ok)
          throw new Error(result?.error?.message ?? result?.error ?? '无法读取未完成录制');
        if (alive) {
          setJobs(result.jobs ?? []);
          setError('');
        }
      } catch (failure) {
        if (alive) setError(errorMessage(failure));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const retry = async (id: string) => {
    try {
      const result = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'recording-retry',
        id,
      });
      if (!result?.ok) throw new Error(result?.error?.message ?? result?.error ?? '重试失败');
      setJobs((values) =>
        values.map((job) =>
          job.id === id ? { ...job, phase: 'processing', message: '正在重试保存 MP4…' } : job,
        ),
      );
      changed();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const processing = jobs.some((job) => job.phase === 'processing');
  const wasProcessing = useRef(false);
  useEffect(() => {
    if (wasProcessing.current && !processing) changed();
    wasProcessing.current = processing;
  }, [processing]);
  if (!jobs.length && !error) return null;
  return (
    <section className="status" aria-label="未完成的录制">
      <strong>录制保存</strong>
      {jobs.map((job) => (
        <div key={job.id} className="row">
          <span>
            {job.name} · {job.message}
          </span>
          {job.phase === 'failed' && (
            <button className="button" onClick={() => void retry(job.id)}>
              重试保存 MP4
            </button>
          )}
        </div>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
