import type { CSSProperties } from 'react';

export function Pet({ size = 64, action = '' }: { size?: number; action?: string }) {
  return <span className={`pet-sprite ${action}`} style={{ '--pet-size': `${size}px` } as CSSProperties} aria-hidden="true">
    <span className="pet-body"><span className="pet-mark" /><span className="pet-eye left" /><span className="pet-eye right" /></span>
  </span>;
}

export function themeName(value: string): string {
  return value === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' : value;
}
