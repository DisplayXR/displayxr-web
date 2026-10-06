# `dxr-signal/1` — signalling for `@displayxr/inline3d/call`

A small JSON-over-WebSocket protocol that gets up to four browsers into the same call and relays
their WebRTC offers, answers and ICE candidates. It never carries media (that is peer-to-peer,
DTLS-SRTP) and keeps nothing once a room is empty.

| File | What |
|---|---|
| [`room.mjs`](room.mjs) | The room logic. Shared as-is by both servers below, so they cannot drift. |
| [`gate.mjs`](gate.mjs) | Admission for one connect: key + origin ([`keys.mjs`](keys.mjs)), blocklist, join rate + room leases ([`limits.mjs`](limits.mjs)), the TURN budget ([`turn-budget.mjs`](turn-budget.mjs)). Shared too. |
| [`worker.mjs`](worker.mjs) + [`wrangler.toml`](wrangler.toml) | Reference server: a Cloudflare Worker + Durable Objects (one per room, hibernating WebSockets; one per rate-limit subject; one budget) + a KV namespace for keys. The template is for self-hosting; [`deploy/displayxr.toml`](deploy/displayxr.toml) is the hosted DisplayXR instance and [`deploy/staging.toml`](deploy/staging.toml) its staging twin. |
| [`dev-server.mjs`](dev-server.mjs) | A zero-dependency Node server with the same protocol **and the same admission** (limits, keys, budget — in memory), for local work and the test suite. Not for production. |
| [`../tools/signal-keys.mjs`](../tools/signal-keys.mjs) | Issue / revoke / list publishable keys and block IPs, by hand, through `wrangler kv`. |

Client side: `dxrSignaling(url, { key })` in [`js/call/signaling.js`](../js/call/signaling.js). Any
other transport can be plugged into `addCall` by implementing the `SignalingAdapter` interface
(`call.d.ts`); this protocol is just the one the SDK ships.

**Hosted instance:** `wss://dxr-signal.displayxr.workers.dev` today, `wss://signal.displayxr.org`
once the zone moves ([`docs/signaling-domain.md`](../docs/signaling-domain.md)); the same Worker
answers on every host and the SDK fails over between them (`DXR_SIGNAL_ALIASES` in
`js/call/signaling.js`, internal). What it sees and
keeps: [`docs/privacy-call.md`](../docs/privacy-call.md).

## Local development

```sh
node signaling/dev-server.mjs            # ws://localhost:8787 (flags: --port, --host, --cap, --keys keys.json)
python3 -m http.server 8000              # from the repo root
# open http://localhost:8000/samples/call/ (the sample defaults to ws://localhost:8787 on localhost)
```

`getUserMedia` needs a secure context: `localhost` counts; a LAN IP over plain `http` does not.
The dev server applies the same limits as the hosted server (env vars below); for a flood test
set e.g. `ANON_JOINS_PER_MIN=3`.

## Protocol

**Connect** to `<base>/v1/connect?k=<key>[&key=<pk_…>]`, where `k` is the lowercase hex SHA-256 of
the room id and `key` an optional publishable key (§ *Access*). The room itself never appears in a
URL (and so never in an access log): it travels in the `join` message, and the server checks it
against the hash it was addressed by. The client's invite link carries the room in its `#room=`
fragment, which browsers never send to any server.

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
| `welcome` | `v: 1`, `id`, `peers: string[]`, `max`, `iceServers?`, `tier`, `key?`, `turn` | Joined. `peers` are the ids already in the room. `iceServers` = short-lived TURN credentials, when the server minted some for this session. `tier` = `'anon'` or `'key'`; `key` = the key id this session is attributed to; `turn` = `{ status, reason?, ttl? }` — the service-wide relay-budget state (`ok` / `degraded` / `off`) and, when there are no credentials, why: `unconfigured` (no TURN on this server), `budget` (anonymous session shed near the budget), `rate` (too many mints from this address), `cap` (the monthly cap — everyone), `mint-failed`. |
| `full` | `max` | The room already has `max` peers. The server closes the socket (4003). |
| `expired` | — | The room's lifetime is up (2 h anonymous / 8 h keyed, from its first join). The server closes every peer's socket (4004). Media already flowing is not touched. |
| `peer-joined` | `id` | Someone joined after you. |
| `peer-left` | `id` | Someone left (or their socket dropped). |
| `signal` | `from`, `data` | Relayed from `from`. |
| `pong` | — | Reply to `ping`. |
| `error` | `code`, `message`, `retryMs?` | See the table below. |

| `error.code` | When | Closes the socket with |
|---|---|---|
| `bad-message`, `bad-version`, `bad-room`, `bad-id`, `id-taken`, `too-big` | the join or a message is malformed / cannot be honoured | 4000 (`bad-message`, `too-big`, `not-joined`, `already-joined`, `no-such-peer` do not close) |
| `rate-limited` | more than 300 messages in 10 s on one connection (4000); **or**, at connect, more joins per minute from this address than the tier allows — `retryMs` says when the window reopens | 4029 |
| `quota` | at connect: this address (anonymous) or this key already has its maximum number of open rooms | 4030 |
| `bad-key` | `?key=` is malformed, unknown or revoked | 4001 |
| `origin-not-allowed` | the key exists but the page's `Origin` is not on its list (a non-browser client with no `Origin` never matches a key with a list) | 4001 |
| `blocked` | the address is on the blocklist | 4040 |

A refused connect is still a real WebSocket for a moment: the server accepts it, sends the one
`error`, and closes with the code above — so a client always learns why, never hangs.

### What the SDK puts in `signal.data`

Informational — the server does not look inside. `{ kind: 'offer' | 'answer', sdp, gen }`,
`{ kind: 'candidate', candidate, gen }`, `{ kind: 'restart', gen }` (the answerer asks the offerer
to rebuild), `{ kind: 'bye', gen }`. Of each pair, the lexically smaller peer id is the offerer;
`gen` is the connection generation, so a late candidate from a rebuilt connection is dropped.

### Reconnects

If the signalling socket drops mid-call, the client reconnects with backoff and re-joins with the
**same** `id`. Media already flowing peer-to-peer is not interrupted: a pair whose connection is
still up survives a `peer-left` from the server, and a pair that was also cut is rebuilt once
both sides are back. A `rate-limited` / `quota` refusal on a reconnect is retried no sooner than
its `retryMs`; `bad-key`, `origin-not-allowed`, `blocked` and `expired` end the session.

## Access: anonymous tier and publishable keys (RFC 0003 §5a)

| | Anonymous (no key) | Publishable key `pk_…` |
|---|---|---|
| Who | demos, localhost, the playground, first five minutes | a page that ships |
| Origin check | none | the key's origin list, checked on `Origin` at connect |
| TURN | yes, 600 s credentials, first to be shed under budget pressure | yes, 3600 s |
| Limits | tight (below) | 10× the anonymous limits; adjustable per key |
| Obtain | nothing | issued by hand (`tools/signal-keys.mjs`), revocable |

A key is **public** (it sits in page source): attribution + a quota bucket + an origin binding
that browsers enforce. A non-browser client can forge `Origin`, which is why quotas, not the key,
are the actual protection. No secret ever goes in a client. Every session carries its key id, so
usage is attributable per key from day one (billing identity; billing is off).

Key records live in the Worker's `KEYS` KV namespace as `key:<pk_…>` → JSON:

```json
{ "id": "pk_…", "origins": ["https://app.example", "https://*.example.com", "http://localhost"],
  "note": "Acme storefront", "createdAt": "2026-10-03T…", "revoked": false,
  "limits": { "rooms": 100, "joinsPerMin": 400, "mintsPerHour": 600, "turnTtl": 7200, "roomTtlS": 43200 } }
```

Origins: exact; one-label wildcard (`https://*.example.com`); `http://localhost` / `http://127.0.0.1`
(any port); `*` (any origin — attribution only). `limits` overrides the keyed tier's numbers for
that key alone. KV is eventually consistent (~60 s).

**Admin recipe (by hand):**

```sh
node tools/signal-keys.mjs issue --origins https://app.example,https://*.example.com --note "Acme"   # prints pk_…
node tools/signal-keys.mjs revoke pk_…
node tools/signal-keys.mjs list
node tools/signal-keys.mjs block 203.0.113.9          # IP blocklist (abuse)
# --env staging for the staging Worker; needs a logged-in wrangler, nothing else
```

The same records are reachable over HTTPS when the Worker has an `ADMIN_TOKEN` secret:
`GET|PUT|DELETE /admin/keys/<pk_…>` with `Authorization: Bearer <token>`.

## Limits (RFC 0003 §5b)

| Limit | Anonymous | Keyed | Where it is counted | Env var |
|---|---|---|---|---|
| Joins per IP per minute | 20 | 200 | per-IP meter (separate windows per tier) | `ANON_JOINS_PER_MIN` / `KEY_JOINS_PER_MIN` |
| Concurrent rooms | 5 per IP | 50 per key | per-IP / per-key meter (leases, expire by themselves) | `ANON_ROOMS` / `KEY_ROOMS` |
| Room size | 4 (`MAX_PEERS`) | 4 | room | `MAX_PEERS` |
| Room lifetime | 2 h → `expired` | 8 h | room (alarm, from the first joiner's tier) | `ANON_ROOM_TTL` / `KEY_ROOM_TTL` (seconds) |
| TURN credential mints per IP per hour | 30 | 300 | per-IP meter (over it: the session joins STUN-only, `turn.reason = 'rate'`) | `ANON_MINTS_PER_HOUR` / `KEY_MINTS_PER_HOUR` |
| TURN credential TTL | 600 s | 3600 s | — | `ANON_TURN_TTL` / `TURN_TTL` |
| Messages per connection | 300 / 10 s | same | room | — |
| Message size | 64 KiB | same | room | — |

IPs are never stored: rate-limit state is keyed by a salted SHA-256 prefix of the address
(`RATE_SALT`). The Node server also drops a socket idle for 60 s.

## TURN budget and the monthly cap (RFC 0003 §5c)

Only the ~10–20 % of calls that cannot go peer-to-peer use TURN, and TURN is the only real cost.
The service meters it and enforces an org-wide monthly ceiling: the free tier
(`TURN_FREE_GB`, 1000 GB) plus a **hard cap of `TURN_CAP_USD` = $100** beyond it at
`TURN_PRICE_PER_GB` ($0.05) — **3000 GB a month** by default. Against that budget:

| Month's usage | Status | Anonymous sessions | Keyed sessions |
|---|---|---|---|
| < 70 % | `ok` | TURN, 600 s | TURN, 3600 s |
| 70 – 90 % | `degraded` | TURN, 300 s, 5 mints / IP / h | TURN, 3600 s |
| 90 – 100 % | `degraded` | **no TURN** (`turn.reason = 'budget'`) → SDK `warning` `turn-shed` | TURN, 3600 s |
| ≥ 100 % | `off` | **no TURN** (`turn.reason = 'cap'`) → SDK `error` `turn-cap` | **no TURN** (`cap`) → `turn-cap` |

Direct P2P keeps working throughout — the welcome simply carries no `iceServers` — and relays
already allocated run until their credentials expire. The health endpoint reports
`turn: "ok" | "degraded" | "off" | "unconfigured"`.

**How the usage figure is read.** Two figures exist, and the service uses the better one it has:

- **Estimated** (always): every mint records `(key, ttl)`; `estimatedGB = Σ ttl-hours ×
  TURN_EST_GB_PER_TTL_HOUR` (default 0.3 GB, ≈ 15 % of sessions relaying ~3.5 Mbps both ways).
  Crude on purpose: a credential may relay nothing, or for its whole TTL.
- **Actual** (when configured): Cloudflare exposes relay bytes per TURN key and per
  `customIdentifier` through the GraphQL analytics dataset `callsTurnUsageAdaptiveGroups`
  (`sum { egressBytes ingressBytes }`, filter `keyId`, `date_geq/date_leq`). Every credential is
  minted with `customIdentifier = <key id | anon>`, so the figure is per key. The Worker's hourly
  cron (`17 * * * *`) polls it and stores month-to-date GB in the Budget object; a figure younger
  than 3 h is what counts, else the estimate. Needs two secrets: `CF_ANALYTICS_API_TOKEN` (an API
  token with *Account Analytics: Read*) and `CF_ACCOUNT_ID`. `POST /admin/analytics` polls now.
- **Override** (operator / tests): `POST /admin/usage {"overrideGB": 2850}` (or the
  `TURN_FORCE_USAGE_GB` var) beats both; `{"overrideGB": null}` clears it. `GET /admin/usage`
  shows everything: `usedGB`, `source`, `estimatedGB`, `actualGB`, `fraction`, `status`, and the
  per-key month (`joins`, `mints`, `ttlSeconds`, `actualGB`).

Usage is aggregated **per key and per month** — the business model's billing identity — while
billing itself is off. Nothing here charges anyone.

## Cloudflare deployment (template)

1. Copy `wrangler.toml`, set `name` (and routes / a custom domain) for your account. Create the
   KV namespace (`wrangler kv namespace create dxr-signal-keys`) and paste its id, or drop the
   `[[kv_namespaces]]` block for an anonymous-only server.
2. Optional: set `ALLOWED_ORIGINS` to the origins of your pages (comma-separated) — a
   deployment-wide allowlist on top of per-key origins.
3. Optional TURN (≈10–20 % of networks need a relay), with [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/):
   - `TURN_KEY_ID` — the TURN key's id (a var or a secret).
   - `TURN_KEY_API_TOKEN` — its API token. **A secret:** `wrangler secret put TURN_KEY_API_TOKEN`.
     Never in `wrangler.toml`, never in a client.
   - `TURN_TTL` / `ANON_TURN_TTL` — credential lifetimes (60–86400 s).

   Each admitted `join` makes the Worker mint credentials
   (`POST /v1/turn/keys/<id>/credentials/generate-ice-servers`, with `customIdentifier` = the key
   id) and return them in `welcome`. The same variables work for `dev-server.mjs`.
4. Optional: `wrangler secret put ADMIN_TOKEN` (the `/admin/*` surface), `RATE_SALT`,
   `CF_ANALYTICS_API_TOKEN` + `CF_ACCOUNT_ID` (real usage).
5. `wrangler deploy`, then `dxrSignaling('wss://<your-worker-host>')`.

Health: `GET /` → `{ ok, protocol, turn, keys, limits }`.

## Self-hosting

Self-hosting is first-class and always free (RFC 0003 §5f):

- **Cloudflare**, as above — your account, your TURN key, your limits (every var in
  `wrangler.toml`), your keys. The $100 cap is just a number (`TURN_CAP_USD`).
- **Node**, `node signaling/dev-server.mjs` — the same protocol and limits in one process, rooms
  and counters in memory, no TLS (put it behind a TLS-terminating proxy: `wss://` is required from
  an `https://` page). Fine for a small deployment; not multi-process.
- **No TURN at all** (`TURN_KEY_ID` unset): everything works for the ~80–90 % of pairs that can
  connect directly; the rest show as `unreachable` after ~10 s. The welcome says
  `turn: { status: 'off', reason: 'unconfigured' }` and the SDK emits nothing for it.
- **Bring your own TURN (coturn)** — hand the credentials to the widget instead of the server:
  ```sh
  # coturn, static-auth-secret mode (TURN REST API): the server mints time-limited credentials.
  apt install coturn
  cat >/etc/turnserver.conf <<'EOF'
  listening-port=3478
  tls-listening-port=5349
  realm=turn.example.com
  use-auth-secret
  static-auth-secret=<a long random secret>
  cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
  pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
  fingerprint
  no-multicast-peers
  EOF
  ```
  Mint credentials in your backend (never in the page): `username = <expiry unix ts>:<anything>`,
  `credential = base64(HMAC-SHA1(static-auth-secret, username))`, and pass them to the widget as
  `iceServers: [{ urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username, credential }]`
  (`mountCall(el, { iceServers })`; they override whatever the signalling server hands out). Or
  plug the same minting into `room.mjs`'s `iceServers` hook if you run the Node server.

**`dxr-signal/1` freezes at the `/call` stable gate** (RFC 0003 §7): self-hosters depend on it
independently of the SDK version. Until then, additions are new optional fields only.

## Staging and the C3 gate

`deploy/staging.toml` is the hosted server's twin (`wss://dxr-signal-staging.displayxr.workers.dev`):
own Durable Objects, own KV, and `TURN_FAKE = "1"` — dummy TURN credentials without any token, so
the whole mint / meter / budget path runs. `test/e2e/signal-staging.e2e.mjs` is the RFC 0003 §7
C3 gate against it (join flood → `rate-limited`, forced 90 % → anonymous shed only, forced cap →
`turn-cap` with a direct headless call still connecting, optional forced relay). It needs the
staging `ADMIN_TOKEN`.
