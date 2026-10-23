// Existing Chinese UI acceptance tests run under a Chinese browser. Localization
// tests override this explicitly to cover English and unsupported languages.
Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
