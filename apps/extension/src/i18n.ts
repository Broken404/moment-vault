import { useEffect, useSyncExternalStore } from 'react';
import { languageSnapshot, observeLanguage, subscribeLanguage } from './i18n/state';
import { localizedDate, localizedNumber, translate, type MessageValues } from './i18n/core';
export function t(text: string, values?: MessageValues) {
  return translate(text, languageSnapshot().locale, values);
}
export function dateText(value: string, time = false) {
  return localizedDate(value, languageSnapshot().locale, time);
}
export function numberText(value: number, digits?: number) {
  return localizedNumber(value, languageSnapshot().locale, digits);
}
export function useI18n() {
  const snapshot = useSyncExternalStore(subscribeLanguage, languageSnapshot);
  useEffect(observeLanguage, []);
  return { ...snapshot, t };
}
