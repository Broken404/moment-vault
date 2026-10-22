import { build } from 'vite';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Real TS upload publisher -> framed native protocol -> actual FFmpeg -> MP4.
// The input is generated, so this is deliberately not a tabCapture acceptance test.
const root = resolve('.local-data', `recording-pipeline-${randomUUID()}`);
await mkdir(join(root, 'draft'), { recursive: true });
await mkdir(join(root, 'library'), { recursive: true });
const binary = process.env.MOMENT_VAULT_TEST_FFMPEG,
  probe = process.env.MOMENT_VAULT_TEST_FFPROBE;
const executable = resolve(
  process.env.MOMENT_VAULT_TEST_HOST ?? 'dist/host-recording/MomentVault.Host.exe',
);
if (!binary || !probe)
  throw new Error('Set MOMENT_VAULT_TEST_FFMPEG and MOMENT_VAULT_TEST_FFPROBE to installed tools.');
const input = join(root, 'owned.webm');
const generated = spawnSync(
  binary,
  [
    '-nostdin',
    '-v',
    'error',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v',
    'libvpx-vp9',
    '-c:a',
    'libopus',
    input,
  ],
  { windowsHide: true, encoding: 'utf8' },
);
assert.equal(generated.status, 0, generated.stderr);
await build({
  configFile: false,
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
  },
  build: {
    outDir: join(root, 'publisher'),
    lib: {
      entry: 'apps/extension/src/recording/publish.ts',
      formats: ['es'],
      fileName: () => 'publish.mjs',
    },
  },
});
const { publishRecording } = await import(pathToFileURL(join(root, 'publisher/publish.mjs')).href);
const child = spawn(executable, ['--stdio-test', '--data-home', join(root, 'state')], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = Buffer.alloc(0),
  stderr = '';
const pending = new Map();
child.stderr.on('data', (data) => {
  stderr += data.toString();
});
child.stdout.on('data', (data) => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(0);
    if (buffer.length < 4 + size) return;
    const response = JSON.parse(buffer.subarray(4, 4 + size).toString());
    buffer = buffer.subarray(4 + size);
    pending.get(response.id)?.(response);
  }
});
async function host(op, payload = {}) {
  const id = randomUUID();
  const response = new Promise((yes, no) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      no(new Error(`Native timeout: ${op} ${stderr}`));
    }, 30000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      pending.delete(id);
      yes(result);
    });
  });
  const bytes = Buffer.from(JSON.stringify({ protocol: 1, id, op, payload })),
    header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  child.stdin.write(header);
  child.stdin.write(bytes);
  const result = await response;
  if (!result.ok) throw new Error(result.error.message);
  return result.result;
}
try {
  await host('config.set', { draftRoot: join(root, 'draft'), libraryRoot: join(root, 'library') });
  assert.equal((await host('ping')).recordingToolsAvailable, true);
  const bytes = await readFile(input),
    parts = [
      new Blob([bytes.subarray(0, Math.floor(bytes.length / 2))]),
      new Blob([bytes.subarray(Math.floor(bytes.length / 2))]),
    ];
  const job = {
    id: randomUUID().replaceAll('-', ''),
    attachmentId: randomUUID().replaceAll('-', ''),
    tabId: 0,
    name: '自制录制联动夹具',
    selection: {
      a: 0,
      b: 2,
      actualStart: 0,
      source: 'owned:generated-fixture',
      title: 'Generated fixture',
      rect: { x: 0, y: 0, width: 640, height: 360 },
      viewport: { width: 640, height: 360 },
    },
    phase: 'processing',
    end: { actualStart: 0, actualEnd: 2, stopReason: 'selected-end' },
    parts: parts.length,
    bytes: bytes.length,
    lastTime: 2,
    createdAt: new Date().toISOString(),
  };
  let removed = false,
    lost = false;
  const sequences = [];
  const store = {
    put: async () => {},
    readPart: async (_id, index) => parts[index],
    remove: async () => {
      removed = true;
    },
  };
  const transport = async (op, payload) => {
    const result = await host(op, payload);
    if (op === 'items.append') {
      sequences.push(payload.sequence);
      if (!lost) {
        lost = true;
        throw new Error('Simulated lost acknowledgement after native acceptance');
      }
    }
    return result;
  };
  await assert.rejects(
    () =>
      publishRecording(
        job,
        store,
        transport,
        async () => {},
        async () => {},
      ),
    /lost acknowledgement/,
  );
  assert.equal(removed, false);
  await publishRecording(
    job,
    store,
    transport,
    async () => {},
    () => new Promise((yes) => setTimeout(yes, 150)),
  );
  assert.equal(removed, true);
  const listed = await host('items.list', { bucket: 'draft' });
  assert.equal(listed.items.length, 1);
  const item = listed.items[0],
    file = item.attachments[0];
  assert.equal(file.fileName, '视频-001.mp4');
  assert.equal(file.range.capture, 'tabCapture-to-canvas');
  const media = join(root, 'draft', item.folderName, file.fileName);
  const decoded = spawnSync(
    binary,
    ['-nostdin', '-v', 'error', '-xerror', '-i', media, '-f', 'null', '-'],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(decoded.status, 0, decoded.stderr);
  const checked = spawnSync(
    probe,
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_name,codec_type,nb_read_frames,width,height,duration',
      '-of',
      'json',
      media,
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(checked.status, 0, checked.stderr);
  const streams = JSON.parse(checked.stdout).streams;
  assert.equal(streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
  assert.equal(streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
  const saved = await host('recordings.process', { uploadId: job.id, end: job.end });
  assert.equal(saved.item.id, item.id);
  assert.equal((await host('items.list', { bucket: 'draft' })).total, 1);
  const evidence = {
    scope:
      'Generated media through production TS publisher, actual framed native host and bundled FFmpeg; no browser capture claimed',
    lostAcknowledgementReplayed: true,
    oneMaterial: true,
    sequences,
    streams,
    bytes: file.bytes,
    sha256: createHash('sha256')
      .update(await readFile(media))
      .digest('hex'),
    media,
  };
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ result: 'PASS', root, media, streams }));
} finally {
  child.stdin.end();
}
