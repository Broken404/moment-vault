import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This GET-only loopback fixture has no helper API and never serves arbitrary paths.
const output = resolve('.local-data/video-preview-lab');
await mkdir(output, { recursive: true });
const binary = process.env.MOMENT_VAULT_TEST_FFMPEG;
if (!binary)
  throw new Error(
    'Set MOMENT_VAULT_TEST_FFMPEG to an installed FFmpeg executable to generate the owned fixture.',
  );
const fixture = resolve(output, 'fixture.mp4');
const generated = spawnSync(
  binary,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=960x540:rate=30:duration=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=15',
    '-vf',
    "drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='OWNED PREVIEW  %{pts\\:hms}':fontsize=38:fontcolor=white:box=1:boxcolor=black@0.8:x=30:y=30",
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    fixture,
  ],
  { encoding: 'utf8', windowsHide: true },
);
if (generated.status !== 0) throw new Error(generated.stderr || 'Fixture generation failed');
await build({
  configFile: false,
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../packages/shared/src', import.meta.url)) },
  },
  build: {
    target: 'chrome120',
    outDir: output,
    emptyOutDir: false,
    lib: {
      entry: 'apps/extension/src/video/lab.tsx',
      name: 'PreviewLab',
      formats: ['iife'],
      fileName: () => 'lab.js',
    },
  },
});
await writeFile(
  resolve(output, 'index.html'),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moment Vault 视频选段联调</title><div id="lab"></div><script src="/lab.js"></script></html>',
);
if (process.argv.includes('--build-only')) process.exit(0);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/lab.js', ['lab.js', 'text/javascript; charset=utf-8']],
  ['/fixture.mp4', ['fixture.mp4', 'video/mp4']],
]);
const server = createServer(async (request, response) => {
  try {
    const file = files.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    const path = resolve(output, file[0]),
      info = await stat(path);
    const headers = {
      'Content-Type': file[1],
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    const range = request.headers.range;
    let start = 0,
      end = info.size - 1;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return;
      }
    }
    response.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    });
    if (request.method === 'HEAD') response.end();
    else
      createReadStream(path, { start, end })
        .on('error', () => response.destroy())
        .pipe(response);
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(43818, '127.0.0.1', () =>
  console.log('Owned preview fixture: http://127.0.0.1:43818/ (not platform acceptance)'),
);
