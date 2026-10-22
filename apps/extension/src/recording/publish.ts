import type { JobStore, PublishResult, RecordingHost, RecordingJob } from './types';

function base64(bytes: Uint8Array) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
// Replay uses exactly the same upload and chunk identities after a lost acknowledgement.
// The persisted WebM parts are removed only after the host confirms a visible MP4 item.
export async function publishRecording(
  job: RecordingJob,
  store: JobStore,
  host: RecordingHost,
  changed: (job: RecordingJob) => Promise<void>,
  delay: () => Promise<void>,
): Promise<void> {
  if (!job.end || job.end.actualEnd <= job.end.actualStart || !job.parts)
    throw new Error('录制没有取得有效片段，原始数据已保留。');
  if (!job.uploaded) {
    await host('recordings.begin', {
      uploadId: job.id,
      attachmentId: job.attachmentId,
      name: job.name,
      source: job.selection.source,
      selection: { a: job.selection.a, b: job.selection.b },
      note: '',
    });
    let sequence = 0,
      bytes = 0;
    for (let index = 0; index < job.parts; index++) {
      const part = await store.readPart(job.id, index);
      for (let offset = 0; offset < part.size; offset += 192 * 1024) {
        const data = new Uint8Array(await part.slice(offset, offset + 192 * 1024).arrayBuffer());
        await host('items.append', {
          uploadId: job.id,
          attachmentId: job.attachmentId,
          sequence,
          base64: base64(data),
        });
        sequence++;
        bytes += data.length;
      }
    }
    if (bytes !== job.bytes) throw new Error('录制暂存总长度不一致，原始数据已保留。');
    await host('items.finishFile', {
      uploadId: job.id,
      attachmentId: job.attachmentId,
      chunks: sequence,
      bytes,
    });
    job.uploaded = true;
    await store.put(job);
  }
  let result = await host<PublishResult>('recordings.process', { uploadId: job.id, end: job.end });
  while (result.phase === 'processing') {
    await delay();
    result = await host<PublishResult>('recordings.status', { uploadId: job.id });
  }
  if (result.phase !== 'saved' || !result.item)
    throw new Error(result.error ?? 'MP4 尚未保存，原始数据已保留。');
  job.phase = 'saved';
  job.error = undefined;
  job.itemId = result.item.id;
  // Once the host confirms the visible item, cache housekeeping cannot undo that save.
  // A retained saved job is cleaned up when recovery next lists the local jobs.
  await store.put(job).catch(() => {});
  await changed(job);
  await store.remove(job.id).catch(() => {});
}
