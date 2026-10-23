// A detached MediaStream video still needs a frame subscriber. In Chromium this
// keeps compositor BeginFrames active even when the video is offscreen:
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/mediastream/web_media_player_ms.cc
// Canvas drawing remains on its existing 30 Hz clock; this loop updates the input.
export function keepVideoFramesActive(video: HTMLVideoElement, onFrame: () => void) {
  let stopped = false;
  const receive: VideoFrameRequestCallback = () => {
    if (stopped) return;
    frame = video.requestVideoFrameCallback(receive);
    onFrame();
  };
  let frame = video.requestVideoFrameCallback(receive);
  return () => {
    if (stopped) return;
    stopped = true;
    video.cancelVideoFrameCallback(frame);
  };
}
