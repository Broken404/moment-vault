// Observations only: this module does not schedule drawing or start capture.
export function captureDiagnostics(video, now = () => performance.now()) {
  const began = now();
  let drawCalls = 0, drawErrors = 0, presentedCallbacks = 0, lastMediaTime = null;
  let lastSampleAt = -Infinity;
  const samples = [];
  function sample() {
    const quality = video.getVideoPlaybackQuality?.();
    return {
      elapsedMs: Math.round(now() - began),
      drawCalls, drawErrors, presentedCallbacks, lastMediaTime,
      inputTime: video.currentTime ?? null,
      inputReadyState: video.readyState,
      decodedFrames: quality?.totalVideoFrames ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? null,
    };
  }
  function checkpoint() {
    if (now() - lastSampleAt < 250) return;
    lastSampleAt = now();
    if (samples.length === 64) samples.shift();
    samples.push(sample());
  }
  return {
    drew() { drawCalls++; checkpoint(); },
    drawFailed() { drawErrors++; checkpoint(); },
    presented(frame) {
      presentedCallbacks++;
      lastMediaTime = Number.isFinite(frame.mediaTime) ? frame.mediaTime : null;
    },
    finish() { return { ...sample(), samples: [...samples] }; },
  };
}
