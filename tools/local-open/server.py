"""127.0.0.1 file server for DisplayXR local HTML.

Loopback is a secure context, so inline-3d / WebXR can run. file:// cannot.
Only mounts written by launch.py are served; the process binds localhost only.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = 17880
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", ".")) / "DisplayXR" / "local-open"
MOUNTS_PATH = STATE_DIR / "mounts.json"
PID_PATH = STATE_DIR / "server.pid"

# Samples load glTF / splats / video; stock types miss several of these.
EXTRA_TYPES = {
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".spz": "application/octet-stream",
    ".ply": "application/octet-stream",
    ".ksplat": "application/octet-stream",
    ".ktx2": "image/ktx2",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
}


def load_mounts() -> dict[str, Path]:
    try:
        data = json.loads(MOUNTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for token, raw in data.items():
        if isinstance(token, str) and token.isalnum() and isinstance(raw, str):
            p = Path(raw)
            if p.is_dir():
                out[token] = p.resolve()
    return out


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/__dxr/health":
            body = json.dumps({"ok": True, "pid": os.getpid()}).encode("ascii")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404, "Directory listing disabled")
        return None

    def translate_path(self, path):
        path = unquote(path.split("?", 1)[0])
        parts = [p for p in path.split("/") if p and p != "."]
        if not parts or ".." in parts:
            return str(STATE_DIR / "__no_such_file__")
        token, *rest = parts
        root = load_mounts().get(token)
        if root is None:
            return str(STATE_DIR / "__no_such_file__")
        candidate = (root.joinpath(*rest) if rest else root).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return str(STATE_DIR / "__no_such_file__")
        return str(candidate)


def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    for ext, mime in EXTRA_TYPES.items():
        mimetypes.add_type(mime, ext)

    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    PID_PATH.write_text(str(os.getpid()), encoding="ascii")
    try:
        httpd.serve_forever()
    finally:
        try:
            if PID_PATH.read_text(encoding="ascii").strip() == str(os.getpid()):
                PID_PATH.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        main()
    except OSError as exc:
        sys.stderr.write(f"local-open server failed: {exc}\n")
        sys.exit(1)
