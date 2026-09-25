#!/usr/bin/env python3
"""Dev server for the lift sample: serves the repo root with NO caching and the right MIME types.

    python3 samples/lift/serve.py [port]      (default 8812, binds 127.0.0.1)

Why not `python -m http.server`: it sends no Cache-Control, so Chrome heuristically caches ES
modules and a `git pull` can leave the page running stale SDK code (seen on the first panel test:
the splat count never changed after a generator fix). It also serves .mjs/.wasm/.onnx with
generic types on some Pythons.
"""
import http.server, mimetypes, os, sys
from functools import partial

mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('application/octet-stream', '.onnx')
mimetypes.add_type('video/webm', '.webm')

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # Isolation headers let onnxruntime-web use wasm threads when a build wants them.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter: one line per request, no timestamps
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8812
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    handler = partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as srv:
        print(f'serving {root} on http://127.0.0.1:{port}/samples/lift/index.html  (no-store)')
        srv.serve_forever()
