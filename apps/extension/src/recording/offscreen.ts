import { errorMessage } from '@shared/model';
import { recordingStore as store } from './store';
import { publishRecording } from './publish';
import { startRecorder } from './recorder';
import { ownedProbe } from './owned-probe';
import { keepVideoFramesActive } from './frame-consumer';
import {
  captureGeometry,
  publicStatus,
  type RecordingJob,
  type CaptureEnd,
  type RecordingHost,
} from './types';

interface Live {
  job: RecordingJob;
  aborted: boolean;
  stream?: MediaStream;
  output?: MediaStream;
  video?: HTMLVideoElement;
  audio?: AudioContext;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setInterval>;
  startupTimer?: ReturnType<typeof setTimeout>;
  persisted: Promise<void>;
  backlog: number;
  stopped?: Promise<void>;
  ended?: Promise<void>;
  started?: boolean;
  probe?: ReturnType<typeof ownedProbe>;
  stopFrames?: () => void;
}
let live: Live | undefined;
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('录制画面准备超时。')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
const publishing = new Map<string, Promise<void>>();
const changed = async (job: RecordingJob) => {
  await chrome.runtime
    .sendMessage({
      target: 'background',
      type: 'capture-status',
      tabId: job.tabId,
      status: publicStatus(job),
    })
    .catch(() => {});
};
const host: RecordingHost = async (op, payload) => {
  const response = await chrome.runtime.sendMessage({
    target: 'background',
    type: 'recording-host',
    op,
    payload,
  });
  if (!response?.ok)
    throw new Error(response?.error?.message ?? '本地助手未返回结果，录制原始数据已保留。');
  return response.result;
};
async function publish(job: RecordingJob) {
  if (publishing.has(job.id)) return;
  const task = (async () => {
    try {
      job.phase = 'processing';
      job.error = undefined;
      await store.put(job);
      await changed(job);
      await publishRecording(
        job,
        store,
        host,
        changed,
        () => new Promise((resolve) => setTimeout(resolve, 750)),
      );
    } catch (error) {
      job.phase = 'failed';
      job.error = errorMessage(error);
      await store.put(job);
      await changed(job);
    } finally {
      publishing.delete(job.id);
    }
  })();
  publishing.set(job.id, task);
  void task;
}
async function release(value: Live) {
  value.stopFrames?.();
  clearInterval(value.timer);
  clearTimeout(value.startupTimer);
  for (const track of new Set([
    ...(value.stream?.getTracks() ?? []),
    ...(value.output?.getTracks() ?? []),
  ]))
    track.stop();
  value.video?.pause();
  if (value.video) value.video.srcObject = null;
  await value.audio?.close().catch(() => {});
}
function stopSignal(value: Live, reason: string) {
  void chrome.runtime
    .sendMessage({ target: 'background', type: 'capture-ended', id: value.job.id, reason })
    .catch(() => {});
}
async function prepare(job: RecordingJob, streamId: string) {
  if (live || publishing.size) throw new Error('上次录制仍在处理，请稍候。');
  const value: Live = { job, aborted: false, persisted: Promise.resolve(), backlog: 0 };
  value.probe = ownedProbe(job.selection.source, job.id, 'input');
  live = value;
  await store.put(job);
  try {
    const mediaPromise = navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxWidth: 2560,
          maxHeight: 1440,
        },
      },
    } as unknown as MediaStreamConstraints);
    void mediaPromise
      .then((media) => {
        if (value.aborted) for (const track of media.getTracks()) track.stop();
      })
      .catch(() => {});
    const media = await bounded(mediaPromise, 12000);
    value.stream = media;
    if (value.aborted || live !== value) {
      await release(value);
      throw new Error('录制准备已取消。');
    }
    const video = document.createElement('video');
    value.video = video;
    video.muted = true;
    video.srcObject = media;
    await bounded(video.play(), 8000);
    value.probe?.mark('input-ready', video);
    if (value.aborted || live !== value) throw new Error('录制准备已取消。');
    if (video.readyState < 2 || !video.videoWidth || !media.getAudioTracks().length)
      throw new Error('当前标签没有就绪的音视频录制流。');
    value.stopFrames = keepVideoFramesActive(video, () => value.probe?.mark('input-frame', video));
    value.audio = new AudioContext();
    value.audio.createMediaStreamSource(media).connect(value.audio.destination);
    await value.audio.resume();
    const geometry = captureGeometry(
      { width: video.videoWidth, height: video.videoHeight },
      job.selection,
    );
    const canvas = document.createElement('canvas');
    canvas.width = geometry.outputWidth;
    canvas.height = geometry.outputHeight;
    const context = canvas.getContext('2d', { alpha: false })!;
    const draw = () => {
      if (value.aborted) return;
      try {
        if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error('录制画面已断开。');
        context.drawImage(
          video,
          geometry.x,
          geometry.y,
          geometry.width,
          geometry.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        value.probe?.mark('draw', video);
      } catch {
        stopSignal(value, 'capture-frame-error');
      }
    };
    draw();
    value.timer = setInterval(draw, 1000 / 30);
    value.output = canvas.captureStream(30);
    for (const track of media.getAudioTracks()) value.output.addTrack(track);
    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('浏览器没有支持的录制编码器。');
    const recorder = new MediaRecorder(value.output, { mimeType, videoBitsPerSecond: 4_000_000 });
    value.recorder = recorder;
    recorder.onstart = () => clearTimeout(value.startupTimer);
    value.ended = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      if (value.video) value.probe?.mark('recorder-chunk', value.video);
      value.backlog += event.data.size;
      value.persisted = value.persisted.then(async () => {
        await store.part(job.id, job.parts, event.data);
        job.parts++;
        job.bytes += event.data.size;
        value.backlog -= event.data.size;
        await store.put(job);
      });
      void value.persisted.catch(() => stopSignal(value, 'temporary-storage-failed'));
      if (value.backlog > 16 * 1024 * 1024) {
        stopSignal(value, 'temporary-storage-slow');
        if (recorder.state === 'recording') recorder.stop();
      }
    };
    recorder.onerror = () => stopSignal(value, 'recorder-error');
    for (const track of media.getTracks())
      track.addEventListener(
        'ended',
        () => {
          if (!value.aborted) stopSignal(value, 'capture-stream-ended');
        },
        { once: true },
      );
    return { ok: true };
  } catch (error) {
    value.aborted = true;
    await release(value);
    if (live === value) live = undefined;
    if (!job.parts) await store.remove(job.id);
    throw error;
  }
}
async function start(id: string) {
  const value = live;
  if (!value || value.job.id !== id || value.aborted || !value.recorder)
    throw new Error('录制准备已取消。');
  const recorder = value.recorder;
  value.job.phase = 'recording';
  await store.put(value.job);
  if (value.aborted || live !== value) throw new Error('录制准备已取消。');
  startRecorder(recorder);
  if (value.video) value.probe?.mark('recorder-start', value.video);
  value.started = true;
  // Keep the failure watchdog without holding source playback for this event.
  value.startupTimer = setTimeout(() => {
    if (!value.aborted) stopSignal(value, 'recorder-start-timeout');
  }, 5000);
  return { ok: true };
}
async function stop(id: string, end?: CaptureEnd) {
  const value = live;
  if (!value || value.job.id !== id) return { ok: true };
  value.stopped ??= (async () => {
    if (value.video) value.probe?.mark('recorder-stop', value.video);
    value.aborted = true;
    try {
      if (value.recorder?.state === 'recording') value.recorder.stop();
      if (value.started) await value.ended;
    } finally {
      await release(value);
      if (live === value) live = undefined;
    }
    await value.persisted;
    if (value.probe) {
      await value.probe.save({ selection: value.job.selection, end, parts: value.job.parts });
      await value.probe.saveRaw(value.job, store);
    }
    if (!value.started || !end || end.actualEnd <= end.actualStart) {
      if (!value.job.parts) await store.remove(id);
      else {
        value.job.phase = 'failed';
        value.job.error = '没有完整的实际录制区间，原始数据已保留。';
        await store.put(value.job);
        await changed(value.job);
      }
      return;
    }
    value.job.end = end;
    await store.put(value.job);
    await publish(value.job);
  })();
  await value.stopped;
  return { ok: true };
}
async function jobs() {
  const list = await store.list();
  for (const job of list) {
    if (job.phase === 'saved') {
      await store.remove(job.id);
      continue;
    }
    if (
      !live &&
      !publishing.has(job.id) &&
      ['preparing', 'recording', 'stopping', 'processing'].includes(job.phase)
    ) {
      job.phase = 'failed';
      job.error = '上次录制或保存被中断，原始数据已保留，请重试。';
      await store.put(job);
    }
  }
  return list.filter((job) => job.phase !== 'saved');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  const task = (async () => {
    if (message.type === 'prepare') return prepare(message.job, message.streamId);
    if (message.type === 'start') return start(message.id);
    if (message.type === 'stop') return stop(message.id, message.end);
    if (message.type === 'progress') {
      const current = live;
      if (current && current.job.id === message.id) {
        current.job.lastTime = message.time;
        await store.put(current.job);
      }
      return { ok: true };
    }
    if (message.type === 'jobs')
      return {
        ok: true,
        jobs: (await jobs()).map((job) => ({ ...publicStatus(job), tabId: job.tabId })),
      };
    if (message.type === 'retry') {
      const job = (await jobs()).find((job) => job.id === message.id);
      if (!job?.end)
        throw new Error('这次录制缺少实际结束范围，暂不能自动恢复成片，原始数据已保留。');
      if (live || publishing.size) throw new Error('仍有录制正在处理，请稍候。');
      await publish(job);
      return { ok: true };
    }
    throw new Error('未知录制操作');
  })();
  task.then(respond).catch((error) => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
