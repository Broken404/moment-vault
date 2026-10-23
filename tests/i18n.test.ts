import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localizedDate,
  localizedNumber,
  resolveLocale,
  translate,
} from '../apps/extension/src/i18n/core';
import { english } from '../apps/extension/src/i18n/catalog';
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UI translation', () => {
  it('follows Chinese browser variants and falls back to English for other languages', () => {
    for (const language of ['zh-CN', 'zh-TW', 'zh', 'ZH_hk'])
      expect(resolveLocale('system', language)).toBe('zh-CN');
    for (const language of ['en-US', 'fr-FR', 'ja', ''])
      expect(resolveLocale('system', language)).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
  });
  it('translates old persisted progress/errors and preserves user parameters verbatim', () => {
    expect(translate('正在保存 2/3 · 41%', 'en')).toBe('Saving 2/3 · 41%');
    expect(translate('附件已收齐，正在完成保存…', 'en')).toBe(
      'All files received. Finishing the save…',
    );
    expect(translate('附件尚未完整保存，请重试。未完成的数据仍保留在本地。', 'en')).toBe(
      'Files have not been saved completely. Please retry. Incomplete data is still stored locally.',
    );
    expect(translate('选择 {0}', 'en', ['草稿箱 {0} <b>素材</b>'])).toBe(
      'Select 草稿箱 {0} <b>素材</b>',
    );
    expect(translate('选择 {0}', 'zh-CN', ['草稿箱'])).toBe('选择 草稿箱');
    expect(translate('custom native detail', 'en')).toBe('custom native detail');
    expect(translate('constructor', 'en')).toBe('constructor');
  });
  it('formats singular counts, dates and small keyboard steps without rounding them away', () => {
    expect(translate('{0} 个附件', 'en', [1])).toBe('1 attachment');
    expect(translate('{0} 个附件', 'en', [3])).toBe('3 attachments');
    expect(localizedNumber(0.001, 'en')).toBe('0.001');
    expect(localizedNumber(1.25, 'en', 1)).toBe('1.3');
    expect(localizedDate('invalid', 'en')).toBe('—');
    const value = '2026-10-24T12:00:00Z';
    expect(localizedDate(value, 'en')).toBe(new Date(value).toLocaleDateString('en'));
    expect(localizedDate(value, 'zh-CN', true)).toBe(new Date(value).toLocaleString('zh-CN'));
  });
  it('keeps all literal UI keys and browser manifest locales covered', () => {
    const files = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(folder, entry.name))
          : /\.tsx$/.test(entry.name)
            ? [join(folder, entry.name)]
            : [],
      );
    const missing: string[] = [];
    for (const file of files('apps/extension/src')) {
      if (file.replaceAll('\\', '/').endsWith('/video/lab.tsx')) continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 't' &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          !Object.hasOwn(english, node.arguments[0].text)
        )
          missing.push(node.arguments[0].text);
        if (
          ts.isJsxText(node) &&
          /\p{Script=Han}/u.test(node.text) &&
          node.text.trim() !== '简体中文'
        )
          missing.push(node.text.trim());
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(missing).toEqual([]);
    const manifest = readFileSync('apps/extension/manifest.json', 'utf8');
    for (const locale of ['en', 'zh_CN']) {
      const messages = JSON.parse(
        readFileSync(`apps/extension/public/_locales/${locale}/messages.json`, 'utf8'),
      );
      for (const match of manifest.matchAll(/__MSG_(\w+)__/g))
        expect(messages[match[1]]?.message).toBeTruthy();
    }
  });
});

describe('language observation', () => {
  it('shares one observer, syncs contexts, ignores stale initial reads and cleans up', async () => {
    vi.resetModules();
    let complete!: (result: object) => void;
    const addListener = vi.fn(),
      removeListener = vi.fn();
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'fr-FR' },
      storage: {
        local: {
          get: () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
        },
        onChanged: { addListener, removeListener },
      },
    });
    const state = await import('../apps/extension/src/i18n/state');
    expect(state.languageSnapshot()).toEqual({ language: 'system', locale: 'en' });
    const cleanup = state.observeLanguage(),
      cleanup2 = state.observeLanguage();
    const listener = addListener.mock.calls[0][0];
    const changed = vi.fn(),
      stop = state.subscribeLanguage(changed);
    listener({ preferences: { newValue: { language: 'zh-CN' } } }, 'sync');
    expect(state.languageSnapshot().locale).toBe('en');
    listener({ preferences: { newValue: { language: 'zh-CN' } } }, 'local');
    complete({ preferences: { language: 'en' } });
    await Promise.resolve();
    expect(state.languageSnapshot()).toEqual({ language: 'zh-CN', locale: 'zh-CN' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(1);
    cleanup();
    expect(removeListener).not.toHaveBeenCalled();
    stop();
    cleanup2();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
  it('persists a loaded override, then follows browser changes only in system mode', async () => {
    vi.resetModules();
    let browserLanguage = 'zh-CN';
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => browserLanguage },
      storage: {
        local: { get: async () => ({ preferences: { language: 'en' } }) },
        onChanged: { addListener() {}, removeListener() {} },
      },
    });
    const state = await import('../apps/extension/src/i18n/state');
    const cleanup = state.observeLanguage();
    await vi.waitFor(() => expect(state.languageSnapshot().language).toBe('en'));
    dispatchEvent(new Event('languagechange'));
    expect(state.languageSnapshot().locale).toBe('en');
    state.setPreferredLanguage('system');
    expect(state.languageSnapshot().locale).toBe('zh-CN');
    browserLanguage = 'ja-JP';
    dispatchEvent(new Event('languagechange'));
    expect(state.languageSnapshot().locale).toBe('en');
    cleanup();
  });
});
