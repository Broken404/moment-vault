import type { Locale } from '@shared/model';
import { validatePreferences } from '@shared/model';
import { resolveLocale, type UiLocale } from './core';

function browserLanguage() {
  return (
    (typeof chrome !== 'undefined' ? chrome.i18n?.getUILanguage?.() : undefined) ??
    (typeof navigator !== 'undefined' ? navigator.language : 'en')
  );
}
let snapshot: { language: Locale; locale: UiLocale } = {
  language: 'system',
  locale: resolveLocale('system', browserLanguage()),
};
const listeners = new Set<() => void>();
let observers = 0,
  version = 0;
export function languageSnapshot() {
  return snapshot;
}
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setPreferredLanguage(language: Locale) {
  version++;
  const locale = resolveLocale(language, browserLanguage());
  if (snapshot.language === language && snapshot.locale === locale) return;
  snapshot = { language, locale };
  listeners.forEach((listener) => listener());
}
const changed = (changes: Record<string, chrome.storage.StorageChange>, area?: string) => {
  if ((area && area !== 'local') || !changes.preferences) return;
  setPreferredLanguage(validatePreferences(changes.preferences.newValue).language);
};
const browserChanged = () => setPreferredLanguage(snapshot.language);
export function observeLanguage() {
  if (observers++ === 0) {
    const loadedVersion = ++version;
    chrome.storage.onChanged.addListener(changed);
    if (typeof addEventListener === 'function') addEventListener('languagechange', browserChanged);
    void chrome.storage.local
      .get('preferences')
      .then((stored) => {
        if (version === loadedVersion && observers > 0)
          setPreferredLanguage(validatePreferences(stored.preferences).language);
      })
      .catch(() => {});
  }
  return () => {
    if (--observers !== 0) return;
    version++;
    chrome.storage.onChanged.removeListener(changed);
    if (typeof removeEventListener === 'function')
      removeEventListener('languagechange', browserChanged);
  };
}
