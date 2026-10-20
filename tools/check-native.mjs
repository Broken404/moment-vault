import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve('.local-data', `native-smoke-${randomUUID()}`);
const dataHome = path.join(root, 'state');
const draftRoot = path.join(os.tmpdir(), `moment-vault-smoke-${randomUUID()}`);
const libraryRoot = path.join(root, 'library');
await mkdir(draftRoot, { recursive: true });
await mkdir(libraryRoot, { recursive: true });
const selfContained = path.resolve('dist/host/MomentVault.Host.exe');
const executable = existsSync(selfContained)
  ? selfContained
  : path.resolve('.tools/dotnet/dotnet.exe');
const prefix = existsSync(selfContained)
  ? []
  : [path.resolve('native/MomentVault.Host/bin/Release/net10.0-windows/MomentVault.Host.dll')];
const child = spawn(executable, [...prefix, '--stdio-test', '--data-home', dataHome], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let buffer = Buffer.alloc(0),
  stderr = '';
const waiting = new Map();
child.stderr.on('data', (bytes) => {
  stderr += bytes.toString();
});
child.on('error', (error) => {
  for (const resolve of waiting.values()) resolve({ ok: false, error: { message: error.message } });
});
child.stdout.on('data', (bytes) => {
  buffer = Buffer.concat([buffer, bytes]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > 900_000) throw new Error('Native protocol emitted invalid length');
    if (buffer.length < length + 4) return;
    const response = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    waiting.get(response.id)?.(response);
  }
});
async function call(op, payload = {}) {
  const id = randomUUID();
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`Native request timed out: ${op} ${stderr}`));
    }, 15000);
    waiting.set(id, (response) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(response);
    });
  });
  const data = Buffer.from(JSON.stringify({ protocol: 1, id, op, payload }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  child.stdin.write(Buffer.concat([header, data]));
  const result = await response;
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
try {
  assert.equal((await call('ping')).protocol, 1);
  await call('config.set', { draftRoot, libraryRoot });
  assert.equal((await call('ping')).configured, true);
  const uploadId = randomUUID().replaceAll('-', ''),
    attachmentId = randomUUID().replaceAll('-', '');
  const files = [
    { id: attachmentId, extension: 'png', kind: 'image', mime: 'image/png', source: '', note: '' },
  ];
  await call('items.begin', { uploadId, name: '协议真实写入', files });
  await call('items.begin', { uploadId, name: '协议真实写入', files });
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=',
    'base64',
  );
  await call('items.append', {
    uploadId,
    attachmentId,
    sequence: 0,
    base64: bytes.toString('base64'),
  });
  await call('items.finishFile', { uploadId, attachmentId, chunks: 1, bytes: bytes.length });
  const item = await call('items.commit', { uploadId });
  const actual = await readFile(
    path.join(draftRoot, item.folderName, item.attachments[0].fileName),
  );
  assert.deepEqual(actual, bytes);
  await call('items.promote', { ids: [item.id] });
  assert.equal((await call('items.list', { bucket: 'library' })).items.length, 1);
  assert.equal((await call('items.list', { bucket: 'draft' })).items.length, 0);
  const crossVolume =
    path.parse(draftRoot).root.toLowerCase() !== path.parse(libraryRoot).root.toLowerCase();
  if (process.argv.includes('--require-cross-volume'))
    assert.equal(crossVolume, true, 'This check needs two actual volumes');
  console.log(
    `PASS actual native process: framed ping/config, idempotent begin, media write/readback and promotion; crossVolume=${crossVolume}`,
  );
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const allowed = path.resolve('.local-data');
  if (!root.startsWith(allowed + path.sep) || !path.basename(root).startsWith('native-smoke-'))
    throw new Error('Unsafe smoke-test cleanup path');
  await rm(root, { recursive: true, force: true });
  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    !draftRoot.startsWith(temporaryRoot + path.sep) ||
    !path.basename(draftRoot).startsWith('moment-vault-smoke-')
  )
    throw new Error('Unsafe temporary cleanup path');
  await rm(draftRoot, { recursive: true, force: true });
}
