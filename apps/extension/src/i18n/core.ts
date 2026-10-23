import type { Locale } from '@shared/model';
import { english } from './catalog';

export type UiLocale = 'zh-CN' | 'en';
export type MessageValues = readonly (string | number)[];
export function resolveLocale(preference: Locale, browserLanguage: string): UiLocale {
  if (preference !== 'system') return preference;
  return /^zh(?:-|_|$)/i.test(browserLanguage) ? 'zh-CN' : 'en';
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.keys(english)
  .filter((key) => /\{\d+\}/.test(key))
  .map((key) => {
    const indices: number[] = [];
    const parts = key.split(/(\{\d+\})/).map((part) => {
      const matched = /^\{(\d+)\}$/.exec(part);
      if (!matched) return escape(part);
      indices.push(Number(matched[1]));
      return '([\\s\\S]*?)';
    });
    return { key, pattern: new RegExp('^' + parts.join('') + '$'), indices };
  })
  .sort((a, b) => b.key.replace(/\{\d+\}/g, '').length - a.key.replace(/\{\d+\}/g, '').length);

function fill(template: string, values: MessageValues): string {
  return template.replace(
    /\{(\d+)(?::([^|}]+)\|([^}]+))?\}/g,
    (token, index: string, one?: string, other?: string) => {
      const value = values[Number(index)];
      if (value === undefined) return token;
      return one === undefined ? String(value) : Number(value) === 1 ? one : other!;
    },
  );
}
export function translate(
  input: string,
  locale: UiLocale,
  values?: MessageValues,
  depth = 0,
): string {
  if (locale === 'zh-CN') return values ? fill(input, values) : input;
  const exact = Object.hasOwn(english, input) ? english[input] : undefined;
  if (exact !== undefined) return fill(exact, values ?? []);
  for (const { key, pattern, indices } of templates) {
    const match = pattern.exec(input);
    if (!match) continue;
    const captured: (string | number)[] = [];
    indices.forEach((index, position) => {
      captured[index] = match[position + 1];
    });
    // This one application wrapper contains another application error. File
    // names, notes and other ordinary parameters are deliberately not recursed.
    if (key === '{0}。未完成的数据仍保留在本地。' && depth < 3)
      captured[0] = translate(String(captured[0]), locale, undefined, depth + 1);
    return fill(english[key], captured);
  }
  return input;
}
export function localizedDate(value: string, locale: UiLocale, time = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return time ? date.toLocaleString(locale) : date.toLocaleDateString(locale);
}
export function localizedNumber(value: number, locale: UiLocale, digits?: number): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits ?? 20,
    minimumFractionDigits: digits ?? 0,
  }).format(value);
}
