# RunPod serverless handler for the hosted inline3d checker.
#
# input.mode:
#   "warm"         return at once (the front end sends this so a worker is up before the first check)
#   "check"        input.url: a public http(s) page
#   "check_files"  input.files: [{path, content}] - the page's own files, served on 127.0.0.1 to this
#                  worker's Chrome only, deleted when the job ends
# Options for both checks: max_texture, viewport ("WxH"), fallback (bool).
# Nothing is stored: the report goes back in the job output and the job's files are removed.
import json, os, re, secrets, shutil, subprocess, tempfile, time, urllib.request
import runpod

BOOT = time.time()
CLI = "/app/node_modules/@displayxr/inline3d-tools/bin/inline3d-tools.mjs"
TOKEN = secrets.token_hex(16)
PROXY = subprocess.Popen(["node", "/app/guard-proxy.mjs"], env={**os.environ, "GUARD_PROXY_TOKEN": TOKEN})
MAX_FILES, MAX_BYTES = 60, 4 * 1024 * 1024
SAFE_PATH = re.compile(r"^(?!/)(?!.*(^|/)\.\.(/|$))[A-Za-z0-9._/-]{1,200}$")

def reset_proxy():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:8899/__reset?t={TOKEN}", timeout=2).read()
    except Exception:
        pass

def trim(report):
    for c in report.get("checks", []):
        d = c.get("details")
        if d is not None and len(json.dumps(d)) > 2000:
            c["details"] = {"truncated": json.dumps(d)[:2000]}
    return report

def run_cli(target, inp, cwd=None):
    args = ["node", CLI, "check", target, "--json"]
    if inp.get("max_texture"): args += ["--max-texture", str(int(inp["max_texture"]))]
    if inp.get("viewport") and re.match(r"^\d{3,4}x\d{3,4}$", inp["viewport"]): args += ["--viewport", inp["viewport"]]
    if inp.get("fallback") is False: args += ["--no-fallback"]
    reset_proxy()
    r = subprocess.run(args, capture_output=True, text=True, timeout=150, cwd=cwd,
                       env={**os.environ, "CHROME": "/app/chrome-gpu.sh", "HOME": "/tmp"})
    try:
        return trim(json.loads(r.stdout))
    except Exception:
        return {"verdict": "error", "error": (r.stderr or r.stdout)[-1500:]}

def handler(job):
    inp = job.get("input") or {}
    mode = inp.get("mode")
    t0 = time.time()
    meta = lambda: {"checkSeconds": round(time.time() - t0, 1), "workerAgeSeconds": round(time.time() - BOOT, 1)}
    if mode == "warm":
        return {"warm": True, **meta()}
    if mode == "check":
        url = str(inp.get("url", ""))
        if not re.match(r"^https?://", url):
            return {"verdict": "error", "error": "url must be http(s)"}
        return {"report": run_cli(url, inp), **meta()}
    if mode == "check_files":
        files = inp.get("files") or []
        if not isinstance(files, list) or not files or len(files) > MAX_FILES:
            return {"verdict": "error", "error": f"files: 1 to {MAX_FILES} entries"}
        if sum(len(str(f.get("content", ""))) for f in files) > MAX_BYTES:
            return {"verdict": "error", "error": f"files: {MAX_BYTES // 1024 // 1024} MB at most in total"}
        d = tempfile.mkdtemp(prefix="page-")
        try:
            for f in files:
                p = str(f.get("path", ""))
                if not SAFE_PATH.match(p):
                    return {"verdict": "error", "error": f"bad path {p!r}: relative, letters/digits/._-/ only"}
                full = os.path.join(d, p)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w", encoding="utf-8") as fh:
                    fh.write(str(f.get("content", "")))
            entry = str(inp.get("entry") or "index.html")
            if not SAFE_PATH.match(entry) or not os.path.isfile(os.path.join(d, entry)):
                return {"verdict": "error", "error": f"entry {entry!r} is not one of the files"}
            rep = run_cli(os.path.join(d, entry), inp, cwd=d)
            rep.pop("target", None)  # a temp path, meaningless to the caller
            return {"report": rep, **meta()}
        finally:
            shutil.rmtree(d, ignore_errors=True)
    return {"verdict": "error", "error": f"unknown mode {mode!r}"}

runpod.serverless.start({"handler": handler})
