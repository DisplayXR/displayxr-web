# inline3d hosted connector

The remote MCP server behind **https://mcp.displayxr.org/mcp**: the inline-3D authoring tools for
assistants that cannot run local tools (claude.ai, ChatGPT, any remote MCP client). It is the
hosted twin of the local [`@displayxr/inline3d-tools`](../../tools/inline3d-tools) stdio server,
and reuses that package (pinned, from npm) for the guide, the templates, the asset check and the
page checker.

| tool | what it does | runs on |
|---|---|---|
| `get_authoring_guide` | the authoring checklist (`AGENTS.md`) with a hosted-use preface | Vercel |
| `scaffold_page` | the esm/vite page template, returned as text | Vercel |
| `check_asset_url` | glTF/GLB budget check on a public URL | Vercel |
| `check_files` | the page checker on the page's own files, passed inline | GPU worker |
| `check_url` | the page checker on a public page URL | GPU worker |
| `get_check_result` | collect a check that outlived the call | GPU worker |

All tools are read-only (`readOnlyHint: true`, `destructiveHint: false`, explicit `openWorldHint`).
Authless. No `gen`: the hosted server never calls paid generators.

## Why `check_files`

Neither claude.ai nor ChatGPT gives a generated page a public URL the checker can load (Claude's
published artifacts run in a sandboxed frame whose CSP blocks cross-origin assets; ChatGPT has no
hosting). So the model sends the files; the worker writes them to a temp dir, the checker serves
them on 127.0.0.1 to its own Chrome, and the dir is deleted when the job ends. Nothing is hosted
or kept. Binary assets must be at public URLs.

## Layout

```
api/mcp.mjs          Vercel function: stateless streamable HTTP, JSON responses
lib/server.mjs       the six tools
lib/budget.mjs       spend estimate, daily/monthly cap, alert, per-IP limits
lib/store.mjs        counters (Neon Postgres in production, memory in tests)
lib/runpod.mjs       RunPod queue-endpoint client
lib/url-guard.mjs    public-URL checks and a fetch that refuses private addresses at connect time
worker/              the GPU worker image (RunPod serverless, queue type)
  Dockerfile         node 22 + Chrome stable + runpod 1.9.1 + @displayxr/inline3d-tools (pinned)
  handler.py         modes: warm | check | check_files
  chrome-gpu.sh      Chrome on the NVIDIA GPU (ANGLE gl-egl), through the guard proxy
  guard-proxy.mjs    Chrome's forward proxy: public addresses only, 200 MB per check
  ip-guard.mjs       the address ranges both sides refuse
public/index.html    the landing page at https://mcp.displayxr.org/
test/                unit tests (npm test) and test/live.mjs (against a deployment)
```

## Cold starts and the warm-up

The endpoint keeps **no** worker running (`workers.min = 0`, `max = 1`, `idleTimeout = 300 s`).
A cold worker takes about a minute (longer the first time a machine pulls the image). To hide it:

- `get_authoring_guide` and `scaffold_page` send a `warm` job when no worker is up, because a check
  usually follows within minutes. The worker then stays up 5 minutes after its last job.
- A check waits up to 40 s in the call. If it is still running, the tool answers `CHECK RUNNING`
  with a `job_id`, the model tells the user, and `get_check_result` collects it (RunPod keeps
  results 30 minutes).

## Cost controls

- **Monthly cap $50, daily cap $50/30, alert at $20** (env `MONTHLY_CAP_USD`, `ALERT_USD`).
  Spend is an estimate: each job is charged the worker-seconds it adds (a 75 s boot when the
  worker was down, the job, the 300 s idle tail), topped up with the real execution time. Over the
  cap, check tools refuse and point at the free local checker; guide and scaffold keep working.
- **Hard ceiling on RunPod:** one worker at most, 180 s per job, so even a broken estimator cannot
  run more than one GPU.
- **Per-IP:** 30 checks an hour, 120 a day. claude.ai and ChatGPT call from their own servers, so
  this mainly limits direct clients; the global budget is the real cap.
- The alert goes to the Vercel log (`ALERT ...`) and, if set, `ALERT_WEBHOOK_URL` (Slack-style
  `{text}` POST).

## Safety

- Only http(s) URLs; no credentials in URLs; localhost, `.local`, `.internal` and private,
  loopback, link-local, CGNAT, metadata and other special ranges refused (IPv4 and IPv6, mapped
  and NAT64 forms) in the front end **and** at connect time in the worker's proxy, so DNS
  rebinding cannot reach a private network.
- Chrome runs with a fresh profile per check, through the proxy, 200 MB per check, 150 s timeout.
- `check_files`: at most 60 files, 4 MB of text, relative paths without `..`.

## Data

No pages, files, URLs or reports are stored. The counter table holds hashed IPs (salted,
`IP_SALT`) for at most a day and daily/monthly GPU-second totals. Vercel request logs are kept at
most 7 days. The connector receives no chat history and no account data.

## Configuration (Vercel project `displayxr-mcp`)

| env | |
|---|---|
| `RUNPOD_API_KEY` | an endpoint-scoped RunPod key for the checker endpoint only |
| `RUNPOD_ENDPOINT_ID` | the queue endpoint |
| `DATABASE_URL` | Neon Postgres (Vercel integration `displayxr-mcp-db`) |
| `IP_SALT` | random; rotating it resets the per-IP counters |
| `MONTHLY_CAP_USD`, `ALERT_USD`, `GPU_PRICE_PER_HOUR` | defaults 50, 20, 0.58 |
| `ALERT_WEBHOOK_URL` | optional |

Without `RUNPOD_*` the server runs with the free tools only and the check tools explain the local
alternative.

## Develop and deploy

```sh
npm ci && npm test                       # unit tests, no network
node test/live.mjs                       # free tools against mcp.displayxr.org
node test/live.mjs --checks              # + one check_url and one check_files (uses GPU budget)
vercel deploy --prod                     # from this directory (project displayxr-mcp)
```

Worker image: on main, CI builds `ghcr.io/displayxr/inline3d-checker:<sha>`. The package is PUBLIC
and the endpoint pulls it with no registry credential: a private, credentialed GHCR pull stalled
for 16+ minutes on RunPod, the public pull cold-starts in about a minute. Roll the endpoint by
setting its image to the new tag (RunPod console or API); running workers finish on the old image.
Keep `@displayxr/inline3d-tools` at the same version in `package.json`, `worker/Dockerfile` and
`lib/server.mjs` (`TOOLS_VERSION`): CI checks it.

## Connect

- **Claude** (claude.ai / desktop): Settings → Connectors → Add custom connector → `https://mcp.displayxr.org/mcp`.
- **Claude Code**: `claude mcp add --transport http displayxr-inline3d https://mcp.displayxr.org/mcp`
- **ChatGPT** (developer mode): Settings → Apps → Create → the URL, no authentication.
- **Codex**: `codex mcp add displayxr-inline3d --url https://mcp.displayxr.org/mcp`
