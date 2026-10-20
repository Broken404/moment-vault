export type Endpoint = 'a' | 'b';
export interface Selection {
  a: number;
  b: number;
}
export interface TimeDomain {
  start: number;
  end: number;
}

export function initialSelection(position: number, domain: TimeDomain): Selection {
  if (
    !Number.isFinite(position) ||
    !Number.isFinite(domain.start) ||
    !Number.isFinite(domain.end) ||
    domain.end <= domain.start
  ) {
    throw new Error('视频暂无有效的可回看范围');
  }
  const at = Math.max(domain.start, Math.min(domain.end, position));
  return at >= domain.end
    ? { a: Math.max(domain.start, domain.end - 5), b: domain.end }
    : { a: at, b: Math.min(domain.end, at + 5) };
}

export function moveEndpoint(
  selection: Selection,
  endpoint: Endpoint,
  time: number,
  domain: TimeDomain,
): Selection {
  if (!Number.isFinite(time) || time < domain.start || time > domain.end)
    throw new Error('时间超出可回看范围');
  if (endpoint === 'a' ? time >= selection.b : time <= selection.a)
    throw new Error('起点必须早于终点');
  return { ...selection, [endpoint]: time };
}

export function timeAtPointer(x: number, left: number, width: number, domain: TimeDomain): number {
  if (
    !(width > 0) ||
    ![x, left, width, domain.start, domain.end].every(Number.isFinite) ||
    domain.end <= domain.start
  ) {
    throw new Error('原进度条暂不可定位');
  }
  return domain.start + Math.max(0, Math.min(1, (x - left) / width)) * (domain.end - domain.start);
}

export function parseTime(value: string): number {
  const parts = value.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d{1,3})?$/.test(p)))
    throw new Error('请输入秒数或 时:分:秒.毫秒');
  if (parts.length > 1 && parts.slice(1).some((p) => Number(p) >= 60))
    throw new Error('分、秒必须小于 60');
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export function formatTime(time: number): string {
  const ms = Math.max(0, Math.round(time * 1000));
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  return `${h ? `${h}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
