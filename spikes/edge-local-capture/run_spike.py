"""One-command, isolated Edge experiment. All outputs stay in .spike-data.

This is a disposable technical spike, not a production helper or service.
The HTTP helper can only open two predetermined scratch folders. It has no
arbitrary path, shell-command, upload, file-reading, or remote-listening API.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from native.scratch import ScratchStore

SPIKE = Path(__file__).resolve().parent
REPO = SPIKE.parent.parent
DATA = REPO / '.spike-data'
EXTENSION = SPIKE / 'extension'
BASE = 'http://127.0.0.1:43817'


def extension_id():
    key = json.loads((EXTENSION / 'manifest.json').read_text('utf-8'))['key']
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


FIXTURE = b'''<!doctype html><meta charset="utf-8"><title>Self-made selected capture test</title>
<style>body{font:18px system-ui;background:#eee;padding:16px}video{display:block;width:640px;height:360px}#clock{font:22px monospace}</style>
<h1>Self-made source: 15 seconds, moving pattern + 440 Hz audio</h1>
<video controls src="/self-made.mp4"></video><p id="clock">0.00 / 15.00</p>
<p>No automatic recording. Use the extension selection panel and explicit shortcut.</p>
<script>const v=document.querySelector('video');setInterval(()=>document.querySelector('#clock').textContent=v.currentTime.toFixed(2)+' / '+v.duration.toFixed(2)+' | '+(v.paused?'paused':'playing'),100);</script>'''


def prepare_fixture():
    DATA.mkdir(exist_ok=True)
    for name in ['draft', 'library']:
        (DATA / name).mkdir(exist_ok=True)
    media = DATA / 'self-made.mp4'
    if not media.exists():
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            raise RuntimeError('ffmpeg is required to generate the self-made audio/video fixture')
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i',
                        'sine=frequency=440:sample_rate=48000', '-t', '15',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
                        '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags',
                        '+faststart', '-y', str(media)], check=True)


def handler(token, origin):
    roots = {'draft': DATA / 'draft', 'library': DATA / 'library'}
    store = ScratchStore(DATA)
    allowed_origins = {origin, BASE}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, payload, kind='application/json'):
            body = json.dumps(payload).encode() if kind == 'application/json' else payload
            self.send_response(code)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            if self.headers.get('Origin') in allowed_origins:
                self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Spike-Token')
                self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.reply(204, b'', 'text/plain')

        def do_GET(self):
            path = urlsplit(self.path).path
            if path in ('/', '/dashboard.html'):
                self.reply(200, (EXTENSION / 'dashboard.html').read_bytes(), 'text/html; charset=utf-8')
            elif path in ('/dashboard.js', '/files.js'):
                self.reply(200, (EXTENSION / path[1:]).read_bytes(), 'text/javascript; charset=utf-8')
            elif path == '/session.js':
                if self.headers.get('Sec-Fetch-Site') not in ('same-origin', None):
                    self.reply(403, {'error': 'Session belongs to the local dashboard'})
                    return
                session = {'token': token, 'extensionId': extension_id()}
                self.reply(200, ('globalThis.SPIKE_CONFIG=' + json.dumps(session) + ';').encode(), 'text/javascript')
            elif path == '/fixture.html':
                self.reply(200, FIXTURE, 'text/html; charset=utf-8')
            elif path == '/self-made.mp4':
                media = (DATA / 'self-made.mp4').read_bytes()
                # Byte ranges allow seeking in the self-made source.
                requested = self.headers.get('Range')
                if requested and requested.startswith('bytes='):
                    spec = requested[6:].split('-')
                    start = int(spec[0] or 0)
                    end = min(int(spec[1]) if len(spec) > 1 and spec[1] else len(media)-1, len(media)-1)
                    chunk = media[start:end+1]
                    self.send_response(206)
                    self.send_header('Content-Type', 'video/mp4')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, len(media)))
                    self.send_header('Content-Length', str(len(chunk)))
                    self.end_headers()
                    self.wfile.write(chunk)
                else:
                    self.reply(200, media, 'video/mp4')
            else:
                self.reply(404, {'error': 'Not found'})

        def do_POST(self):
            if self.headers.get('Host') != '127.0.0.1:43817' or self.headers.get('Origin') not in allowed_origins or not secrets.compare_digest(self.headers.get('X-Spike-Token', ''), token):
                self.reply(403, {'error': 'Rejected origin or token'})
                return
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 16_000_000:
                self.reply(413, {'error': 'Body too large'})
                return
            try:
                body = json.loads(self.rfile.read(length))
                if self.path == '/api/open':
                    name = body.get('root')
                    if name not in roots:
                        raise ValueError('Only the two named scratch directories can be opened')
                    directory = roots[name].resolve(strict=True)
                    if not directory.is_relative_to(DATA.resolve()):
                        raise ValueError('Path escaped the scratch workspace')
                    subprocess.Popen(['explorer.exe', str(directory)])
                    result = {'status': 'open-request-sent', 'root': name, 'path': str(directory),
                              'note': 'Verify the actual Explorer window separately'}
                elif self.path == '/api/save':
                    result = store.save(body)
                elif self.path == '/api/promote':
                    result = store.promote(body['item'])
                elif self.path == '/api/ready':
                    result = {'status': 'ready', 'saveMode': 'native-scratch', 'roots': {name: str(store.root(name)) for name in roots}}
                elif self.path == '/api/evidence':
                    with lock:
                        with (DATA / 'browser-events.jsonl').open('a', encoding='utf-8') as f:
                            f.write(json.dumps(body, ensure_ascii=False) + '\n')
                    result = {'status': 'recorded'}
                else:
                    self.reply(404, {'error': 'Not found'})
                    return
                self.reply(200, result)
            except (ValueError, OSError) as error:
                self.reply(400, {'error': str(error)})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--launch', action='store_true', help='Launch installed Edge with a separate disposable profile')
    args = parser.parse_args()
    prepare_fixture()
    identifier = extension_id()
    origin = 'chrome-extension://' + identifier
    token = secrets.token_urlsafe(32)
    (EXTENSION / 'runtime-config.js').write_text('globalThis.SPIKE_CONFIG = ' + json.dumps({'base': BASE, 'token': token}) + ';\n', 'utf-8')
    (DATA / 'run-info.json').write_text(json.dumps({'extensionId': identifier, 'origin': origin, 'url': BASE + '/dashboard.html', 'scratch': str(DATA)}, indent=2), 'utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 43817), handler(token, origin))
    if args.launch:
        edge = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe'
        if not edge.is_file():
            raise RuntimeError('Installed Microsoft Edge was not found')
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        subprocess.Popen([str(edge), '--user-data-dir=' + str(DATA / 'edge-profile'),
                          '--load-extension=' + str(EXTENSION), '--no-first-run',
                          '--no-default-browser-check', '--new-window', BASE + '/dashboard.html'], startupinfo=startup)
    print(json.dumps({'status': 'running', 'probe': BASE + '/dashboard.html', 'fixture': BASE + '/fixture.html', 'scratch': str(DATA)}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
