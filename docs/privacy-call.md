# Privacy — the hosted call signalling service

What the hosted `dxr-signal/1` server behind `@displayxr/inline3d/call` (`wss://signal.displayxr.org`,
also reachable as `wss://dxr-signal.displayxr.workers.dev` — one server, two hostnames) sees,
keeps, and never sees. It is a small relay for the WebRTC handshake plus a credential vendor for TURN; the call itself is peer-to-peer. This page is
the plain-language version of the service's design (RFC 0003 §5); the code is public in
[`signaling/`](../signaling/) and self-hosting it is always free.

## What the server sees

For each connection:

- **The room's hash**, not the room: the connect URL carries the SHA-256 of the room id, so no
  URL, access log or metric ever holds the room itself.
- **The room id**, inside the `join` message — it has to, to check the hash. It is kept in memory
  for the life of the room and never written to a log.
- **Random peer ids** chosen by the browser for this call.
- **The signalling payloads** each peer sends to the others: SDP offers/answers and ICE
  candidates. These contain the peers' **IP addresses**, codecs and DTLS certificate fingerprints.
  The server relays them opaquely and does not store them.
- **The connecting IP address**, the page's **`Origin`** and **`User-Agent`**, and the
  **publishable key** (`pk_…`) if the page sent one.

A TURN relay (used by the ~10–20 % of calls that cannot connect directly) sees the peers' IP
addresses and byte counts. It cannot read the media it relays (DTLS-SRTP).

## What it never sees

**Audio or video.** Media goes browser-to-browser, encrypted (DTLS-SRTP). A relayed call is still
encrypted end to end between the two browsers; the relay forwards ciphertext.

## The honest caveat

The keys that encrypt the media are negotiated through the signalling server (the DTLS
fingerprints ride in the SDP it relays). A **malicious operator** of a signalling server could
therefore substitute its own fingerprints and sit in the middle of a call. That is the standard
WebRTC trust model, and it is why this page does not say "end-to-end encrypted" without this
sentence. A page that needs more than that can self-host the signalling server (below), or — a
future option — verify fingerprints out of band.

## What is kept, and for how long

- **Room state** lives in memory for the life of the room and is dropped when the last peer
  leaves, or when the room's lifetime is up (2 h anonymous, 8 h keyed). There is no database of
  rooms, peers or calls.
- **Rate-limit counters** are keyed by a **salted hash** of the IP address (never the address
  itself) and expire within 24 hours. The join rate, the number of open rooms and the number of
  TURN credentials minted are what they count.
- **Monthly aggregates per key** — joins, credentials minted, and relay gigabytes — are the only
  per-customer record. They identify a key (`pk_…`, which is public and in the page's source), not
  a person, and exist so the service can enforce its relay budget and so usage can be metered per
  key. Nothing is billed today.
- **Request logs:** the Worker's observability is off by default. If it is switched on for an
  incident it is for at most 7 days, and it never contains message bodies (no SDP, no room ids).
- **An IP blocklist** for abuse (below) holds addresses, added by hand, until removed.

## Keys and limits

A publishable key is attribution plus a quota bucket plus an origin binding that browsers enforce.
It carries no secret and grants no access to anything of yours; what it changes is the limits the
service applies and whose budget a relay counts against. Anonymous use (no key) is allowed with
tighter limits. When the service refuses a connection it says why (`rate-limited`, `quota`,
`bad-key`, `origin-not-allowed`, `turn-cap`), never silently.

## Abuse

The server relays only small handshake messages (≤ 64 KiB, rate-limited) and the relay forwards
only encrypted media, so what can be abused is capacity, not content. Resource abuse is handled by
the limits above, key revocation and the IP blocklist. The service never sees the media, so it
cannot moderate it: a report about a specific page goes to that page's operator (for keyed
traffic the page's origin is known). Contact: `abuse@displayxr.org`.

## Self-hosting

Everything above applies to the DisplayXR-hosted instance. The same code runs on your own
Cloudflare account (`signaling/wrangler.toml`, one command) or as a plain Node process
(`signaling/dev-server.mjs`), with your own TURN or none — see
[`signaling/README.md`](../signaling/README.md) § *Self-hosting*. Then nothing about a call
touches DisplayXR at all.
