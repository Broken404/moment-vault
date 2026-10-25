import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Validate reports exported through browser UI tools from the owned media lab.
// This does not drive a browser, replace live-site checks, or establish a UI SLO.
const directory = path.resolve(process.argv[2] ?? '.local-data/video-performance-20261025');
assert.ok(directory.startsWith(path.resolve('.local-data') + path.sep));
const read = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const last = (rows) => rows.at(-1);
const contains = (ranges, time) => ranges.some(([start, end]) => start <= time && time <= end);
function released(row) {
  assert.equal(row.closed, true);
  const result = row.afterClose;
  assert.equal(result.cacheBytes, 0);
  assert.equal(result.cacheEntries, 0);
  assert.equal(result.queueClosed, true);
  assert.equal(result.queuePending, false);
  assert.equal(result.queueRunning, false);
  assert.equal(result.hostConnected, false);
  assert.equal(result.paused, true);
  assert.ok(Math.abs(result.videoTime) < 0.15);
}
const portrait = await read('portrait-quality-state.json');
assert.deepEqual(portrait.preview, [{ width: 180, height: 320 }]);
assert.equal(portrait.video[0].width, 180);
const qualityState = JSON.parse(portrait.diagnostics);
assert.equal(qualityState.a, 2);
assert.equal(qualityState.b, 5);
assert.equal(qualityState.cacheEntries, 1);
assert.equal(qualityState.cacheBytes, 180 * 320 * 4);
const pointer = last(await read('portrait-youtube-pointer.json'));
const dragFrame = pointer.ready.find((row) => row.target === 19.401);
assert.ok(dragFrame && Math.abs(dragFrame.actual - 19.401) < 0.15);
const dragInput = pointer.inputToNextRaf.filter((row) => row.type === 'pointermove').slice(-8);
assert.ok(dragInput.length >= 5);
const slow = last(await read('slow-seek.json'));
const slowTarget = slow.requests.find((row) => row.target === 35);
assert.ok(contains(slowTarget.seekable, 35) && !contains(slowTarget.buffered, 35));
assert.ok(slow.ready.some((row) => row.target === 35 && row.actual === 35 && !row.error));
const failed = last(await read('timeout-before-retry.json'));
assert.ok(failed.ready.some((row) => row.target === 35 && row.error.includes('目标画面')));
const retried = last(await read('timeout-after-retry.json'));
assert.ok(retried.ready.some((row) => row.target === 35 && row.actual === 35 && !row.error));
const oldCached = last(await read('cached-behind-pending-before-complete.json')).ready.at(-1);
assert.ok(oldCached.cached && oldCached.ms > 5000);
const fixed = await read('cached-behind-pending-after-exact.json');
const fixedReport = last(fixed.reports);
assert.ok(
  fixed.pending.loading && fixed.pending.requested === 35 && fixed.pending.cacheEntries === 1,
);
const fixedTarget = fixedReport.requests.findLast((row) => row.target === 35);
assert.ok(!contains(fixedTarget.buffered, 35));
const fastCached = fixedReport.ready.at(-1);
assert.ok(fastCached.target === 0 && fastCached.actual === 0 && fastCached.cached);
assert.ok(fastCached.ms < 1000); // Local diagnostic: cached frames must not wait out the old 8s seek.
const stall = last(await read('stall-playback.json'));
const waits = stall.mediaEvents.filter((row) => row.type === 'waiting' && row.currentTime < 4.99);
assert.ok(waits.length > 0);
assert.ok(stall.ready.some((row) => row.target === 5 && row.actual === 5 && !row.error));
const duringWait = last(await read('stall-close-on-waiting.json'));
assert.equal(duringWait.mediaEvents.at(-1).type, 'waiting');
released(duringWait);
for (const name of [
  'portrait-all-structures-closed.json',
  'slow-closed.json',
  'timeout-closed.json',
  'quality-closed.json',
  'cache-capacity-closed.json',
  'cached-priority-closed.json',
])
  for (const row of await read(name)) released(row);
const capacity = last(await read('cache-capacity.json'));
assert.equal(capacity.maxCacheEntries, 8);
assert.ok(capacity.maxCacheBytes <= 8 * 1024 * 1024);
assert.ok(capacity.ready.filter((row) => !row.cached && !row.error).length > 8);
const formal = [];
for (const site of ['bilibili', 'youtube', 'x']) {
  const row = await read(site + '-formal.json');
  assert.equal(row.selection.length, 1);
  const selection = row.selection[0];
  assert.equal(selection.rail, true);
  const match = /画面\s+([\d:.]+)/.exec(selection.caption);
  assert.ok(match);
  const actual = match[1].split(':').reduce((value, part) => value * 60 + Number(part), 0);
  assert.ok(Math.abs(actual - Number(selection.b)) < 0.15);
  formal.push({ site, url: row.url, a: Number(selection.a), b: Number(selection.b), actual });
}
for (const row of await read('formal-exit.json')) {
  assert.equal(row.selectionNodes, 0);
  assert.equal(row.diagnosticPresent, false);
}
const result = {
  status: 'ordinary-owned-cases-and-three-formal-samples-passed',
  scope:
    '40-second owned media plus three ordinary formal-extension samples; controlled network delays apply to owned media only; no peak-memory or universal latency guarantee',
  longVideoExcludedByUser: true,
  portraitPixels: [203, 360],
  lowResolutionPortraitPixels: [180, 320],
  pointerTarget: dragFrame.target,
  pointerActual: dragFrame.actual,
  pointerFinalReadyMs: dragFrame.ms,
  pointerNextRafMaximumMs: Math.max(...dragInput.map((row) => row.ms)),
  uncachedSlowSeekMs: slow.ready.find((row) => row.target === 35 && !row.error).ms,
  playbackBufferingEvents: waits.length,
  oldCachedWaitMs: oldCached.ms,
  fixedCachedReadyMs: fastCached.ms,
  cacheMaximumEntries: capacity.maxCacheEntries,
  cacheMaximumBytes: capacity.maxCacheBytes,
  closedCacheAndQueueVerified: true,
  formalOrdinarySamples: formal,
  formalSitesIndependentlyThrottled: false,
  syntheticHighRateKeyboardTimingNotAcceptedAsPhysicalPointerLatency: true,
};
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
