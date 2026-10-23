// start() changes state synchronously and begins taking input. Waiting for onstart
// can already record a paused A frame while the encoder queues that event.
export function startRecorder(recorder: MediaRecorder): void {
  const state = () => recorder.state;
  if (state() !== 'inactive') throw new Error('当前录制器无法重新开始。');
  recorder.start(500);
  if (state() !== 'recording') throw new Error('录制器未进入录制状态。');
}
