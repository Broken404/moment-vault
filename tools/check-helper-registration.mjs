import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32', 'Run the registration check on Windows');
const identity = JSON.parse(await readFile('config/extension-identity.json', 'utf8'));
const directoryIndex = process.argv.indexOf('--host-directory');
const hostDirectory = path.resolve(
  directoryIndex >= 0 ? process.argv[directoryIndex + 1] : 'dist/host',
);
assert.ok(
  hostDirectory.startsWith(path.resolve('.') + path.sep),
  'Development helper must remain inside this repository',
);
const expectedManifest = path.join(hostDirectory, 'com.momentvault.host.json');
const registryProbe = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$entries = foreach ($registryPath in @(
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.momentvault.host',
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.momentvault.host'
)) {
  if (!(Test-Path -LiteralPath $registryPath)) { throw "Missing helper registration: $registryPath" }
  $key = Get-Item -LiteralPath $registryPath
  [pscustomobject]@{ path = $registryPath; kind = $key.GetValueKind('').ToString(); manifest = $key.GetValue('') }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($entries) -Compress))
`;
const { stdout } = await promisify(execFile)(
  'powershell.exe',
  ['-NoProfile', '-Command', registryProbe],
  {
    windowsHide: true,
    timeout: 15_000,
  },
);
const entries = JSON.parse(stdout);
assert.equal(entries.length, 2);
for (const entry of entries) {
  assert.equal(entry.kind, 'String', `${entry.path} must use REG_SZ`);
  assert.equal(path.resolve(entry.manifest).toLowerCase(), expectedManifest.toLowerCase());
}
const manifest = JSON.parse(await readFile(expectedManifest, 'utf8'));
const origin = `chrome-extension://${identity.id}/`;
assert.equal(manifest.name, 'com.momentvault.host');
assert.equal(manifest.type, 'stdio');
assert.deepEqual(manifest.allowed_origins, [origin]);
assert.equal(path.resolve(manifest.path), path.join(hostDirectory, 'MomentVault.Host.exe'));
assert.ok((await stat(manifest.path)).isFile());

const scratchRoot = path.resolve('.local-data');
const dataHome = path.join(scratchRoot, `registration-check-${randomUUID()}`);
await mkdir(dataHome, { recursive: true });
const child = spawn(manifest.path, [origin, '--parent-window=0', '--data-home', dataHome], {
  cwd: path.dirname(manifest.path),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
try {
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Registered helper ping timed out')), 10_000);
    let bytes = Buffer.alloc(0);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`Registered helper exited before ping: ${code}`)));
    child.stdin.on('error', fail);
    child.stdout.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32LE(0);
      if (length > 900_000) return fail(new Error('Invalid native response length'));
      if (bytes.length < length + 4) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(bytes.subarray(4, length + 4).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    const message = Buffer.from(
      JSON.stringify({ protocol: 1, id: 'registration-ping', op: 'ping', payload: {} }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(message.length);
    child.stdin.end(Buffer.concat([header, message]));
  });
  assert.equal(response.id, 'registration-ping');
  assert.equal(response.ok, true);
  assert.equal(response.result.protocol, 1);
  console.log(
    'PASS: Edge and compatibility registrations resolve to the matching helper; real origin-framed ping passed.',
  );
} finally {
  if (child.exitCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill();
    await closed;
  }
  assert.equal(
    path.dirname(dataHome),
    scratchRoot,
    'Cleanup must stay in the owned scratch directory',
  );
  await rm(dataHome, { recursive: true, force: true });
}
