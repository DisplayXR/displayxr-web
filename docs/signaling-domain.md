# Moving signalling to `signal.displayxr.org` (RFC 0003 §5g) — options and the recommendation

**Status (2026-10-06): the domain is live and the SDK default has moved.**

| Step | State |
|---|---|
| Worker custom domain `signal.displayxr.org` (steps 3–4 below; how the zone reaches Cloudflare is not recorded here) | **DONE 2026-10-06.** The same `dxr-signal` deployment answers on both hosts; `/health` and a real join return identical results on `signal.displayxr.org` and `dxr-signal.displayxr.workers.dev`. |
| SDK flip (step 5) | **DONE in the release after 1.32.0:** `DXR_SIGNAL_DEFAULT` is `wss://signal.displayxr.org` and `DXR_SIGNAL_ALIASES` is `[signal.displayxr.org, dxr-signal.displayxr.workers.dev]`. |
| Record the custom domain in `signaling/deploy/displayxr.toml` | **Open.** The toml has no `routes` entry yet; its header comment still calls the new host the "target". |
| Retire `dxr-signal.displayxr.workers.dev` | **Open, not before** two minor releases after the flip AND negligible traffic on that host in the Worker's analytics; a CHANGELOG notice ships first. SDKs ≤ 1.32 default to that host (and fail over to the new one), so retiring it early would cost every such page one failed connect per join. |
| `call.displayxr.org` for the demo (step 6) | not covered by this page's change |

The rest of this page is the plan as written before the cut-over, kept for the reasoning.

## The constraint

The hosted server is a Cloudflare Worker (`dxr-signal`, account `ee1192962dfd260c76dd37d7b97d90c8`),
reachable today as `wss://dxr-signal.displayxr.workers.dev`. The `displayxr.org` zone's DNS is on
**Vercel** (the website lives there). A Worker answers on a custom hostname only through a
**Workers custom domain** or a **route**, and both need the hostname's zone to be **on Cloudflare**:

| How a non-Cloudflare zone could reach a Worker | Plan needed | Verdict |
|---|---|---|
| **CNAME (partial) setup** — keep DNS at Vercel, CNAME `signal` to Cloudflare | Business or Enterprise | too expensive for a `wss://` alias |
| **Subdomain setup** — delegate only `signal.displayxr.org` to Cloudflare by NS records (Vercel DNS *does* support NS records for a subdomain) | **Enterprise only** | not available |
| **A Vercel-side proxy** (rewrite `signal.displayxr.org` → the Worker) | — | Vercel rewrites do not carry WebSockets |
| **Full setup** — the whole zone's DNS on Cloudflare (Free plan), Vercel keeps serving the site via ordinary A/CNAME records | Free | **recommended** |
| Keep `workers.dev` | — | works for ever; the brand/host move is cosmetic plus future-proofing |

Sources: Cloudflare *Subdomain setup* (Enterprise), *CNAME setup* (Business+), Vercel DNS record
types (A, AAAA, ALIAS, CAA, CNAME, HTTPS, MX, NS, SRV, TXT).

## Recommendation: move the zone's DNS to Cloudflare (Free), leave the site on Vercel

Vercel does not need to be the DNS host: a domain on Vercel is served from any DNS provider with
an `A` record at the apex (`76.76.21.21`) and a `CNAME` for `www` / other hosts
(`cname.vercel-dns.com`). The one Vercel feature that depends on Vercel DNS — wildcard
certificates / preview-deployment suffixes — has a documented workaround (delegate
`_acme-challenge` to Vercel with NS records, which Cloudflare DNS can hold) if it is ever wanted.

Steps (half a day, no SDK release required):

1. Cloudflare → *Add a site* → `displayxr.org`, Free plan. Let it import the current records, then
   check them against Vercel's DNS page record by record (apex `A`, `www` `CNAME`, MX/TXT for mail
   and verification, `call` for the demo). Leave the Vercel-pointing records **DNS-only** (grey
   cloud) so Vercel keeps terminating TLS for the site; do not proxy them.
2. At the registrar, switch the nameservers to the two Cloudflare assigns. Propagation is hours;
   nothing breaks while both answer the same records.
3. Workers → `dxr-signal` → *Settings* → *Domains & Routes* → add custom domain
   `signal.displayxr.org` (Cloudflare creates the DNS record and the certificate). Equivalent in
   config, then deploy:
   ```toml
   # signaling/deploy/displayxr.toml
   routes = [{ pattern = "signal.displayxr.org", custom_domain = true }]
   ```
   The **same Worker** answers on both hosts, so rooms are shared: a caller on the old URL meets one
   on the new.
4. Verify: `curl https://signal.displayxr.org/` → `{"ok":true,…}`; a two-page call with
   `signaling="wss://signal.displayxr.org"`.
5. SDK: swap the order of `DXR_SIGNAL_ALIASES` (and `DXR_SIGNAL_DEFAULT`) in the next **minor**
   release. *(Done in the release after 1.32.0 — both changed: the adapter always tries the URL it
   was given first, so flipping the list alone would not have moved the default's first connect.)* `dxr-signal.displayxr.workers.dev` stays live as an alias for at least two minor
   releases and until its traffic (Worker analytics by host) is negligible; retirement gets a
   CHANGELOG notice first.
6. `call.displayxr.org` for the demo stays a Vercel host (a `CNAME` on Cloudflare DNS); the App
   Link / association files are served from there (RFC §3c).

Risk notes: (a) a missed MX/TXT record is the classic migration failure — diff the zone export
before switching nameservers; (b) the Vercel project keeps its domain configured as today, only the
nameservers move; (c) if the Free plan's proxy ever gets in the way, every record can stay
DNS-only — only the Worker's own hostname is proxied, and Cloudflare manages that one.

## What was put in place before the cut-over (the preparing PR)

- **Client failover:** `DXR_SIGNAL_ALIASES = [DXR_SIGNAL_DEFAULT, 'wss://signal.displayxr.org']` (then; the default was the workers.dev host)
  (internal: `js/call/signaling.js`, not a `./call` export — the public surface is the 9 C2 exports;
  pages see the failover through `dxrSignaling()` alone).
  `dxrSignaling()` (the hosted default) tries the aliases in order whenever a host is unreachable,
  on the first join and on every reconnect, and remembers the one that worked. A self-hosted URL
  is tried as given (`aliases` adds fallbacks). `DXR_SIGNAL_DEFAULT` was unchanged then; the
  flip (status table above) changed it to the new host and put workers.dev second.
- **Server:** one Worker, any number of hosts; nothing in the protocol or the config keys on the
  hostname. Adding the route is the only Worker change.
- **Docs** (`docs/call.md`, `signaling/README.md`) name both hosts.
