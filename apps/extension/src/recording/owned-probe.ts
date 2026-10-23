import type { JobStore, RecordingJob } from './types';

declare const __MV_OWNED_CAPTURE_LAB__: boolean;

// Development-only, fixed owned source. No ordinary page or platform recordings are exported.
export function ownedProbeEnabled(source: string) {
  return (
    typeof __MV_OWNED_CAPTURE_LAB__ !== 'undefined' &&
    __MV_OWNED_CAPTURE_LAB__ &&
    source === 'http://127.0.0.1:43820/capture.html'
  );
}
export function ownedProbe(source: string, id: string, side: 'source' | 'input') {
  // Keep the guard at this boundary so normal builds remove even the export endpoint.
  if (typeof __MV_OWNED_CAPTURE_LAB__ === 'undefined' || !__MV_OWNED_CAPTURE_LAB__)
    return undefined;
  if (!ownedProbeEnabled(source) || !/^[a-f0-9]{32}$/.test(id)) return undefined;
  const started = performance.now();
  const samples: Array<[number, string, number, number, number, number]> = [];
  const upload = async (name: string, body: Blob) => {
    try {
      const response = await fetch(`http://127.0.0.1:43820/probe/${id}/${name}`, {
        method: 'POST',
        headers: { 'X-Moment-Vault-Owned-Probe': '1' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Owned probe returned ${response.status}`);
    } catch (error) {
      console.warn('[DEBUG-mv-freeze] Owned probe export failed', error);
    }
  };
  return {
    mark(stage: string, video: HTMLVideoElement) {
      if (samples.length >= 1200) return;
      const quality = video.getVideoPlaybackQuality();
      samples.push([
        performance.now() - started,
        stage,
        video.currentTime,
        quality.totalVideoFrames,
        quality.droppedVideoFrames,
        video.readyState,
      ]);
    },
    async save(extra: Record<string, unknown>) {
      await upload(
        side + '.json',
        new Blob(
          [
            JSON.stringify({
              id,
              side,
              source,
              epochMs: performance.timeOrigin + started,
              columns: ['elapsedMs', 'stage', 'mediaTime', 'totalFrames', 'droppedFrames', 'ready'],
              samples,
              ...extra,
            }),
          ],
          { type: 'application/json' },
        ),
      );
    },
    async saveRaw(job: RecordingJob, store: JobStore) {
      try {
        const parts: Blob[] = [];
        for (let i = 0; i < job.parts; i++) parts.push(await store.readPart(job.id, i));
        await upload('capture.webm', new Blob(parts, { type: 'video/webm' }));
      } catch (error) {
        console.warn('[DEBUG-mv-freeze] Owned raw export failed', error);
      }
    },
  };
}
