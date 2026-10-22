import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const manifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
const digest = createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest('hex')
  .slice(0, 32);
assert.equal(
  [...digest].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join(''),
  identity.id,
);
assert.equal(manifest.background.type, 'module');
assert.ok(!manifest.externally_connectable, 'Ordinary pages must not receive a native helper API');

const errors = [];
const console = new VirtualConsole();
console.on('jsdomError', (error) => errors.push(error));
const dom = new JSDOM('<!doctype html><html><body><p>Owned DOM test fixture</p></body></html>', {
  url: 'https://example.com/owned-fixture',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: console,
});
const window = dom.window;
const changes = [],
  messages = [];
let prefs = {
  theme: 'system',
  language: 'system',
  petSize: 64,
  petOpacity: 1,
  petHidden: false,
  petPosition: null,
  step: 5,
  fineStep: 1,
};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.chrome = {
  storage: {
    local: { get: async () => ({ preferences: prefs }) },
    onChanged: { addListener: (fn) => changes.push(fn), removeListener() {} },
  },
  runtime: {
    onMessage: { addListener: (fn) => messages.push(fn), removeListener() {} },
    sendMessage: async () => ({ ok: true }),
  },
};
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Built content script did not reach expected DOM state');
}
try {
  // Browser-shaped DOM deliberately has no Node `process` or CommonJS loader.
  // This is a packaging/render smoke check, not a real Edge integration test.
  window.eval(await readFile('dist/extension/content.js', 'utf8'));
  await until(
    () =>
      window.document.getElementById('moment-vault-host')?.shadowRoot?.querySelector('.vault-root')
        ?.hidden === false,
  );
  const root = window.document.getElementById('moment-vault-host').shadowRoot;
  const pet = root.querySelector('button[aria-expanded]');
  pet.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }),
  );
  await until(() => root.querySelectorAll('.menu-grid button').length === 4);
  assert.equal(
    root.querySelector('.menu-grid button').disabled,
    true,
    'Video mode must stay disabled on unsupported pages',
  );
  // Exercise the actual bundled entry wiring. These fake media methods do not
  // verify decoding, top-layer layout, or platform integration.
  dom.reconfigure({ url: 'https://www.youtube.com/watch?v=owned-smoke' });
  const player = window.document.createElement('div');
  player.id = 'movie_player';
  player.innerHTML =
    '<video></video><div class="ytp-progress-bar-container"><div class="ytp-progress-bar"></div></div>';
  window.document.body.append(player);
  for (const element of player.querySelectorAll('*'))
    element.getBoundingClientRect = () => ({
      left: 20,
      top: 30,
      right: 620,
      bottom: 36,
      width: 600,
      height: 6,
    });
  player.getBoundingClientRect = () => ({
    left: 10,
    top: 10,
    right: 650,
    bottom: 370,
    width: 640,
    height: 360,
  });
  const video = player.querySelector('video');
  video.getBoundingClientRect = player.getBoundingClientRect;
  Object.defineProperties(video, {
    duration: { value: 15 },
    videoWidth: { value: 640 },
    videoHeight: { value: 360 },
    readyState: { value: 4 },
    seekable: { value: { length: 1, start: () => 0, end: () => 15 } },
  });
  video.pause = () => {};
  video.play = async () => {};
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.showPopover = function () {
    this.setAttribute('data-owned-popover', 'shown');
  };
  const nativeMatches = window.Element.prototype.matches;
  window.HTMLElement.prototype.matches = function (selector) {
    return selector === ':popover-open'
      ? this.hasAttribute('data-owned-popover')
      : nativeMatches.call(this, selector);
  };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  messages.forEach((fn) => fn({ target: 'content', type: 'toggle-mode' }));
  await until(() =>
    player.querySelector('[data-moment-vault-video]')?.shadowRoot?.querySelector('.video-panel'),
  );
  const videoRoot = player.querySelector('[data-moment-vault-video]').shadowRoot;
  assert.equal(videoRoot.querySelectorAll('.endpoint').length, 2);
  assert.ok(
    videoRoot.querySelector('[data-record-shortcut]'),
    'Selection must expose the actual shortcut requirement rather than capture from a page click',
  );
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await until(() => !player.querySelector('[data-moment-vault-video]'));
  assert.equal(
    player.hasAttribute('data-mv-selection'),
    false,
    'Closing selection must remove scoped native styles',
  );
  messages.forEach((fn) => fn({ target: 'content', type: 'receive-images' }));
  await until(() => !root.querySelector('.intake').hidden);
  assert.equal(
    root.querySelectorAll('.hearts i').length,
    0,
    'Opening intake is not receiving an image',
  );
  prefs = { ...prefs, theme: 'dark', petHidden: true };
  changes.forEach((fn) => fn({ preferences: { newValue: prefs } }));
  await until(() => root.querySelector('.vault-root').hidden);
  assert.equal(root.querySelector('.vault-root').dataset.theme, 'dark');
  assert.deepEqual(errors, []);
  process.stdout.write(
    'PASS built extension: stable identity, startup, selection/Escape cleanup, shortcut-only recording entry, scoped intake and persisted hiding/theme\n',
  );
} finally {
  window.close();
}
