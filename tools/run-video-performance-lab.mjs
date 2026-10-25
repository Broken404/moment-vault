import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Own media and delayed Range responses only. No user files or helper API.
const output = resolve('.local-data/video-performance-lab');
await mkdir(output, { recursive: true });
const binary = process.env.MOMENT_VAULT_TEST_FFMPEG;
if (!binary) throw Error('Select the installed FFmpeg using MOMENT_VAULT_TEST_FFMPEG');
const font =
  "drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='OWNED %{pts\\:hms}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8:x=12:y=12";
const media = [
  { name: 'landscape', size: '640x360', rate: 30, duration: 40 },
  { name: 'portrait', size: '360x640', rate: 30, duration: 40 },
  { name: 'portrait-low', size: '180x320', rate: 30, duration: 40 },
];
if (process.argv.includes('--include-long'))
  media.push({ name: 'hour', size: '640x360', rate: 15, duration: 3600 });
for (const item of media) {
  const file = resolve(output, item.name + '.mp4');
  if (existsSync(file)) continue;
  console.log('Generating self-made ' + item.name + ' (' + item.duration + ' seconds)');
  const generated = spawnSync(
    binary,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${item.size}:rate=${item.rate}:duration=${item.duration}`,
      '-vf',
      font,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '35',
      '-threads',
      '2',
      '-g',
      String(item.rate * 2),
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      file,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 240000 },
  );
  if (generated.status !== 0) throw Error(generated.stderr || 'Media generation failed');
}
await build({
  configFile: false,
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __MV_VIDEO_PERFORMANCE_LAB__: 'true',
  },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
  },
  build: {
    target: 'chrome120',
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: 'apps/extension/src/video/lab.tsx',
      name: 'VideoPerformanceLab',
      formats: ['iife'],
      fileName: () => 'lab.js',
    },
  },
});
await writeFile(
  resolve(output, 'index.html'),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Moment Vault 视频性能验证</title><div id="lab"></div><script src="/lab.js"></script></html>',
);
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify(
    {
      scope:
        'self-made media; production preview code with opt-in DOM-only measurement; no capture or asset writes',
      media: await Promise.all(
        media.map(async (item) => ({
          ...item,
          bytes: (await stat(resolve(output, item.name + '.mp4'))).size,
          sha256: createHash('sha256')
            .update(await readFile(resolve(output, item.name + '.mp4')))
            .digest('hex'),
        })),
      ),
    },
    null,
    2,
  ) + '\n',
);
if (process.argv.includes('--build-only')) process.exit(0);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/lab.js', ['lab.js', 'text/javascript; charset=utf-8']],
  ['/fixture.mp4', ['landscape.mp4', 'video/mp4']],
  ...media.map((item) => ['/' + item.name + '.mp4', [item.name + '.mp4', 'video/mp4']]),
]);
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const file = files.get(url.pathname);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    const full = resolve(output, file[0]),
      info = await stat(full);
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if ((request.headers.range && !match) || start > end || start >= info.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    response.writeHead(match ? 206 : 200, {
      'Content-Type': file[1],
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const network = url.searchParams.get('network') ?? 'normal';
    requests.push({ atUtc: new Date().toISOString(), file: file[0], start, end, network });
    await writeFile(resolve(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
    const stream = createReadStream(full, { start, end, highWaterMark: 32768 });
    response.on('close', () => stream.destroy());
    if (file[1] !== 'video/mp4' || network === 'normal') {
      stream.on('error', () => response.destroy()).pipe(response);
      return;
    }
    let offset = start;
    for await (const chunk of stream) {
      if (response.destroyed) break;
      if (offset >= 131072)
        await new Promise((done) =>
          setTimeout(
            done,
            network === 'timeout' && offset === Math.max(start, 131072)
              ? 9500
              : network === 'timeout'
                ? 0
                : network === 'stall'
                  ? 1000
                  : 350,
          ),
        );
      if (response.destroyed) break;
      if (!response.write(chunk))
        await new Promise((done) => {
          const finish = () => {
            response.off('drain', finish);
            response.off('close', finish);
            done();
          };
          response.once('drain', finish);
          response.once('close', finish);
        });
      offset += chunk.length;
    }
    if (!response.destroyed) response.end();
  } catch {
    if (!response.destroyed) response.destroy();
  }
});
server.listen(43826, '127.0.0.1', () =>
  console.log(
    'Owned video performance lab: http://127.0.0.1:43826/?media=landscape (long media excluded unless --include-long)',
  ),
);
