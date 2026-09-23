"""Open a local HTML file in DisplayXR as http://127.0.0.1 — a secure context.

http(s) and chrome: URLs pass straight through. Local paths / file:// are mounted
on the loopback server (see server.py) so inline-3d can acquire a session.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PORT = 17880
BROWSER = Path(r"C:\Program Files\DisplayXR\Browser\chrome.exe")
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", ".")) / "DisplayXR" / "local-open"
MOUNTS_PATH = STATE_DIR / "mounts.json"
LOG_PATH = STATE_DIR / "launch.log"
HERE = Path(__file__).resolve().parent

PASSTHROUGH = (
    "http://",
    "https://",
    "about:",
    "chrome:",
    "chrome-extension:",
    "devtools:",
    "edge:",
    "data:",
)


def log(msg: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    line = msg.rstrip() + "\n"
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


def strip_arg(arg: str) -> str:
    arg = arg.strip()
    if len(arg) >= 2 and arg[0] == arg[-1] and arg[0] in "\"'":
        arg = arg[1:-1]
    return arg


def coalesce_target(args: list[str]) -> str:
    """Rebuild a path cmd.exe split on spaces (e.g. C:\\Users\\SR Laptop\\file.html).

    Chromium's --single-argument flag treats the rest of the command line as one
    value. open.cmd is not Chromium, so an unquoted %1 becomes several argv
    tokens. Prefer the joined string when that path exists — a truncated first
    token can also exist (this machine has C:\\Users\\SR next to 'SR Laptop').
    """
    parts = [strip_arg(a) for a in args if strip_arg(a)]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    joined = " ".join(parts)
    if Path(joined).exists() or joined.lower().startswith("file:"):
        return joined
    return parts[0]


def is_passthrough(arg: str) -> bool:
    lower = arg.strip().lower()
    return lower.startswith(PASSTHROUGH)


def to_path(arg: str) -> Path | None:
    arg = strip_arg(arg)
    if not arg:
        return None
    if arg.lower().startswith("file:"):
        parsed = urllib.parse.urlparse(arg)
        path = urllib.parse.unquote(parsed.path)
        if parsed.netloc and parsed.netloc.lower() not in ("", "localhost", "127.0.0.1"):
            path = "//" + parsed.netloc + path
        if re.match(r"^/[A-Za-z]:", path):
            path = path[1:]
        return Path(path)
    candidate = Path(arg)
    if candidate.exists() or re.match(r"^[A-Za-z]:[\\/]", arg) or arg.startswith("\\\\"):
        return candidate
    return None


def find_root(html: Path) -> Path:
    """Serve from the project root so ../../js/inline3d.js (samples) resolves.

    Prefer a folder that already has the SDK, then a git root, then the file's
    own directory (standalone HTML).
    """
    start = html.resolve().parent
    found_sdk = None
    cur = start
    seen: set[Path] = set()
    while cur not in seen:
        seen.add(cur)
        if (cur / "js" / "inline3d.js").is_file():
            found_sdk = cur
        if (cur / ".git").exists():
            return found_sdk or cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return found_sdk or start


def token_for(root: Path) -> str:
    norm = str(root.resolve()).replace("\\", "/").lower()
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:10]


def save_mount(token: str, root: Path) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    mounts = {}
    if MOUNTS_PATH.is_file():
        try:
            mounts = json.loads(MOUNTS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            mounts = {}
    mounts[token] = str(root)
    MOUNTS_PATH.write_text(json.dumps(mounts, indent=2), encoding="utf-8")


def server_up() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/__dxr/health", timeout=0.4) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def ensure_server() -> None:
    if server_up():
        return
    creation = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    if os.name == "nt":
        creation |= 0x08000000  # CREATE_NO_WINDOW
    subprocess.Popen(
        [sys.executable.replace("pythonw.exe", "python.exe"), str(HERE / "server.py")],
        cwd=str(STATE_DIR),
        creationflags=creation if os.name == "nt" else 0,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )
    for _ in range(40):
        if server_up():
            return
        time.sleep(0.05)
    raise RuntimeError("local-open server did not start on 127.0.0.1:%s" % PORT)


def open_browser(url: str) -> None:
    if not BROWSER.is_file():
        raise FileNotFoundError(f"DisplayXR Browser not found: {BROWSER}")
    subprocess.Popen([str(BROWSER), "--single-argument", url])


def main(argv: list[str]) -> int:
    args = list(argv)
    no_open = False
    if "--no-open" in args:
        args.remove("--no-open")
        no_open = True
    while args and args[0] in ("--", "--single-argument"):
        args = args[1:]

    if not args:
        if not no_open:
            subprocess.Popen([str(BROWSER)])
        return 0

    target = coalesce_target(args)
    if is_passthrough(target):
        log(f"pass {target}")
        if not no_open:
            open_browser(target)
        return 0

    path = to_path(target)
    if path is None or not path.exists():
        log(f"missing {target}")
        # Last resort: let Chromium try (file:// still won't weave).
        if not no_open:
            open_browser(target)
        return 1

    path = path.resolve()
    if path.is_dir():
        index = path / "index.html"
        path = index if index.is_file() else path

    root = find_root(path if path.is_file() else path)
    token = token_for(root)
    save_mount(token, root)
    ensure_server()

    rel = path.resolve().relative_to(root).as_posix()
    url = f"http://127.0.0.1:{PORT}/{token}/{urllib.parse.quote(rel, safe='/')}"
    log(f"open {path} -> {url}")
    if no_open:
        sys.stdout.write(url + "\n")
        return 0
    open_browser(url)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001 — launcher must not throw into pythonw
        log(f"error {exc}")
        raise
