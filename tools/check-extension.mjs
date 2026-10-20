import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const manifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
assert.equal([...digest].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join(''), identity.id);
assert.equal(manifest.background.type, 'module');
assert.ok(!manifest.externally_connectable, 'Ordinary pages must not receive a native helper API');

const errors = [];
const console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error));
const dom = new JSDOM('<!doctype html><html><body><p>Owned DOM test fixture</p></body></html>', {
  url: 'https://example.com/owned-fixture', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console,
});
const window = dom.window;
const changes = [], messages = [];
let prefs = { theme: 'system', language: 'system', petSize: 64, petOpacity: 1, petHidden: false, petPosition: null, step: 5, fineStep: 1 };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.chrome = {
  storage: { local: { get: async () => ({ preferences: prefs }) }, onChanged: { addListener: fn => changes.push(fn), removeListener() {} } },
  runtime: { onMessage: { addListener: fn => messages.push(fn), removeListener() {} }, sendMessage: async () => ({ ok: true }) },
};
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Built content script did not reach expected DOM state');
}
try {
  // Browser-shaped DOM deliberately has no Node `process` or CommonJS loader.
  // This is a packaging/render smoke check, not a real Edge integration test.
  window.eval(await readFile('dist/extension/content.js', 'utf8'));
  await until(() => window.document.getElementById('moment-vault-host')?.shadowRoot?.querySelector('.vault-root')?.hidden === false);
  const root = window.document.getElementById('moment-vault-host').shadowRoot;
  const pet = root.querySelector('button[aria-expanded]');
  pet.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
  await until(() => root.querySelectorAll('.menu-grid button').length === 4);
  assert.equal(root.querySelector('.menu-grid button').disabled, true, 'Unimplemented video capture must stay disabled');
  messages.forEach(fn => fn({ target: 'content', type: 'receive-images' }));
  await until(() => !root.querySelector('.intake').hidden);
  assert.equal(root.querySelectorAll('.hearts i').length, 0, 'Opening intake is not receiving an image');
  prefs = { ...prefs, theme: 'dark', petHidden: true };
  changes.forEach(fn => fn({ preferences: { newValue: prefs } }));
  await until(() => root.querySelector('.vault-root').hidden);
  assert.equal(root.querySelector('.vault-root').dataset.theme, 'dark');
  assert.deepEqual(errors, []);
  process.stdout.write('PASS built extension: stable identity, browser-shaped startup, four actions, scoped intake and persisted hiding/theme\n');
} finally { window.close(); }
