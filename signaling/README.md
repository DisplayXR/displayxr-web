# `dxr-signal/1` — signalling for `@displayxr/inline3d/call`

A small JSON-over-WebSocket protocol that gets up to four browsers into the same call and relays
their WebRTC offers, answers and ICE candidates. It never carries media (that is peer-to-peer,
DTLS-SRTP) and keeps nothing once a room is empty.

| File | What |
|---|---|
| [`room.mjs`](room.mjs) | The room logic. Shared as-is by both servers below, so they cannot drift. |
| [`worker.mjs`](worker.mjs) + [`wrangler.toml`](wrangler.toml) | Reference server: a Cloudflare Worker + one Durable Object per room (hibernating WebSockets). **A template, not deployed.** |
| [`dev-server.mjs`](dev-server.mjs) | A zero-dependency Node server with the same protocol, for local work and the test suite. Not for production. |

Client side: `dxrSignaling(url)` in [`js/call/signaling.js`](../js/call/signaling.js). Any other
transport can be plugged into `addCall` by implementing the `SignalingAdapter` interface
(`call.d.ts`); this protocol is just the one the SDK ships.

## Local development

```sh
node signaling/dev-server.mjs            # ws://localhost:8787 (flags: --port, --host, --cap)
python3 -m http.server 8000              # from the repo root
# open http://localhost:8000/samples/call/ (the sample defaults to ws://localhost:8787 on localhost)
```

`getUserMedia` needs a secure context: `localhost` counts; a LAN IP over plain `http` does not.

## Protocol

**Connect** to `<base>/v1/connect?k=<key>`, where `key` is the lowercase hex SHA-256 of the room id.
The room itself never appears in a URL (and so never in an access log): it travels in the `join`
message, and the server checks it against the key it was addressed by. The client's invite link
carries the room in its `#room=` fragment, which browsers never send to any server.

Every message is one JSON object with a `t` field.

### Client → server

| `t` | Fields | Meaning |
|---|---|---|
| `join` | `v: 1`, `room`, `id`, `max?` | Join `room` (16–64 base64url chars; generated rooms are 22 chars = 128 random bits) as peer `id` (8–32 base64url chars, chosen by the client, stable across reconnects). `max` = the room size the first joiner asks for, clamped to the server's cap. One join per connection. |
| `signal` | `to`, `data` | Relay `data` (an opaque object: offer / answer / candidate / restart / bye) to peer `to` in the same room. |
| `leave` | — | Leave; the server closes the socket. Closing the socket is equivalent. |
| `ping` | — | Keep-alive (the client sends one every 20 s). |

### Server → client

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `v: 1`, `id`, `peers: string[]`, `max`, `iceServers?` | Joined. `peers` are the ids already in the room. `iceServers` = short-lived TURN credentials, if the server has TURN configured. |
| `full` | `max` | The room already has `max` peers. The server closes the socket (4003). |
| `peer-joined` | `id` | Someone joined after you. |
| `peer-left` | `id` | Someone left (or their socket dropped). |
| `signal` | `from`, `data` | Relayed from `from`. |
| `pong` | — | Reply to `ping`. |
| `error` | `code`, `message` | `bad-message`, `bad-version`, `bad-room`, `bad-id`, `id-taken`, `already-joined`, `not-joined`, `no-such-peer`, `too-big`, `rate-limited`. The fatal ones (`bad-*`, `id-taken`, `rate-limited`) close the socket (4000). |

Limits: 64 KiB per message; 300 messages per 10 s per connection; server room cap `MAX_PEERS`
(default 4, never above 8 — a full mesh stops scaling at 4 anyway). The Node server also drops a
socket idle for 60 s.

### What the SDK puts in `signal.data`

Informational — the server does not look inside. `{ kind: 'offer' | 'answer', sdp, gen }`,
`{ kind: 'candidate', candidate, gen }`, `{ kind: 'restart', gen }` (the answerer asks the offerer
to rebuild), `{ kind: 'bye', gen }`. Of each pair, the lexically smaller peer id is the offerer;
`gen` is the connection generation, so a late candidate from a rebuilt connection is dropped.

### Reconnects

If the signalling socket drops mid-call, the client reconnects with backoff and re-joins with the
**same** `id`. Media already flowing peer-to-peer is not interrupted: a pair whose connection is
still up survives a `peer-left` from the server, and a pair that was also cut is rebuilt once
both sides are back.

## Cloudflare deployment (template)

1. Copy `wrangler.toml`, set `name` (and routes / a custom domain) for your account.
2. Optional: set `ALLOWED_ORIGINS` to the origins of your pages (comma-separated).
3. Optional TURN (≈10–20% of networks need a relay), with [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/):
   - `TURN_KEY_ID` — the TURN key's id (a var or a secret).
   - `TURN_KEY_API_TOKEN` — its API token. **A secret:** `wrangler secret put TURN_KEY_API_TOKEN`.
     Never in `wrangler.toml`, never in a client.
   - `TURN_TTL` — lifetime of the credentials handed to each joining client, seconds (60–86400, default 3600).

   Each `join` makes the Worker mint credentials (`POST /v1/turn/keys/<id>/credentials/generate-ice-servers`)
   and return them in `welcome`. The same variables work for `dev-server.mjs`.
4. `wrangler deploy`, then `dxrSignaling('wss://<your-worker-host>')`.

Where DisplayXR hosts its own instance (and so what a default `dxrSignaling()` would point at) is
an open question in RFC 0002; until then the URL is required.
