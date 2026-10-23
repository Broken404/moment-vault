import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

// Production TS uploader + recovery -> actual framed native process. All input
// is generated here; this is not a formal-extension or browser-closure test.
const root = path.resolve('.local-data', `upload-recovery-${randomUUID()}`);
const draftRoot = path.join(root, 'draft'),
  libraryRoot = path.join(root, 'library');
const executable = path.resolve(
  process.env.MOMENT_VAULT_TEST_HOST ?? 'dist/host/MomentVault.Host.exe',
);
const ffmpeg = path.join(path.dirname(executable), 'media/ffmpeg.exe');
await mkdir(draftRoot, { recursive: true });
await mkdir(libraryRoot, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let child, call, fault;
let operations = [];
function connect() {
  child = spawn(executable, ['--stdio-test', '--data-home', path.join(root, 'state')], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0),
    stderr = '';
  const pending = new Map();
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  child.stdout.on('data', (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0),
        result = JSON.parse(buffer.subarray(4, size + 4));
      buffer = buffer.subarray(size + 4);
      pending.get(result.id)?.(result);
    }
  });
  return async (op, payload = {}) => {
    const id = randomUUID();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`Timeout ${op}: ${stderr}`));
      }, 15000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(result);
      });
    });
    const data = Buffer.from(JSON.stringify({ protocol: 1, id, op, payload }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    child.stdin.write(Buffer.concat([header, data]));
    return reply;
  };
}
async function host(op, payload = {}) {
  const response = await call(op, payload);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child,
    ended = new Promise((resolve) => current.once('exit', resolve));
  current.stdin.end();
  const timer = setTimeout(() => current.kill(), 3000);
  await ended;
  clearTimeout(timer);
}
async function restart() {
  await stop();
  call = connect();
}
async function snapshot(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map(async (e) => [e.name, hash(await readFile(path.join(directory, e.name)))]),
    ),
  );
}
const generated = [];
function generate(name, args) {
  const output = path.join(root, name);
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-n', ...args, output], { windowsHide: true });
  generated.push(output);
  return output;
}
try {
  const warm = generate('warm.png', [
    '-f',
    'lavfi',
    '-i',
    'color=c=0xefbd50:s=160x90',
    '-frames:v',
    '1',
  ]);
  const video = generate('motion.mp4', [
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
  ]);
  const large = generate('remaining.png', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=800x450',
    '-frames:v',
    '1',
    '-compression_level',
    '0',
  ]);
  const data = await Promise.all(generated.map((p) => readFile(p)));
  const files = data.map(
    (bytes, index) =>
      new File([bytes], path.basename(generated[index]), {
        type: index === 1 ? 'video/mp4' : 'image/png',
        lastModified: 123,
      }),
  );
  assert.ok(files[2].size > 192 * 1024);
  await build({
    configFile: false,
    resolve: {
      alias: { '@shared': fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
    },
    build: {
      outDir: path.join(root, 'production-api'),
      lib: { entry: 'apps/extension/src/api.ts', formats: ['es'], fileName: () => 'api.mjs' },
    },
  });
  const { beginUpload, uploadFiles, resumeUpload } = await import(
    pathToFileURL(path.join(root, 'production-api/api.mjs')).href
  );
  call = connect();
  await host('config.set', { draftRoot, libraryRoot });
  let retainedPart, retainedStamp;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        operations.push(message);
        if (
          retainedPart &&
          message.op === 'items.append' &&
          message.payload.sequence === 1 &&
          message.payload.attachmentId === missingId
        )
          assert.equal((await stat(retainedPart)).mtimeMs, retainedStamp);
        if (fault?.before && fault.match(message)) {
          const current = fault;
          fault = undefined;
          throw Error(current.label);
        }
        const result = await call(message.op, message.payload);
        if (fault && fault.match(message)) {
          const current = fault;
          fault = undefined;
          throw Error(current.label);
        }
        return result;
      },
    },
  };

  let batch = beginUpload(files);
  batch.name = '自制恢复混合组';
  const mixedId = batch.uploadId,
    missingId = batch.attachments[2].id;
  fault = {
    label: 'injected lost chunk reply',
    match: (m) =>
      m.op === 'items.append' && m.payload.attachmentId === missingId && m.payload.sequence === 0,
  };
  await assert.rejects(
    uploadFiles(files, batch, () => {}),
    /lost chunk reply/,
  );
  batch = null;
  await restart(); // Discard the original batch's entire in-memory state.
  let pending = await host('uploads.list', { draftRoot });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].completeFiles, 2);
  const directory = path.join(draftRoot, '.moment-vault/pending', mixedId);
  const originalProgress = await host('uploads.get', { draftRoot, uploadId: mixedId });
  const before = await snapshot(directory);
  retainedPart = path.join(directory, `${missingId}.000000.part`);
  retainedStamp = (await stat(retainedPart)).mtimeMs;
  const changed = Buffer.from(data[2]);
  changed[0] ^= 1;
  await assert.rejects(
    resumeUpload(
      draftRoot,
      mixedId,
      [new File([changed], files[2].name, { type: files[2].type, lastModified: 123 })],
      () => {},
    ),
    /不一致/,
  );
  assert.deepEqual(await snapshot(directory), before);
  const afterConflict = operations.length;
  const recovered = await resumeUpload(draftRoot, mixedId, [files[2]], () => {});
  assert.equal(recovered.id, mixedId);
  assert.equal(recovered.name, originalProgress.name);
  assert.equal(recovered.createdAt, originalProgress.createdAt);
  assert.equal(recovered.attachments.length, 3);
  assert.deepEqual(
    recovered.attachments.map((file) => file.id),
    originalProgress.files.map((file) => file.id),
  );
  assert.ok(!operations.slice(afterConflict).some((m) => m.op === 'items.begin'));
  const savedFolder = path.join(draftRoot, recovered.folderName);
  for (let i = 0; i < data.length; i++)
    assert.equal(
      hash(await readFile(path.join(savedFolder, recovered.attachments[i].fileName))),
      hash(data[i]),
    );
  assert.deepEqual((await host('uploads.list', { draftRoot })).items, []);

  const allReceived = beginUpload([files[0]]);
  fault = {
    label: 'injected before final commit',
    before: true,
    match: (m) => m.op === 'items.commit',
  };
  await assert.rejects(
    uploadFiles([files[0]], allReceived, () => {}),
    /before final commit/,
  );
  await restart();
  const ready = await host('uploads.get', { draftRoot, uploadId: allReceived.uploadId });
  assert.ok(ready.files.every((f) => f.complete));
  const readyStart = operations.length;
  const readyResult = await resumeUpload(draftRoot, allReceived.uploadId, [], () => {});
  assert.equal(readyResult.id, allReceived.uploadId);
  assert.deepEqual(
    operations.slice(readyStart).map((m) => m.op),
    ['uploads.get', 'items.commit'],
  );

  const lost = beginUpload([files[0]]);
  fault = { label: 'injected lost commit reply', match: (m) => m.op === 'items.commit' };
  await assert.rejects(
    uploadFiles([files[0]], lost, () => {}),
    /lost commit reply/,
  );
  await restart();
  const lostStart = operations.length;
  assert.equal((await resumeUpload(draftRoot, lost.uploadId, [], () => {})).id, lost.uploadId);
  assert.deepEqual(
    operations.slice(lostStart).map((m) => m.op),
    ['uploads.get'],
  );

  const discard = beginUpload([files[2]]);
  fault = { label: 'injected lost first chunk reply', match: (m) => m.op === 'items.append' };
  await assert.rejects(
    uploadFiles([files[2]], discard, () => {}),
    /lost first chunk reply/,
  );
  assert.equal(
    (await call('uploads.discard', { draftRoot, uploadId: discard.uploadId, confirmed: false }))
      .error.code,
    'confirmation-required',
  );
  await host('uploads.discard', { draftRoot, uploadId: discard.uploadId, confirmed: true });
  await restart();
  await assert.rejects(
    uploadFiles([files[2]], discard, () => {}),
    /已删除/,
  );
  assert.equal((await host('items.list', { bucket: 'draft' })).total, 3);
  assert.equal((await host('uploads.list', { draftRoot })).total, 0);
  for (let i = 0; i < generated.length; i++)
    assert.equal(hash(await readFile(generated[i])), hash(data[i]));
  for (const file of recovered.attachments)
    execFileSync(
      ffmpeg,
      ['-v', 'error', '-nostdin', '-i', path.join(savedFolder, file.fileName), '-f', 'null', '-'],
      { windowsHide: true, stdio: 'pipe' },
    );
  const report = {
    scope: 'production TypeScript and actual native processes, isolated self-made media',
    passed: true,
    cases: 4,
    restartPartialRecovery: true,
    fullMetadataAndThreeHashesPreserved: true,
    prefixConflictPreservesAllPendingBytes: true,
    retainedPrefixNotRewritten: true,
    allReceivedRecoveryNeedsNoFiles: true,
    lostCommitReplyDoesNotRepublish: true,
    confirmedDiscardCannotBeRecreatedByLateRetry: true,
    recoveredMediaDecodes: true,
    originalInputsUnchanged: true,
    actualFormalExtensionAcceptance: false,
    samplePartialChunkBytes: before[`${missingId}.000000.part`] ? 196608 : 0,
    savedItems: 3,
  };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, ...report }, null, 2));
} finally {
  await stop();
}
