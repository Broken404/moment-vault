import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A native-library measurement, not a browser render, tab capture or physical
// disk-cold benchmark. Every input, folder and configuration is isolated here.
assert.equal(process.platform, 'win32');
const executable = path.resolve(
  process.env.MOMENT_VAULT_TEST_HOST ?? 'dist/host/MomentVault.Host.exe',
);
const ffmpeg = path.join(path.dirname(executable), 'media/ffmpeg.exe');
const checkReadScaling = process.argv.includes('--check-read-scaling');
const root = path.resolve('.local-data', `library-measurement-${randomUUID()}`);
const draftRoot = path.join(root, 'draft'),
  libraryRoot = path.join(root, 'library'),
  dataHome = path.join(root, 'state');
assert.ok(root.startsWith(path.resolve('.local-data') + path.sep));
await Promise.all([mkdir(draftRoot, { recursive: true }), mkdir(libraryRoot, { recursive: true })]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ms = (value) => Math.round(value * 1000) / 1000;
const stats = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    samples: values.map(ms),
    medianMs: ms(ordered[Math.floor(ordered.length / 2)]),
    maxMs: ms(ordered.at(-1)),
  };
};
const report = {
  status: 'running',
  startedAtUtc: new Date().toISOString(),
  scope:
    'real isolated native helper and self-made media; not browser rendering, recording, UI acceptance or physical cold-cache testing',
  nodeVersion: process.versions.node,
  helperDllSha256: hash(await readFile(executable.replace(/\.exe$/i, '.dll'))),
  measurementScriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  root,
  counts: [],
};
let child, call;
function connect() {
  child = spawn(executable, ['--stdio-test', '--data-home', dataHome], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0),
    stderr = '';
  const waiting = new Map();
  const fail = (error) => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };
  child.on('error', fail);
  child.on('exit', (code) => fail(Error(`Helper exited ${code}: ${stderr}`)));
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  child.stdout.on('data', (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 900000) {
        fail(Error('Invalid protocol length'));
        return;
      }
      if (buffer.length < length + 4) return;
      const result = JSON.parse(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
      waiting.get(result.id)?.resolve(result);
    }
  });
  call = async (op, payload = {}) => {
    const id = randomUUID();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Error('Native timeout: ' + op));
      }, 60000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          waiting.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          waiting.delete(id);
          reject(error);
        },
      });
    });
    const bytes = Buffer.from(JSON.stringify({ protocol: 1, id, op, payload })),
      header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    child.stdin.write(Buffer.concat([header, bytes]));
    const result = await reply;
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.result;
  };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child,
    ended = new Promise((resolve) => current.once('exit', resolve));
  current.stdin.end();
  const timer = setTimeout(() => current.kill(), 5000);
  await ended;
  clearTimeout(timer);
}
function generate(name, args) {
  const file = path.join(root, name);
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-n', ...args, file], {
    windowsHide: true,
    timeout: 60000,
  });
  return file;
}
async function upload(name, inputs) {
  const uploadId = randomUUID().replaceAll('-', '');
  const files = inputs.map((input) => ({
    ...input,
    id: randomUUID().replaceAll('-', ''),
    source: 'self-made-library-measurement',
    note: 'self-made attachment',
  }));
  await call('items.begin', {
    uploadId,
    name,
    note: 'self-made library measurement',
    files: files.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })),
  });
  for (const file of files) {
    const chunks = Math.ceil(file.bytes.length / 196608);
    for (let sequence = 0; sequence < chunks; sequence++)
      await call('items.append', {
        uploadId,
        attachmentId: file.id,
        sequence,
        base64: file.bytes.subarray(sequence * 196608, (sequence + 1) * 196608).toString('base64'),
      });
    await call('items.finishFile', {
      uploadId,
      attachmentId: file.id,
      chunks,
      bytes: file.bytes.length,
    });
  }
  return call('items.commit', { uploadId });
}
async function timed(op, payload) {
  const started = performance.now(),
    result = await call(op, payload);
  return { ms: performance.now() - started, result };
}
function helperMemory() {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  const script = `$measuredProcess=Get-Process -Id ${child.pid}; @{workingSetBytes=$measuredProcess.WorkingSet64;privateBytes=$measuredProcess.PrivateMemorySize64;threads=$measuredProcess.Threads.Count}|ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    }),
  );
}
try {
  const imagePath = generate('small.png', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180',
    '-frames:v',
    '1',
  ]);
  const videoPath = generate('small.mp4', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-pix_fmt',
    'yuv420p',
  ]);
  const imageBytes = await readFile(imagePath),
    videoBytes = await readFile(videoPath);
  const originals = [
    { path: imagePath, hash: hash(imageBytes) },
    { path: videoPath, hash: hash(videoBytes) },
  ];
  connect();
  await call('config.set', { draftRoot, libraryRoot });
  const seed = await upload('library-seed', [
    { bytes: imageBytes, extension: 'png', kind: 'image', mime: 'image/png' },
    { bytes: videoBytes, extension: 'mp4', kind: 'video', mime: 'video/mp4' },
  ]);
  const seedFolder = path.join(draftRoot, seed.folderName),
    raw = await readFile(path.join(seedFolder, '描述.md'), 'utf8');
  const end = raw.indexOf('\n---\n', 4);
  assert.ok(end > 4);
  const metadata = JSON.parse(raw.slice(4, end)),
    note = raw.slice(end + 5);
  let count = 1;
  for (const target of checkReadScaling ? [100] : [100, 500, 1500]) {
    for (; count < target; count++) {
      const item = structuredClone(metadata);
      item.id = randomUUID().replaceAll('-', '');
      item.name = `Library load ${count}`;
      item.createdAt = new Date(Date.parse(metadata.createdAt) + count).toISOString();
      item.attachments.forEach((file) => {
        file.id = randomUUID().replaceAll('-', '');
      });
      const directory = path.join(draftRoot, `material-${String(count).padStart(5, '0')}`);
      await mkdir(directory);
      await Promise.all([
        writeFile(
          path.join(directory, '描述.md'),
          '---\n' + JSON.stringify(item, null, 2) + '\n---\n' + note,
        ),
        ...item.attachments.map((file) =>
          copyFile(path.join(seedFolder, file.fileName), path.join(directory, file.fileName)),
        ),
      ]);
    }
    await stop();
    connect();
    const first = await timed('items.list', { bucket: 'draft', offset: 0 });
    assert.equal(first.result.total, target);
    assert.equal(first.result.items.length, 40);
    assert.deepEqual(first.result.warnings, []);
    const firstPage = [],
      tailPage = [],
      ping = [];
    let tail;
    for (let iteration = 0; iteration < 5; iteration++) {
      const head = await timed('items.list', { bucket: 'draft', offset: 0 });
      assert.equal(head.result.total, target);
      firstPage.push(head.ms);
      tail = await timed('items.list', { bucket: 'draft', offset: target - 40 });
      assert.equal(tail.result.items.length, 40);
      tailPage.push(tail.ms);
      const status = await timed('ping');
      assert.equal(status.result.configured, true);
      assert.equal(status.result.pendingUploads, 0);
      ping.push(status.ms);
    }
    const before = helperMemory();
    const targets = (checkReadScaling ? [] : first.result.items)
      .slice(0, 6)
      .map((item, index) => ({ item, file: item.attachments[index % 2] }));
    if (!checkReadScaling)
      targets.push({
        item: tail.result.items.at(-1),
        file: tail.result.items.at(-1).attachments[0],
      });
    const thumbnails = [],
      busyPing = [];
    for (let pair = 0; pair < targets.length; pair += 2) {
      const active = targets
        .slice(pair, pair + 2)
        .map(({ item, file }) => ({ item, file, started: performance.now(), requests: [] }));
      const deadline = performance.now() + 30000;
      while (active.length) {
        for (let index = active.length - 1; index >= 0; index--) {
          const job = active[index],
            reply = await timed('items.thumbnail', {
              bucket: 'draft',
              id: job.item.id,
              attachmentId: job.file.id,
            });
          job.requests.push(reply.ms);
          assert.ok(
            ['loading', 'ready'].includes(reply.result.phase),
            JSON.stringify(reply.result),
          );
          if (reply.result.phase === 'ready') {
            assert.equal(
              Buffer.from(reply.result.base64, 'base64').subarray(0, 8).toString('hex'),
              '89504e470d0a1a0a',
            );
            thumbnails.push({
              kind: job.file.kind,
              position: job.item.id === seed.id ? 'oldest' : 'first-page',
              readyMs: ms(performance.now() - job.started),
              request: stats(job.requests),
            });
            active.splice(index, 1);
          }
        }
        const status = await timed('ping');
        assert.equal(status.result.configured, true);
        busyPing.push(status.ms);
        assert.ok(performance.now() < deadline, 'Thumbnail generation did not complete');
        if (active.length) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const cached = [];
    for (const { item, file } of targets) {
      const result = await timed('items.thumbnail', {
        bucket: 'draft',
        id: item.id,
        attachmentId: file.id,
      });
      assert.equal(result.result.phase, 'ready');
      cached.push(result.ms);
    }
    report.counts.push({
      items: target,
      attachments: target * 2,
      firstListIncludingHelperStartupMs: ms(first.ms),
      firstPage: stats(firstPage),
      tailPage: stats(tailPage),
      ping: stats(ping),
      helperMemoryBeforeThumbnails: before,
      helperMemoryAfterThumbnails: helperMemory(),
      thumbnailConcurrencyRequested: 2,
      thumbnails,
      thumbnailCachedRequest: cached.length ? stats(cached) : null,
      pingDuringThumbnails: busyPing.length ? stats(busyPing) : null,
    });
    process.stdout.write(
      `Measured ${target} items: list median ${stats(firstPage).medianMs} ms${cached.length ? ', cached thumbnail median ' + stats(cached).medianMs + ' ms' : ''}\n`,
    );
  }
  const largePath = generate('large.png', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1600x900',
    '-frames:v',
    '1',
    '-compression_level',
    '0',
  ]);
  const largeBytes = await readFile(largePath);
  assert.ok(largeBytes.length > 4 * 1024 * 1024 && largeBytes.length < 5 * 1024 * 1024);
  const start = performance.now(),
    large = await upload('large-preview-image', [
      { bytes: largeBytes, extension: 'png', kind: 'image', mime: 'image/png' },
    ]),
    uploadMs = performance.now() - start;
  const parts = [],
    reads = [],
    readStart = performance.now();
  let offset = 0;
  while (offset < largeBytes.length) {
    const read = await timed('items.readFile', {
      bucket: 'draft',
      id: large.id,
      attachmentId: large.attachments[0].id,
      offset,
    });
    assert.equal(read.result.offset, offset);
    assert.equal(read.result.total, largeBytes.length);
    const bytes = Buffer.from(read.result.base64, 'base64');
    assert.ok(bytes.length > 0);
    parts.push(bytes);
    offset += bytes.length;
    reads.push(read.ms);
  }
  assert.equal(hash(Buffer.concat(parts)), hash(largeBytes));
  report.largeAttachment = {
    bytes: largeBytes.length,
    itemsInLibrary: count + 1,
    uploadMs: ms(uploadMs),
    readAllMs: ms(performance.now() - readStart),
    readCalls: stats(reads),
    sha256: hash(largeBytes),
    roundTripBytesMatch: true,
  };
  for (const original of originals)
    assert.equal(hash(await readFile(original.path)), original.hash);
  assert.equal(hash(await readFile(largePath)), hash(largeBytes));
  report.sourceOriginalsUnchanged = true;
  if (checkReadScaling) {
    // Diagnostic relative budget: reading one 4 MiB preview must not cost a
    // whole library scan per chunk. This is not a portable UI latency target.
    const budgetMs = report.counts[0].firstPage.medianMs * 4 + 250;
    report.readScalingCheck = {
      budgetMs: ms(budgetMs),
      actualMs: report.largeAttachment.readAllMs,
      passed: report.largeAttachment.readAllMs < budgetMs,
    };
    assert.ok(
      report.readScalingCheck.passed,
      'Chunked preview read scales with full-library scans: ' +
        JSON.stringify(report.readScalingCheck),
    );
  }
  report.status = 'measured';
  report.completedAtUtc = new Date().toISOString();
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  throw error;
} finally {
  await stop();
  await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`Measurements: ${path.join(root, 'result.json')}\n`);
}
