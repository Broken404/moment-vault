import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ownedProbe, ownedProbeEnabled } from '../apps/extension/src/recording/owned-probe';
import {
  findRail,
  findVideoTargets,
  keepControls,
  sourceKey,
  supportedSite,
  videoDomain,
} from '../apps/extension/src/video/sites';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});
const ranges = (values: [number, number][]) => ({
  length: values.length,
  start: (i: number) => values[i][0],
  end: (i: number) => values[i][1],
});
function fixture(html: string) {
  document.body.innerHTML = html;
  for (const node of document.querySelectorAll<HTMLElement>('*'))
    node.getBoundingClientRect = () => rect(20, 20, 600, 360);
  for (const video of document.querySelectorAll('video'))
    Object.defineProperties(video, {
      duration: { value: 200, configurable: true },
      currentTime: { value: 80, configurable: true },
      seekable: { value: ranges([[40, 180]]), configurable: true },
      buffered: { value: ranges([[70, 90]]) },
    });
}
beforeEach(() => {
  document.body.innerHTML = '';
});
describe('owned native timeline DOM fixtures (not platform acceptance)', () => {
  it('keeps the owned recording fixture gated off by default and limits the development entry to its exact loopback route', () => {
    const url = 'http://127.0.0.1:43820/capture.html';
    expect(supportedSite(url)).toBeNull();
    expect(ownedProbeEnabled(url)).toBe(false);
    vi.stubGlobal('__MV_OWNED_CAPTURE_LAB__', true);
    try {
      expect(supportedSite(url)).toBe('owned');
      expect(ownedProbeEnabled(url)).toBe(true);
      expect(ownedProbe(url, '../invalid', 'input')).toBeUndefined();
      for (const other of [
        'http://127.0.0.1:43820/other.html',
        'http://localhost:43820/capture.html',
        'http://127.0.0.1:43821/capture.html',
        'https://example.com/capture.html',
      ]) {
        expect(supportedSite(other)).toBeNull();
        expect(ownedProbeEnabled(other)).toBe(false);
        expect(ownedProbe(other, 'a'.repeat(32), 'input')).toBeUndefined();
      }
      fixture(
        '<div id="moment-vault-owned-player"><video></video><div data-mv-owned-rail></div></div>',
      );
      const target = findVideoTargets(document, url)[0],
        rail = document.querySelector<HTMLElement>('[data-mv-owned-rail]')!;
      rail.getBoundingClientRect = () => rect(30, 350, 580, 6);
      expect(target.site).toBe('owned');
      expect(target.key).toBe('owned:' + url);
      expect(findRail(target)).toBe(rail);
      vi.stubGlobal('__MV_OWNED_CAPTURE_LAB__', false);
      expect(findVideoTargets(document, url)).toHaveLength(0);
      expect(ownedProbe(url, 'a'.repeat(32), 'input')).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    [
      'youtube',
      'https://www.youtube.com/watch?v=owned',
      '<div id="movie_player"><video></video><div class="ytp-progress-bar-container"><div class="ytp-progress-bar"></div></div></div>',
      '.ytp-progress-bar',
    ],
    [
      'bilibili',
      'https://www.bilibili.com/video/BVowned/',
      '<div class="bpx-player-container"><video></video><div class="bpx-player-progress"></div></div>',
      '.bpx-player-progress',
    ],
  ])(
    'connects the full %s rail and reverses only its own control styles',
    (_name, url, html, selector) => {
      fixture(html);
      const target = findVideoTargets(document, url)[0],
        rail = document.querySelector<HTMLElement>(selector)!;
      rail.getBoundingClientRect = () => rect(30, 350, 580, 6);
      expect(findRail(target)).toBe(rail);
      const cleanup = keepControls(target);
      expect(target.player.hasAttribute('data-mv-selection')).toBe(true);
      cleanup();
      expect(target.player.hasAttribute('data-mv-selection')).toBe(false);
    },
  );
  it('uses the X progress group rather than the volume control or the tiny slider thumb', () => {
    fixture(
      '<article><a href="/owner/status/123"><time>now</time></a><div data-testid="videoPlayer"><video poster="owned.jpg"></video><div role="group" id="volume"><div role="slider" aria-label="音量" aria-valuenow="1"></div></div><div role="group" id="progress"><div role="slider" aria-label="进度拖动条" aria-valuenow="80"></div></div></div></article>',
    );
    const target = findVideoTargets(document, 'https://x.com/home')[0];
    document.querySelector<HTMLElement>('#volume')!.getBoundingClientRect = () =>
      rect(30, 350, 100, 20);
    document.querySelector<HTMLElement>('#progress')!.getBoundingClientRect = () =>
      rect(30, 350, 580, 16);
    document.querySelector<HTMLElement>('#progress [role=slider]')!.getBoundingClientRect = () =>
      rect(100, 350, 16, 16);
    expect(findRail(target)?.id).toBe('progress');
    expect(target.key).toContain('/owner/status/123');
  });
  it('retains multiple visible X candidates and distinguishes posts instead of silently choosing the first', () => {
    fixture(
      [123, 456]
        .map(
          (id) =>
            `<article><a href="/owner/status/${id}"><time>now</time></a><div data-testid="videoPlayer"><video></video></div></article>`,
        )
        .join(''),
    );
    const targets = findVideoTargets(document, 'https://x.com/home');
    expect(targets).toHaveLength(2);
    expect(targets[0].key).not.toBe(targets[1].key);
  });
  it('recognizes the observed English X rail with no role=group and keeps the full rail rather than its thumb', () => {
    fixture(
      '<div data-testid="videoComponent"><video></video><div id="touch-rail"><div id="line"><div role="slider" aria-label="Seek slider" aria-valuenow="80" aria-valuemax="200"></div></div></div></div>',
    );
    const line = document.querySelector<HTMLElement>('#line')!;
    line.getBoundingClientRect = () => rect(30, 350, 580, 2);
    document.querySelector<HTMLElement>('#touch-rail')!.getBoundingClientRect = () =>
      rect(30, 341, 580, 20);
    document.querySelector<HTMLElement>('[role=slider]')!.getBoundingClientRect = () =>
      rect(100, 341, 16, 16);
    expect(findRail(findVideoTargets(document, 'https://x.com/owner/status/123')[0])).toBe(line);
  });
  it('invalidates same-element source identity on YouTube navigation and Bili part changes', () => {
    const video = document.createElement('video');
    expect(sourceKey(video, 'youtube', 'https://youtube.com/watch?v=a')).not.toBe(
      sourceKey(video, 'youtube', 'https://youtube.com/watch?v=b'),
    );
    expect(sourceKey(video, 'bilibili', 'https://bilibili.com/video/BV1?p=1')).not.toBe(
      sourceKey(video, 'bilibili', 'https://bilibili.com/video/BV1?p=2'),
    );
  });
  it('keeps seekable and buffered domains separate and rejects live or unavailable ranges', () => {
    fixture('<div id="movie_player"><video></video></div>');
    const video = document.querySelector('video')!;
    expect(videoDomain(video)).toEqual({ start: 40, end: 180 });
    Object.defineProperty(video, 'duration', { value: Infinity, configurable: true });
    expect(() => videoDomain(video)).toThrow('直播');
    Object.defineProperty(video, 'duration', { value: 200 });
    Object.defineProperty(video, 'seekable', { value: ranges([]) });
    expect(() => videoDomain(video)).toThrow('可回看范围');
  });
});
