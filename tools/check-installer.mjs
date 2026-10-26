import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32');
const exec = promisify(execFile);
const root = path.resolve('.');
const scratch = path.join(root, '.local-data', `installer-lifecycle-${randomUUID()}`);
const installRoot = path.join(scratch, '程序 安装');
const stage = path.join(scratch, 'payload');
const hostName = 'com.momentvault.host.installcheck';
const registryPaths = ['Microsoft/Edge', 'Google/Chrome'].map((browser) =>
  `Software/${browser}/NativeMessagingHosts/${hostName}`.replaceAll('/', '\\'),
);
const uninstallKey =
  'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentVault-InstallCheck_is1';
const compiler = path.resolve(process.env.MOMENT_VAULT_ISCC ?? '.tools/inno/ISCC.exe');
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
const origin = `chrome-extension://${identity.id}/`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = [];
async function powershell(script, values = {}) {
  const { stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = 'Stop'; $v = $env:MV_INSTALL_CHECK_VALUES | ConvertFrom-Json; ${script}`,
    ],
    {
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, MV_INSTALL_CHECK_VALUES: JSON.stringify(values) },
    },
  );
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function registryValues(paths) {
  return await powershell(
    `$result = foreach ($p in $v.paths) {
    $key = Get-Item -LiteralPath ('HKCU:\\' + $p) -ErrorAction SilentlyContinue
    if ($null -eq $key) { [pscustomobject]@{ path=$p; value=$null; kind=$null } }
    else { [pscustomobject]@{ path=$p; value=$key.GetValue(''); kind=$key.GetValueKind('').ToString() } }
  }; ConvertTo-Json -InputObject @($result) -Compress`,
    { paths },
  );
}
async function protectedState() {
  const realPaths = registryPaths.map((item) => item.replace('.installcheck', ''));
  const configFile = path.join(process.env.LOCALAPPDATA, 'MomentVault/config.json');
  return {
    registration: await registryValues(realPaths),
    config: await readFile(configFile).then(hash, () => null),
  };
}
async function run(executable, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Installer check timed out'));
    }, 180_000);
    child.stdout.on('data', (bytes) => {
      output += bytes;
    });
    child.stderr.on('data', (bytes) => {
      output += bytes;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
async function tree(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      Object.assign(files, await tree(path.join(directory, entry.name), prefix + entry.name + '/'));
    else files[prefix + entry.name] = hash(await readFile(path.join(directory, entry.name)));
  }
  return files;
}
const dataHome = path.join(scratch, '保留的配置');
const draftRoot = path.join(scratch, '草稿');
const libraryRoot = path.join(scratch, '资产库');
let active;
function host(stateDirectory = dataHome) {
  const child = spawn(
    path.join(installRoot, 'host/MomentVault.Host.exe'),
    [origin, '--data-home', stateDirectory],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let buffer = Buffer.alloc(0),
    stderr = '';
  const pending = new Map();
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  child.stdout.on('data', (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      assert.ok(length <= 900_000);
      if (buffer.length < length + 4) break;
      const message = JSON.parse(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
      pending.get(message.id)?.(message);
    }
  });
  child.on('error', (error) => {
    for (const resolve of pending.values()) resolve({ ok: false, error });
  });
  return {
    child,
    async call(op, payload = {}) {
      const id = randomUUID();
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${op} timeout ${stderr}`));
        }, 15_000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(value);
        });
      });
      const bytes = Buffer.from(JSON.stringify({ protocol: 1, id, op, payload }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(bytes.length);
      child.stdin.write(Buffer.concat([header, bytes]));
      const value = await response;
      assert.equal(value.ok, true, JSON.stringify(value));
      return value.result;
    },
    async close() {
      if (child.exitCode !== null) return;
      const stopped = new Promise((resolve) => child.once('close', resolve));
      child.stdin.end();
      await stopped;
    },
  };
}

const before = await protectedState();
assert.ok(
  (await registryValues(registryPaths)).every((entry) => entry.value === null),
  'An isolated lifecycle check is already installed',
);
await mkdir(scratch, { recursive: true });
await cp('dist/installer-payload', stage, { recursive: true });
const baseReceipt = JSON.parse(await readFile(path.join(stage, 'package-receipt.json'), 'utf8'));
const installers = [];
const fixturesIndex = process.argv.indexOf('--fixtures-directory');
const fixturesDirectory = fixturesIndex < 0 ? null : path.resolve(process.argv[fixturesIndex + 1]);
if (fixturesDirectory)
  assert.ok(
    fixturesDirectory.startsWith(path.join(root, '.local-data') + path.sep),
    'Reused private fixtures must stay inside .local-data',
  );
for (const version of ['0.0.9', '0.1.0']) {
  if (fixturesDirectory) {
    const fixture = path.join(fixturesDirectory, `MomentVault-${version}-win-x64-installcheck.exe`);
    assert.ok((await stat(fixture)).isFile());
    installers.push(fixture);
    continue;
  }
  await writeFile(
    path.join(stage, 'package-receipt.json'),
    JSON.stringify(
      {
        ...baseReceipt,
        version,
        scope: 'Synthetic predecessor/current lifecycle fixtures; not released versions.',
      },
      null,
      2,
    ) + '\n',
  );
  const result = await run(compiler, [
    '/Q',
    `/DPayloadDir=${stage}`,
    `/DOutputDir=${scratch}`,
    `/DAppVersion=${version}`,
    `/DExtensionId=${identity.id}`,
    '/DOutputSuffix=-installcheck',
    '/DInstallCheck=1',
    path.join(root, 'packaging/windows/moment-vault.iss'),
  ]);
  assert.equal(result.code, 0, result.output);
  installers.push(path.join(scratch, `MomentVault-${version}-win-x64-installcheck.exe`));
}
const flags = [
  '/CURRENTUSER',
  '/VERYSILENT',
  '/SUPPRESSMSGBOXES',
  '/SP-',
  '/NORESTART',
  '/RESTARTEXITCODE=3010',
];
const setup = (file, label, args = []) =>
  run(file, [...flags, `/LOG=${path.join(scratch, label + '.log')}`, ...args]);
try {
  assert.equal((await setup(installers[0], 'first', [`/DIR=${installRoot}`])).code, 0);
  const expectedManifest = path.join(installRoot, 'host', hostName + '.json');
  for (const entry of await registryValues(registryPaths)) {
    assert.equal(entry.value, expectedManifest);
    assert.equal(entry.kind, 'String');
  }
  const manifest = JSON.parse(await readFile(expectedManifest, 'utf8'));
  assert.equal(manifest.name, hostName);
  assert.equal(manifest.path, path.join(installRoot, 'host/MomentVault.Host.exe'));
  assert.deepEqual(manifest.allowed_origins, [origin]);
  assert.equal(manifest.type, 'stdio');
  for (const file of baseReceipt.files) {
    if (file.file === 'host/com.momentvault.host.json') continue;
    assert.equal(hash(await readFile(path.join(installRoot, file.file))), file.sha256, file.file);
  }
  active = host();
  assert.equal((await active.call('ping')).recordingToolsAvailable, true);
  checks.push(
    'fresh current-user install, Unicode path, both registrations, real origin-framed ping and bundled media',
  );
  for (const directory of [draftRoot, libraryRoot]) await mkdir(directory, { recursive: true });
  await active.call('config.set', { draftRoot, libraryRoot });
  const uploadId = randomUUID().replaceAll('-', '');
  const attachmentId = randomUUID().replaceAll('-', '');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmf0AAAAASUVORK5CYII=',
    'base64',
  );
  await active.call('items.begin', {
    uploadId,
    name: '安装升级保留验收',
    note: '保留备注',
    files: [{ id: attachmentId, extension: 'png', kind: 'image', mime: 'image/png' }],
  });
  await active.call('items.append', {
    uploadId,
    attachmentId,
    sequence: 0,
    base64: bytes.toString('base64'),
  });
  await active.call('items.finishFile', {
    uploadId,
    attachmentId,
    chunks: 1,
    bytes: bytes.length,
    sha256: hash(bytes),
  });
  const item = await active.call('items.commit', { uploadId });
  const libraryUploadId = randomUUID().replaceAll('-', '');
  const libraryAttachmentId = randomUUID().replaceAll('-', '');
  await active.call('items.begin', {
    uploadId: libraryUploadId,
    name: '安装保留的已入库素材',
    files: [{ id: libraryAttachmentId, extension: 'png', kind: 'image', mime: 'image/png' }],
  });
  await active.call('items.append', {
    uploadId: libraryUploadId,
    attachmentId: libraryAttachmentId,
    sequence: 0,
    base64: bytes.toString('base64'),
  });
  await active.call('items.finishFile', {
    uploadId: libraryUploadId,
    attachmentId: libraryAttachmentId,
    chunks: 1,
    bytes: bytes.length,
  });
  await active.call('items.commit', { uploadId: libraryUploadId });
  await active.call('items.promote', { ids: [libraryUploadId] });
  const pendingId = randomUUID().replaceAll('-', '');
  const pendingAttachmentId = randomUUID().replaceAll('-', '');
  await active.call('items.begin', {
    uploadId: pendingId,
    name: '升级保留的未完成保存',
    files: [
      {
        id: pendingAttachmentId,
        extension: 'png',
        kind: 'image',
        mime: 'image/png',
        bytes: 1000,
      },
    ],
  });
  await active.call('items.append', {
    uploadId: pendingId,
    attachmentId: pendingAttachmentId,
    sequence: 0,
    base64: bytes.subarray(0, 16).toString('base64'),
  });
  const unowned = path.join(installRoot, '用户放入的文件.txt');
  await writeFile(unowned, 'keep this unowned file\n');
  const dataSnapshot = {
    state: await tree(dataHome),
    draft: await tree(draftRoot),
    library: await tree(libraryRoot),
  };
  const busy = await setup(installers[1], 'busy-upgrade');
  assert.notEqual(busy.code, 0, 'Upgrade must refuse an active helper');
  assert.equal(
    JSON.parse(await readFile(path.join(installRoot, 'package-receipt.json'), 'utf8')).version,
    '0.0.9',
  );
  assert.equal(
    (await active.call('ping')).configured,
    true,
    'Busy upgrade must not kill the helper',
  );
  const busyUninstall = await run(path.join(installRoot, 'unins000.exe'), [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
  ]);
  assert.ok((await stat(path.join(installRoot, 'host/MomentVault.Host.exe'))).isFile());
  assert.equal((await active.call('ping')).configured, true);
  checks.push(
    `busy upgrade refused (${busy.code}); busy uninstall left active helper running (${busyUninstall.code})`,
  );
  await active.close();
  active = null;
  assert.equal((await setup(installers[1], 'upgrade')).code, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(installRoot, 'package-receipt.json'), 'utf8')).version,
    '0.1.0',
  );
  assert.deepEqual(
    { state: await tree(dataHome), draft: await tree(draftRoot), library: await tree(libraryRoot) },
    dataSnapshot,
  );
  active = host();
  assert.deepEqual(await active.call('config.get'), { draftRoot, libraryRoot });
  assert.equal((await active.call('items.list', { bucket: 'draft' })).items[0].id, item.id);
  assert.equal(
    (await active.call('items.list', { bucket: 'library' })).items[0].id,
    libraryUploadId,
  );
  assert.equal((await active.call('uploads.list', { draftRoot })).items[0].id, pendingId);
  const read = await active.call('items.readFile', {
    bucket: 'draft',
    id: item.id,
    attachmentId,
    offset: 0,
  });
  assert.equal(hash(Buffer.from(read.base64, 'base64')), hash(bytes));
  await active.close();
  active = null;
  checks.push(
    'synthetic older-to-current upgrade reused path; metadata, media bytes, configuration and pending save preserved after process restart',
  );
  const backup = path.join(scratch, '备份还原');
  const backupDraft = path.join(backup, '草稿');
  const backupLibrary = path.join(backup, '资产库');
  await cp(draftRoot, backupDraft, { recursive: true });
  await cp(libraryRoot, backupLibrary, { recursive: true });
  active = host(path.join(backup, '新配置'));
  await active.call('config.set', { draftRoot: backupDraft, libraryRoot: backupLibrary });
  assert.equal((await active.call('items.list', { bucket: 'draft' })).items[0].id, item.id);
  assert.equal(
    (await active.call('items.list', { bucket: 'library' })).items[0].id,
    libraryUploadId,
  );
  assert.equal(
    (await active.call('uploads.list', { draftRoot: backupDraft })).items[0].id,
    pendingId,
  );
  const backupRead = await active.call('items.readFile', {
    bucket: 'draft',
    id: item.id,
    attachmentId,
    offset: 0,
  });
  assert.equal(hash(Buffer.from(backupRead.base64, 'base64')), hash(bytes));
  await active.close();
  active = null;
  checks.push(
    'copied complete backup reconfigured to new roots; draft, library, original media and pending save readable',
  );
  assert.equal((await setup(installers[1], 'reinstall')).code, 0);
  assert.deepEqual(
    { state: await tree(dataHome), draft: await tree(draftRoot), library: await tree(libraryRoot) },
    dataSnapshot,
  );
  checks.push('same-version repair install preserves all data');
  // Simulate a newer developer registration for just one browser.
  const newerManifest = path.join(scratch, 'other-helper.json');
  await powershell(`Set-Item -LiteralPath ('HKCU:\\' + $v.path) -Value $v.manifest`, {
    path: registryPaths[0],
    manifest: newerManifest,
  });
  const removed = await run(path.join(installRoot, 'unins000.exe'), [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/LOG=${path.join(scratch, 'uninstall.log')}`,
  ]);
  assert.equal(removed.code, 0, removed.output);
  assert.equal(
    await stat(path.join(installRoot, 'host/MomentVault.Host.exe')).then(
      () => true,
      () => false,
    ),
    false,
  );
  const registrations = await registryValues(registryPaths);
  assert.equal(
    registrations[0].value,
    newerManifest,
    'Uninstall must preserve another registration',
  );
  assert.equal(registrations[1].value, null, 'Owned registration must be removed');
  assert.equal(await readFile(unowned, 'utf8'), 'keep this unowned file\n');
  assert.deepEqual(
    { state: await tree(dataHome), draft: await tree(draftRoot), library: await tree(libraryRoot) },
    dataSnapshot,
  );
  const stillInstalled = await powershell(
    `ConvertTo-Json (Test-Path -LiteralPath ('HKCU:\\' + $v.path))`,
    { path: uninstallKey },
  );
  assert.equal(stillInstalled, false);
  checks.push(
    'uninstall removes managed files and owned registration; keeps newer registration, unowned file, configuration, materials and pending save',
  );
  // Remove only the known test registration; no production key is modified.
  await powershell(`Remove-Item -LiteralPath ('HKCU:\\' + $v.path)`, { path: registryPaths[0] });
  assert.deepEqual(
    await protectedState(),
    before,
    'Production registration and config must stay unchanged',
  );
  const report = {
    status: 'isolated-installer-lifecycle-passed',
    checks,
    versions: ['0.0.9 synthetic', '0.1.0 current payload'],
    boundaries: [
      'Separate QA AppId/host registration, full payload and same installer code.',
      'Real helper process restart; not a Windows reboot or live Edge connection.',
      'Existing production registration and configuration unchanged.',
    ],
    installerHashes: await Promise.all(
      installers.map(async (file) => ({
        file: path.basename(file),
        sha256: hash(await readFile(file)),
      })),
    ),
  };
  await writeFile(path.join(scratch, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `PASS: ${checks.length} installer lifecycle groups. Evidence: ${path.join(scratch, 'result.json')}`,
  );
} finally {
  await active?.close();
  assert.deepEqual(await protectedState(), before, 'Production state changed unexpectedly');
}
