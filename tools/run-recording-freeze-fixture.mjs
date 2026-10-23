import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Owned source and bounded test reports only. No recording trigger, extension or helper API.
const output = resolve('.local-data/recording-freeze-fixture');
const encoder = process.env.MOMENT_VAULT_TEST_FFMPEG;
if (!encoder) throw new Error('Set MOMENT_VAULT_TEST_FFMPEG to the installed FFmpeg executable.');
await mkdir(output, { recursive: true });
const media = resolve(output, 'owned-source.mp4');
const sourceExists = await access(media).then(
  () => true,
  () => false,
);
if (!sourceExists) {
  const generated = spawnSync(
    encoder,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=30:duration=15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=15',
      '-vf',
      "drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{pts\\:hms}  frame %{n}':fontsize=22:fontcolor=white:box=1:boxcolor=black@0.85:x=8:y=8",
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      media,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (generated.status !== 0) throw new Error(generated.stderr || 'Owned source generation failed');
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moment Vault 自制短片停帧验证</title>
<style>body{font:18px system-ui;background:#eee;color:#222;margin:24px}h1{font-size:25px;margin:0 0 12px}p{max-width:950px}#moment-vault-owned-player{width:640px;height:360px;position:relative;background:#000}video{display:block;width:640px;height:360px}[data-mv-owned-controls]{position:absolute;left:0;right:0;bottom:0;padding:10px 8px;background:#0005}[data-mv-owned-rail]{height:6px;background:#ddd;cursor:pointer}#elapsed{font:20px monospace}button{font:inherit;padding:7px 12px}</style>
<h1>自制短片停帧验证</h1><p>15 秒连续运动、画面时间码与 440 Hz 音轨。使用正式桌宠选段；本页不会自动开始录制。</p>
<div id="moment-vault-owned-player"><video id="source" src="/owned-source.mp4" preload="auto" playsinline></video><div data-mv-owned-controls><div data-mv-owned-rail aria-label="自制源进度条"></div></div></div>
<p><button id="watch">播放／暂停源视频（仅观看）</button> <span id="elapsed">正在加载视频</span></p>
<p>本页用于真实标签页采集验证。录制只由分配给正式扩展的快捷键启动；结果保存在已配置的草稿箱。</p>
<script>const v=document.getElementById('source'),clock=document.getElementById('elapsed');document.getElementById('watch').onclick=()=>v.paused?v.play():v.pause();document.querySelector('[data-mv-owned-rail]').onclick=e=>{const r=e.currentTarget.getBoundingClientRect();v.pause();v.currentTime=Math.max(0,Math.min(v.duration,(e.clientX-r.left)/r.width*v.duration));};setInterval(()=>{clock.textContent=v.currentTime.toFixed(3)+' / '+(Number.isFinite(v.duration)?v.duration.toFixed(3):'--')+' · '+(v.paused?'已暂停':'播放中');},100);</script></html>`;
await writeFile(resolve(output, 'capture.html'), html);
if (process.argv.includes('--build-only')) process.exit(0);
const server = createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://127.0.0.1:43820').pathname;
    const probe = /^\/probe\/([a-f0-9]{32})\/(source\.json|input\.json|capture\.webm)$/.exec(name);
    if (probe) {
      const origin = request.headers.origin;
      if (
        !['http://127.0.0.1:43820', 'chrome-extension://hpchplafhkkndbocdiopnbmkkhbjokii'].includes(
          origin,
        )
      ) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        response
          .writeHead(204, {
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'X-Moment-Vault-Owned-Probe, Content-Type',
          })
          .end();
        return;
      }
      if (request.method !== 'POST' || request.headers['x-moment-vault-owned-probe'] !== '1') {
        response.writeHead(403).end();
        return;
      }
      const chunks = [];
      let bytes = 0;
      const maximum = probe[2] === 'capture.webm' ? 32 * 1024 * 1024 : 256 * 1024;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maximum) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (probe[2].endsWith('.json')) {
        const report = JSON.parse(data.toString('utf8'));
        if (report.id !== probe[1] || !['source', 'input'].includes(report.side)) {
          response.writeHead(400).end();
          return;
        }
      }
      const directory = resolve(output, 'probes', probe[1]);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, probe[2]), data, { flag: 'wx' });
      console.log(`Owned probe: ${probe[1]}/${probe[2]} (${bytes} bytes)`);
      response.writeHead(201).end();
      return;
    }
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      !['/capture.html', '/owned-source.mp4'].includes(name)
    ) {
      response.writeHead(404).end();
      return;
    }
    const file = resolve(output, name.slice(1)),
      info = await stat(file);
    let start = 0,
      end = info.size - 1;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416).end();
        return;
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': 'bytes */' + info.size }).end();
        return;
      }
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + info.size } : {}),
    });
    if (request.method === 'HEAD') response.end();
    else
      createReadStream(file, { start, end })
        .on('error', () => response.destroy())
        .pipe(response);
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(43820, '127.0.0.1', () =>
  console.log('Owned capture source: http://127.0.0.1:43820/capture.html'),
);
