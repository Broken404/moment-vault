import type { TimeDomain } from '@shared/range';

export type Site = 'youtube' | 'bilibili' | 'x';
export interface VideoTarget {
  site: Site;
  key: string;
  video: HTMLVideoElement;
  player: HTMLElement;
}
export interface RailRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function supportedSite(url = location.href): Site | null {
  const page = new URL(url);
  if (
    /(^|\.)youtube\.com$/.test(page.hostname) &&
    page.pathname === '/watch' &&
    page.searchParams.has('v')
  )
    return 'youtube';
  if (/(^|\.)bilibili\.com$/.test(page.hostname) && page.pathname.startsWith('/video/'))
    return 'bilibili';
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(page.hostname)) return 'x';
  return null;
}

function playerFor(video: HTMLVideoElement, site: Site): HTMLElement | null {
  const selectors = {
    youtube: '#movie_player, .html5-video-player',
    bilibili: '.bpx-player-container, #bilibili-player, #playerWrap',
    x: '[data-testid="videoPlayer"], [data-testid="videoComponent"]',
  };
  return video.closest<HTMLElement>(selectors[site]);
}
export function sourceKey(video: HTMLVideoElement, site: Site, url = location.href): string {
  const page = new URL(url);
  if (site === 'youtube') return 'youtube:' + (page.searchParams.get('v') ?? '');
  if (site === 'bilibili')
    return 'bilibili:' + page.pathname + ':' + (page.searchParams.get('p') ?? '1');
  const article = video.closest('article');
  const post =
    article?.querySelector<HTMLAnchorElement>('a[href*="/status/"] time')?.closest('a')?.pathname ??
    (/\/status\/\d+/.exec(page.pathname)?.[0] || page.pathname);
  const owner = article ?? playerFor(video, site);
  const slot = Array.from(owner?.querySelectorAll('video') ?? []).indexOf(video);
  return `x:${post}:${video.poster}:${slot}`;
}
export function videoDomain(video: HTMLVideoElement): TimeDomain {
  if (!Number.isFinite(video.duration) || video.duration <= 0)
    throw new Error('只支持可暂停、可回看的普通视频，暂不支持直播。');
  for (let i = 0; i < video.seekable.length; i++) {
    const start = video.seekable.start(i),
      end = Math.min(video.duration, video.seekable.end(i));
    if (end > start && video.currentTime >= start - 0.1 && video.currentTime <= end + 0.1)
      return { start, end };
  }
  throw new Error('视频尚未提供可回看范围，请先播放片刻后重新连接。');
}
export function findVideoTargets(doc = document, url = location.href): VideoTarget[] {
  const site = supportedSite(url);
  if (!site) return [];
  return Array.from(doc.querySelectorAll('video')).flatMap((video) => {
    const player = playerFor(video, site);
    const rect = video.getBoundingClientRect();
    if (
      !player ||
      rect.width < 100 ||
      rect.height < 70 ||
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= innerWidth ||
      rect.top >= innerHeight ||
      player.matches('.ad-showing, .ytp-live') ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    )
      return [];
    return [{ site, key: sourceKey(video, site, url), video, player }];
  });
}

// Use full native rails only. In X the ARIA slider is a 16px thumb, not the rail.
export function findRail(target: VideoTarget): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  const selectors = {
    youtube: ['.ytp-progress-bar-container .ytp-progress-bar', '.ytp-progress-bar-container'],
    bilibili: ['.bpx-player-progress', '.bpx-player-progress-area'],
    x: [],
  };
  if (target.site === 'x') {
    for (const thumb of target.player.querySelectorAll<HTMLElement>(
      '[role="slider"][aria-valuenow]',
    )) {
      const label = (thumb.getAttribute('aria-label') ?? '').toLowerCase();
      if (
        thumb.getAttribute('aria-orientation') === 'vertical' ||
        !['seek', 'progress', '进度', '進度'].some((part) => label.includes(part))
      )
        continue;
      let parent = thumb.parentElement;
      // Current X uses an unlabeled full-width line; older samples used a group.
      // Walk only the selected progress thumb's nearby ancestors, never CSS hashes.
      for (
        let depth = 0;
        parent && parent !== target.player && depth < 4;
        depth++, parent = parent.parentElement
      )
        candidates.push(parent);
    }
  }
  for (const selector of selectors[target.site]) {
    candidates.push(...target.player.querySelectorAll<HTMLElement>(selector));
  }
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect(),
      player = target.player.getBoundingClientRect();
    if (
      candidate.isConnected &&
      rect.width >= Math.max(64, player.width * 0.3) &&
      rect.height > 0 &&
      rect.height <= 48 &&
      rect.left >= player.left - 2 &&
      rect.right <= player.right + 2 &&
      rect.top >= player.top &&
      rect.bottom <= player.bottom + 3
    )
      return candidate;
  }
  return null;
}
export function railRect(rail: HTMLElement): RailRect {
  const rect = rail.getBoundingClientRect();
  return { left: rect.left, top: rect.top + rect.height / 2 - 2, width: rect.width, height: 4 };
}
export function keepControls(target: VideoTarget): () => void {
  const token = crypto.randomUUID().replaceAll('-', '');
  const previous = target.player.getAttribute('data-mv-selection');
  target.player.setAttribute('data-mv-selection', token);
  const style = document.createElement('style');
  // Scoped, reversible overrides; no synthetic hover and no page-global control styles.
  const selectors =
    target.site === 'youtube'
      ? ['.ytp-chrome-bottom', '.ytp-progress-bar-container']
      : target.site === 'bilibili'
        ? ['.bpx-player-control-wrap', '.bpx-player-control-bottom', '.bpx-player-progress-area']
        : ['[role="group"]'];
  style.textContent =
    selectors.map((selector) => `[data-mv-selection="${token}"] ${selector}`).join(',') +
    '{opacity:1!important;visibility:visible!important;transform:none!important;}';
  document.head.append(style);
  return () => {
    style.remove();
    if (target.player.getAttribute('data-mv-selection') === token) {
      if (previous === null) target.player.removeAttribute('data-mv-selection');
      else target.player.setAttribute('data-mv-selection', previous);
    }
  };
}
