import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.local-data', `merge-smoke-${randomUUID()}`);
const dataHome = path.join(root, 'state');
const draftRoot = path.join(root, '草稿箱');
const libraryRoot = path.join(root, '资产库');
const executable = path.resolve(
  process.env.MOMENT_VAULT_TEST_HOST ?? 'dist/host/MomentVault.Host.exe',
);
const ffmpeg = path.resolve(
  process.env.MOMENT_VAULT_TEST_FFMPEG ?? path.join(path.dirname(executable), 'media/ffmpeg.exe'),
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(draftRoot, { recursive: true });
await mkdir(libraryRoot, { recursive: true });
let child;

function connect() {
  child = spawn(executable, ['--stdio-test', '--data-home', dataHome], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  child.stdout.on('data', (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0);
      assert.ok(size < 900_000);
      const response = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
      buffer = buffer.subarray(size + 4);
      pending.get(response.id)?.(response);
    }
  });
  child.stderr.on('data', (bytes) => process.stderr.write(bytes));
  return async (op, payload = {}) => {
    const id = randomUUID();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${op}`));
      }, 15_000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(result);
      });
    });
    const bytes = Buffer.from(JSON.stringify({ protocol: 1, id, op, payload }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(bytes.length);
    child.stdin.write(Buffer.concat([prefix, bytes]));
    const response = await reply;
    assert.equal(response.ok, true, JSON.stringify(response.error));
    return response.result;
  };
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  const ended = new Promise((resolve) => current.once('exit', resolve));
  current.stdin.end();
  const timer = setTimeout(() => current.kill(), 3000);
  await ended;
  clearTimeout(timer);
}

try {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=',
    'base64',
  );
  const video = path.join(root, 'owned.mp4');
  execFileSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '0.6',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-y',
      video,
    ],
    { windowsHide: true },
  );
  const mp4 = await readFile(video);
  let call = connect();
  await call('config.set', { draftRoot, libraryRoot });
  async function upload(name, entries) {
    const uploadId = randomUUID().replaceAll('-', '');
    const files = entries.map(({ kind }, i) => ({
      id: randomUUID().replaceAll('-', ''),
      extension: kind === 'image' ? 'png' : 'mp4',
      kind,
      mime: kind === 'image' ? 'image/png' : 'video/mp4',
      source: `https://example.com/owned/${name}/${i}`,
      note: `${name} 附件说明 ${i}`,
    }));
    await call('items.begin', { uploadId, name, note: `${name} 共同备注`, files });
    for (let i = 0; i < files.length; i++) {
      const bytes = entries[i].bytes;
      let sequence = 0;
      for (let offset = 0; offset < bytes.length; offset += 192 * 1024)
        await call('items.append', {
          uploadId,
          attachmentId: files[i].id,
          sequence: sequence++,
          base64: bytes.subarray(offset, offset + 192 * 1024).toString('base64'),
        });
      await call('items.finishFile', {
        uploadId,
        attachmentId: files[i].id,
        chunks: sequence,
        bytes: bytes.length,
      });
    }
    return call('items.commit', { uploadId });
  }
  await upload('自制图片', [{ kind: 'image', bytes: png }]);
  await upload('自制混合组', [
    { kind: 'image', bytes: png },
    { kind: 'video', bytes: mp4 },
  ]);
  const before = (await call('items.list', { bucket: 'draft' })).items;
  const request = {
    operationId: randomUUID().replaceAll('-', ''),
    draftRoot,
    selection: before.map(({ id, revision }) => ({ id, revision })),
  };
  const expected = before.flatMap((item) => item.attachments);
  // Discard the first successful result, restart the actual native process,
  // then replay the identical request as a lost acknowledgement would do.
  await call('items.merge', request);
  await stop();
  call = connect();
  const result = await call('items.merge', request);
  assert.equal(result.status, 'merged');
  const after = await call('items.list', { bucket: 'draft' });
  assert.equal(after.items.length, 1);
  assert.equal((await call('items.list', { bucket: 'library' })).items.length, 0);
  const item = result.item;
  assert.equal(item.id, request.operationId);
  assert.equal(item.attachments.length, 3);
  assert.deepEqual(
    item.attachments.map((a) => a.id),
    expected.map((a) => a.id),
  );
  assert.equal(new Set(item.attachments.map((a) => a.fileName.toLowerCase())).size, 3);
  for (let i = 0; i < expected.length; i++) {
    const file = item.attachments[i],
      original = expected[i];
    for (const key of ['id', 'source', 'note', 'collectedAt', 'mime', 'kind', 'bytes', 'sha256'])
      assert.equal(file[key], original[key]);
    const bytes = await readFile(path.join(draftRoot, item.folderName, file.fileName));
    assert.equal(hash(bytes), original.sha256);
    const read = await call('items.readFile', {
      bucket: 'draft',
      id: item.id,
      attachmentId: file.id,
      offset: 0,
    });
    assert.deepEqual(Buffer.from(read.base64, 'base64'), bytes);
    if (file.kind === 'video')
      execFileSync(
        ffmpeg,
        [
          '-v',
          'error',
          '-i',
          path.join(draftRoot, item.folderName, file.fileName),
          '-f',
          'null',
          '-',
        ],
        { windowsHide: true },
      );
  }
  const description = await readFile(path.join(draftRoot, item.folderName, '描述.md'), 'utf8');
  for (const source of before) {
    assert.ok(description.includes(source.id));
    assert.ok(description.includes(source.note));
  }
  const report = {
    ok: true,
    scope: 'actual native process and self-made PNG/MP4; not Edge UI acceptance',
    sourceItems: 2,
    resultItems: 1,
    attachmentKinds: item.attachments.map((a) => a.kind),
    attachmentBytesAndHashesUnchanged: true,
    originsNotesAndCollectionTimesPreserved: true,
    visibleListOrderPreserved: true,
    renamedCollisions: true,
    mp4FullDecodePassed: true,
    restartAndLostAcknowledgementIdempotent: true,
    libraryItems: 0,
  };
  await mkdir('.local-data/merge-smoke', { recursive: true });
  await writeFile('.local-data/merge-smoke/latest.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop();
  const allowed = path.resolve('.local-data');
  if (!root.startsWith(allowed + path.sep) || !path.basename(root).startsWith('merge-smoke-'))
    throw new Error('Unsafe merge-test cleanup');
  await rm(root, { recursive: true, force: true });
}
