import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@shared/model';
import {
  host,
  resumeUpload,
  type UploadList,
  type UploadProgress,
  type UploadSummary,
} from './api';

function bytes(value: number) {
  return value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadRecovery({
  root,
  disabled,
  refreshKey,
  busy,
  changed,
  show,
}: {
  root: string;
  disabled: boolean;
  refreshKey: number;
  busy: (value: boolean) => void;
  changed: (id: string) => Promise<void>;
  show: (message: string) => void;
}) {
  const [jobs, setJobs] = useState<UploadSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState<UploadProgress | null>(null);
  const [deleting, setDeleting] = useState<UploadSummary | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const generation = useRef(0);
  const load = useCallback(
    async (offset = 0) => {
      const version = generation.current;
      try {
        const result = await host<UploadList>('uploads.list', { draftRoot: root, offset });
        if (version !== generation.current) return;
        setJobs((values) => (offset ? [...values, ...result.items] : result.items));
        setTotal(result.total);
        setWarnings(result.warnings);
        setError('');
      } catch (failure) {
        if (version === generation.current) setError(errorMessage(failure));
      }
    },
    [root],
  );
  useEffect(() => {
    generation.current++;
    setJobs([]);
    setChoice(null);
    setDeleting(null);
    void load();
    const focus = () => {
      if (!running.current) void load();
    };
    window.addEventListener('focus', focus);
    return () => {
      generation.current++;
      window.removeEventListener('focus', focus);
    };
  }, [root, refreshKey, load]);

  async function run(task: () => Promise<void>) {
    if (disabled || running.current) return;
    running.current = true;
    busy(true);
    setError('');
    try {
      await task();
    } catch (failure) {
      await load();
      setChoice(null);
      setError(`${errorMessage(failure)}。未完成的数据仍保留在本地。`);
    } finally {
      running.current = false;
      busy(false);
    }
  }
  async function finish(id: string, selected: File[]) {
    await resumeUpload(root, id, selected, show);
    setChoice(null);
    setJobs((values) => values.filter((job) => job.id !== id));
    show('已继续保存到草稿箱');
    await changed(id);
  }
  async function proceed(job: UploadSummary) {
    const progress = await host<UploadProgress>('uploads.get', {
      draftRoot: root,
      uploadId: job.id,
    });
    if (progress.phase === 'saved' || progress.files.every((file) => file.complete))
      await finish(job.id, []);
    else setChoice(progress);
  }

  if (!jobs.length && !error && !warnings.length) return null;
  return (
    <section className="status upload-recovery" aria-label="未完成的保存">
      <div className="row recovery-heading">
        <strong>未完成的保存{total ? ` · ${total}` : ''}</strong>
        <button className="button" disabled={disabled} onClick={() => void load()}>
          刷新未完成保存
        </button>
      </div>
      <p className="muted">
        已收到的内容留在本地。附件收齐后可直接继续保存；未收齐的需重新选择剩余原文件。
      </p>
      {jobs.map((job) => (
        <div key={job.id} className="recovery-item">
          <div className="row recovery-heading">
            <div className="recovery-summary">
              <strong>{job.name}</strong>
              <small className="muted">
                {job.fileCount} 个附件 · 已收齐 {job.completeFiles} 个 · 已收到{' '}
                {bytes(job.receivedBytes)}
                {job.totalBytes !== null ? ` / ${bytes(job.totalBytes)}` : ''}
              </small>
            </div>
            <div className="row">
              <button
                className="button primary"
                disabled={disabled}
                onClick={() => void run(() => proceed(job))}
              >
                {job.completeFiles === job.fileCount ? '继续保存' : '选择原文件继续'}
              </button>
              <button className="button" disabled={disabled} onClick={() => setDeleting(job)}>
                删除未完成保存
              </button>
            </div>
          </div>
          {choice?.id === job.id && (
            <div className="recovery-choice">
              <p>只需选择以下尚未收齐的原文件，已收齐的附件会保留：</p>
              <ul>
                {choice.files
                  .filter((file) => !file.complete)
                  .map((file) => (
                    <li key={file.id}>
                      {file.originalName || file.fileName}
                      {file.bytes !== null
                        ? ` · ${bytes(file.bytes)}`
                        : ' · 旧记录，请选择对应原文件'}
                    </li>
                  ))}
              </ul>
              <button className="button" disabled={disabled} onClick={() => input.current?.click()}>
                选择这些原文件
              </button>
              <button className="button" disabled={disabled} onClick={() => setChoice(null)}>
                暂不处理
              </button>
            </div>
          )}
        </div>
      ))}
      <input
        ref={input}
        type="file"
        aria-label="恢复保存的原文件"
        multiple
        accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov"
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (selected.length && choice) void run(() => finish(choice.id, selected));
        }}
      />
      {jobs.length < total && (
        <button className="button" disabled={disabled} onClick={() => void load(jobs.length)}>
          显示更多未完成保存
        </button>
      )}
      {warnings.map((warning, index) => (
        <p key={index}>{warning}</p>
      ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="confirm stack"
            role="dialog"
            aria-modal="true"
            aria-labelledby="discard-title"
          >
            <h2 id="discard-title">删除这次未完成的保存？</h2>
            <p>{deleting.name} 的暂存内容删除后不可恢复，原文件不受影响。</p>
            <div className="row">
              <button
                autoFocus
                className="button"
                disabled={disabled}
                onClick={() => setDeleting(null)}
              >
                取消
              </button>
              <button
                className="button danger"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    await host('uploads.discard', {
                      draftRoot: root,
                      uploadId: deleting.id,
                      confirmed: true,
                    });
                    const id = deleting.id;
                    setDeleting(null);
                    setChoice(null);
                    setJobs((values) => values.filter((job) => job.id !== id));
                    show('已删除这次未完成的保存');
                    await changed(id);
                  })
                }
              >
                确认删除
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
