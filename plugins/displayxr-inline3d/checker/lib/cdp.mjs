// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe.
//
// Zero dependencies on purpose: the checker must run with nothing but Node and a local Chrome, so
// an agent can call it without an `npm install`. The pipe transport also means no TCP port is
// opened at all (no clash with any other debugger on the box), and the browser is a child process
// we own: close() ends exactly that pid and removes its throwaway profile.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CHROME = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const p of DEFAULT_CHROME[process.platform] || []) if (existsSync(p)) return p;
  return null;
}

export async function launchChrome({ chrome = findChrome(), extraArgs = [], width = 1280, height = 800 } = {}) {
  if (!chrome || !existsSync(chrome)) {
    throw new Error(`Chrome not found${chrome ? ` at ${chrome}` : ''}. Set CHROME=/path/to/chrome.`);
  }
  const profile = mkdtempSync(join(tmpdir(), 'inline3d-check-'));
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--hide-scrollbars',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', // a software WebGL fallback where there is no GPU (CI)
    `--window-size=${width},${height}`,
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const conn = new Connection(proc.stdio[3], proc.stdio[4]);
  let exited = false;
  const exitPromise = new Promise((r) => proc.once('exit', () => { exited = true; r(); }));
  proc.once('error', (e) => conn._fail(e));
  exitPromise.then(() => conn._fail(new Error(`Chrome exited. ${stderr.split('\n').slice(-5).join(' ')}`)));

  // First round trip proves the pipe is up.
  try {
    await withTimeout(conn.send('Browser.getVersion'), 15000, 'Chrome did not answer on the DevTools pipe');
  } catch (e) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`${e.message}. Chrome stderr: ${stderr.split('\n').slice(-6).join(' | ')}`);
  }

  async function close() {
    try {
      if (!exited) await withTimeout(conn.send('Browser.close'), 3000, 'Browser.close');
    } catch {
      /* fall through to the kill */
    }
    if (!exited) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await withTimeout(exitPromise, 5000, 'chrome exit').catch(() => {});
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { conn, proc, pid: proc.pid, close, stderr: () => stderr };
}

export function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

class Connection {
  constructor(write, read) {
    this._w = write;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map(); // `${sessionId}|${method}` -> Set<fn>
    this._dead = null;
    let buf = '';
    read.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (msg) this._onMessage(msg);
      }
    });
  }
  _fail(err) {
    if (this._dead) return;
    this._dead = err;
    for (const { rej } of this._pending.values()) rej(err);
    this._pending.clear();
  }
  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined) {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}${m.error.data ? ` (${m.error.data})` : ''}`));
      else p.res(m.result);
      return;
    }
    const set = this._listeners.get(`${m.sessionId || ''}|${m.method}`);
    if (set) for (const fn of [...set]) { try { fn(m.params || {}); } catch { /* listener bug: ignore */ } }
  }
  send(method, params = {}, sessionId) {
    if (this._dead) return Promise.reject(this._dead);
    const id = ++this._id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this._pending.set(id, { res, rej, method });
      this._w.write(JSON.stringify(msg) + '\0');
    });
  }
  on(method, fn, sessionId = '') {
    const k = `${sessionId}|${method}`;
    if (!this._listeners.has(k)) this._listeners.set(k, new Set());
    this._listeners.get(k).add(fn);
    return () => this._listeners.get(k)?.delete(fn);
  }
  /** A page in its own browser context (fresh cache/storage), attached in flatten mode. */
  async newPage() {
    const { browserContextId } = await this.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = {
      sessionId,
      send: (m, p) => this.send(m, p, sessionId),
      on: (m, fn) => this.on(m, fn, sessionId),
      close: async () => {
        try { await this.send('Target.closeTarget', { targetId }); } catch { /* gone */ }
        try { await this.send('Target.disposeBrowserContext', { browserContextId }); } catch { /* gone */ }
      },
    };
    return page;
  }
}
