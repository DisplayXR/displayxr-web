#!/usr/bin/env node
// signaling/dev-server.mjs — a zero-dependency Node server for the `dxr-signal/1` protocol, for
// local development and the test suite. Same room logic as the Cloudflare Worker (./room.mjs);
// only the socket plumbing differs. NOT for production: one process, rooms in memory, no TLS.
//
//   node signaling/dev-server.mjs [--port 8787] [--cap 4]
//   → ws://localhost:8787/v1/connect?k=<sha256(room)>
//
// Optional TURN (same variables as the Worker): TURN_KEY_ID, TURN_KEY_API_TOKEN, TURN_TTL.
//
// The WebSocket framing below is the minimal RFC 6455 server subset: the upgrade handshake,
// masked client frames (text, continuation, ping/pong, close), unmasked server text frames. That
// is all a JSON signalling channel needs, and it keeps `npm install` out of a dev loop.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Room, DEFAULT_ROOM_CAP, MAX_MESSAGE_BYTES, mintTurnCredentials } from './room.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY_RE = /^[0-9a-f]{64}$/;
const IDLE_MS = 60_000;

/**
 * Start a dev server. Resolves once listening.
 * @param {{port?: number, host?: string, cap?: number, env?: object, log?: (s: string) => void}} [opts]
 * @returns {Promise<{port: number, url: string, rooms: Map<string, Room>, close(): Promise<void>}>}
 */
export function startDevServer({ port = 8787, host = '127.0.0.1', cap = DEFAULT_ROOM_CAP, env = process.env, log = () => {} } = {}) {
  /** @type {Map<string, Room>} */
  const rooms = new Map();
  const sockets = new Set();
  const raw = new Set(); // every upgraded TCP socket, destroyed on shutdown
  const turn = env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN ? () => mintTurnCredentials(env) : null;

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/' || u.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, protocol: 'dxr-signal/1', rooms: rooms.size, turn: !!turn }));
      return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket endpoint: /v1/connect?k=<sha256(room) hex>\n');
  });

  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://x');
    const key = u.searchParams.get('k') || '';
    const wsKey = req.headers['sec-websocket-key'];
    if (u.pathname !== '/v1/connect' || !KEY_RE.test(key) || !wsKey || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(wsKey + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    raw.add(socket);
    socket.on('close', () => raw.delete(socket));
    let room = rooms.get(key);
    if (!room) {
      room = new Room({ key, cap, iceServers: turn });
      rooms.set(key, room);
    }
    const r = room;
    const conn = wrapSocket(socket, {
      onText: (text) => r.onMessage(conn, text).catch(() => {}),
      onClose: () => {
        sockets.delete(conn);
        r.onClose(conn);
        if (r.size === 0 && rooms.get(key) === r) rooms.delete(key);
      },
    });
    sockets.add(conn);
    log(`connect k=${key.slice(0, 8)}… (${rooms.size} rooms)`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: p,
        url: `ws://${host === '0.0.0.0' ? 'localhost' : host}:${p}`,
        rooms,
        close: () =>
          new Promise((done) => {
            for (const c of sockets) c.close(1001, 'server shutting down');
            for (const s of raw) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Wrap a raw upgraded socket as a `{send(obj), close(code, reason)}` connection. */
function wrapSocket(socket, { onText, onClose }) {
  let buf = Buffer.alloc(0);
  let frag = null; // continuation assembly: { chunks: Buffer[] }
  let closed = false;
  let idle = setTimeout(() => conn.close(1001, 'idle'), IDLE_MS);
  const touch = () => {
    clearTimeout(idle);
    // Never re-armed after close: the client's close-frame reply still arrives as data.
    if (!closed) idle = setTimeout(() => conn.close(1001, 'idle'), IDLE_MS);
  };

  const conn = {
    send(obj) {
      if (closed) return;
      socket.write(frame(0x1, Buffer.from(JSON.stringify(obj))));
    },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      const r = Buffer.from(String(reason).slice(0, 100));
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      try {
        socket.end(frame(0x8, p));
      } catch {
        /* ignore */
      }
      // Give the client a moment to answer the close frame, then drop the TCP socket regardless.
      setTimeout(() => socket.destroy(), 1000).unref();
      onClose();
    },
  };

  socket.on('data', (chunk) => {
    if (closed) return;
    touch();
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES * 2)) return conn.close(1009, 'too big');
        len = Number(big);
        off = 10;
      }
      if (!masked) return conn.close(1002, 'client frames must be masked');
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);

      if (op === 0x8) return conn.close(1000, '');
      if (op === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1) frag = { chunks: [] };
        if (!frag) return conn.close(1002, 'unexpected continuation');
        frag.chunks.push(payload);
        const total = frag.chunks.reduce((n, c) => n + c.length, 0);
        if (total > MAX_MESSAGE_BYTES * 2) return conn.close(1009, 'too big');
        if (fin) {
          const text = Buffer.concat(frag.chunks).toString('utf8');
          frag = null;
          onText(text);
        }
        continue;
      }
      return conn.close(1003, 'unsupported frame');
    }
  });
  socket.on('close', () => {
    clearTimeout(idle);
    if (!closed) {
      closed = true;
      clearTimeout(idle);
      onClose();
    }
  });
  socket.on('error', () => socket.destroy());
  return conn;
}

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// CLI
// pathToFileURL: a Windows argv path (C:\…) never string-matches file:///C:/…
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const port = parseInt(arg('port', process.env.PORT || '8787'), 10);
  const cap = parseInt(arg('cap', '4'), 10);
  const host = arg('host', '127.0.0.1');
  startDevServer({ port, cap, host, log: (s) => console.log(`[dxr-signal] ${s}`) }).then((s) => {
    console.log(`[dxr-signal] dev server on ${s.url}/v1/connect (cap ${cap}${process.env.TURN_KEY_ID ? ', TURN on' : ''})`);
  });
}
