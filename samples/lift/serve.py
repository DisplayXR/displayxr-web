#!/usr/bin/env python3
"""Dev server for the lift sample: serves the repo root with NO caching and the right MIME types.

    python3 samples/lift/serve.py [port] [--sharp] [--allow-popups]    (default 8812, binds 127.0.0.1)

Why not `python -m http.server`: it sends no Cache-Control, so Chrome heuristically caches ES
modules and a `git pull` can leave the page running stale SDK code (seen on the first panel test:
the splat count never changed after a generator fix). It also serves .mjs/.wasm/.onnx with
generic types on some Pythons.

Remote SHARP proxy (DEMO ONLY — docs/lift.md § Remote SHARP): with DXR_SHARP_URL and
DXR_SHARP_TOKEN in the environment (or --sharp, which insists on them), `POST /api/sharp/predict`
forwards the page's multipart body unchanged to `$DXR_SHARP_URL/v1/predict` with
`Authorization: Bearer $DXR_SHARP_TOKEN` and streams the worker's answer back. The token lives
only in this process's environment: it is never sent to the page and never logged. Map from the
gallery's names: DXR_SHARP_URL = MODAL_SHARP_URL, DXR_SHARP_TOKEN = MODAL_SHARP_TOKEN (the Modal
secret `sharp-auth`'s SHARP_SHARED_TOKEN). DXR_SHARP_TIMEOUT (s, default 180) bounds the call.

--allow-popups serves `Cross-Origin-Opener-Policy: same-origin-allow-popups` instead of
`same-origin`, which a popup sign-in (auth: {kind:'google'}) needs to hear back from its popup.
It drops cross-origin isolation (no SharedArrayBuffer) — only onnxruntime's threaded wasm cares.
"""
import http.server, json, mimetypes, os, sys, time, urllib.parse, urllib.request, urllib.error
from functools import partial

mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('application/octet-stream', '.onnx')
mimetypes.add_type('video/webm', '.webm')
mimetypes.add_type('application/octet-stream', '.sog')

SHARP_PATH = '/api/sharp/predict'
MAX_UPLOAD = 40 << 20  # a 1536-px JPEG is ~0.5 MB; anything this big is not a frame
# Response headers worth passing through (the worker's diagnostics); nothing else is forwarded.
PASS_HEADERS = ('content-type', 'content-length')


def sharp_config():
    url = os.environ.get('DXR_SHARP_URL', '').strip().rstrip('/')
    token = os.environ.get('DXR_SHARP_TOKEN', '').strip()
    if not url or not token:
        return None
    if not url.endswith('/v1/predict'):
        url += '/v1/predict'
    return {'url': url, 'token': token, 'timeout': float(os.environ.get('DXR_SHARP_TIMEOUT', '180'))}


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    sharp = None
    coop = 'same-origin'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # Isolation headers let onnxruntime-web use wasm threads when a build wants them.
        self.send_header('Cross-Origin-Opener-Policy', self.coop)
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter: one line per request, no timestamps
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

    def _json_error(self, status, msg):
        body = json.dumps({'error': msg}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split('?')[0] != SHARP_PATH:
            return self._json_error(404, 'not found')
        cfg = self.sharp
        if not cfg:
            return self._json_error(503, 'SHARP proxy not configured (set DXR_SHARP_URL and DXR_SHARP_TOKEN)')
        ctype = self.headers.get('Content-Type', '')
        if not ctype.startswith('multipart/form-data'):
            return self._json_error(415, 'expected multipart/form-data')
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_UPLOAD:
            return self._json_error(413 if n > MAX_UPLOAD else 411, 'bad Content-Length')
        body = self.rfile.read(n)
        req = urllib.request.Request(cfg['url'], data=body, method='POST', headers={
            'Content-Type': ctype,  # keeps the multipart boundary
            'Authorization': 'Bearer ' + cfg['token'],
        })
        t0 = time.time()
        try:
            up = urllib.request.urlopen(req, timeout=cfg['timeout'])
        except urllib.error.HTTPError as e:
            detail = e.read(300).decode('utf-8', 'replace')
            sys.stderr.write('sharp-proxy: upstream %d after %.1fs\n' % (e.code, time.time() - t0))
            # 401/403 upstream = OUR token is wrong: say so as a 502, never as the page's own auth failure.
            status = 502 if e.code in (401, 403) else e.code
            return self._json_error(status, 'upstream %d: %s' % (e.code, detail))
        except Exception as e:  # timeout, DNS, connection refused
            sys.stderr.write('sharp-proxy: upstream failed after %.1fs: %s\n' % (time.time() - t0, type(e).__name__))
            return self._json_error(504 if 'timed out' in str(e) else 502, 'upstream unreachable: %s' % type(e).__name__)
        with up:
            self.send_response(up.status)
            for k, v in up.headers.items():
                kl = k.lower()
                if kl in PASS_HEADERS or kl.startswith('x-sharp-') or kl.startswith('x-dxr-sharp'):
                    self.send_header(k, v)
            self.end_headers()
            sent = 0
            while True:
                chunk = up.read(1 << 16)
                if not chunk:
                    break
                self.wfile.write(chunk)
                sent += len(chunk)
        sys.stderr.write('sharp-proxy: %d bytes in, %d bytes out, %.1fs\n' % (n, sent, time.time() - t0))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    port = int(args[0]) if args else 8812
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    NoCacheHandler.sharp = sharp_config()
    if '--allow-popups' in flags:
        NoCacheHandler.coop = 'same-origin-allow-popups'
    if '--sharp' in flags and not NoCacheHandler.sharp:
        sys.exit('--sharp: set DXR_SHARP_URL and DXR_SHARP_TOKEN (see the docstring)')
    handler = partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as srv:
        print(f'serving {root} on http://127.0.0.1:{port}/samples/lift/index.html  (no-store)')
        if NoCacheHandler.sharp:
            # the host only: never the token
            host = urllib.parse.urlparse(NoCacheHandler.sharp['url']).netloc
            print(f'SHARP proxy: POST {SHARP_PATH} -> {host}/v1/predict (demo only; Apple research licence)')
        srv.serve_forever()
