# displayxr-inline3d-codex: the OpenAI Codex plugin for glasses-free 3D web pages

The Codex edition of the [`displayxr-inline3d`](../displayxr-inline3d) Claude Code plugin. It has the
same four skills for pages built on [`@displayxr/inline3d`](https://www.npmjs.com/package/@displayxr/inline3d)
(woven glasses-free 3D in the DisplayXR Browser, plain 2D everywhere else), plus the
[`@displayxr/inline3d-tools`](https://www.npmjs.com/package/@displayxr/inline3d-tools) MCP server,
so Codex can check a page from outside its sandbox.

## Install

```
npx -y @displayxr/inline3d-tools@0.1.2 --version
codex plugin marketplace add DisplayXR/displayxr-web
codex plugin add displayxr-inline3d-codex@displayxr
```

The first line fetches the package once. Codex starts the MCP server when a session starts, and it
can stop the server before a first, cold `npx` download finishes. An interrupted download leaves a
broken entry in npm's `_npx` cache (`node_modules` without a `package.json`), and from then on the
server fails at every start with `npm error enoent Could not read package.json` in Codex's log. To
recover, delete the `~/.npm/_npx/<hash>` directory named in that error, then run the first line
again.

In Codex, this repository's marketplace lists only this plugin. Codex reads
`.agents/plugins/marketplace.json`, which takes precedence over the Claude Code marketplace in
`.claude-plugin/`. The Claude plugin, `displayxr-inline3d`, has no MCP server; Claude Code users
install that one.

## What it contains

| file | what it is |
|---|---|
| `skills/` | the Claude plugin's four skills, copied byte for byte. Codex lists them as `displayxr-inline3d-codex:inline3d`, `:new-inline3d-page`, `:inline3d-assets` and `:inline3d-check` |
| `.codex-plugin/plugin.json` | the Codex manifest: listing metadata, and `mcpServers` → `.mcp.json` |
| `.mcp.json` | one stdio server, `npx -y @displayxr/inline3d-tools@0.1.2 mcp`, with a 60 s start-up and 180 s tool timeout |
| `assets/icon.png`, `LICENSE` | copies from the Claude plugin |

Everything except this README is generated from `plugins/displayxr-inline3d/` by
`node tools/inline3d-tools/scripts/sync-agents.mjs`. CI runs it with `--check` and fails on any
drift. Edit the Claude plugin's skills, never these copies.

## Use the MCP `check` tool in Codex

Codex runs a plugin's MCP server outside its sandbox, so the `check` tool works there. The skills
also show the shell form (`npx -y @displayxr/inline3d-tools@0.1.2 check …`), which fails inside
Codex's default sandbox (`listen EPERM 127.0.0.1`: the checker's local file server cannot listen)
unless you approve running it outside the sandbox.

Tools: `check`, `asset_check`, `scaffold`, `gen_providers`, `gen_run`, `gen_provenance`,
`authoring_guide`. What each one runs, sends and writes is listed in the
[Claude plugin's README](../displayxr-inline3d/README.md#what-this-plugin-runs-sends-and-fetches) and the
[package README](../../tools/inline3d-tools/README.md). `gen_run` is the only paid tool. It refuses
without `confirm_paid: true`, which an agent passes only after you approved that one call. It
reads provider keys from the MCP server's environment only. To pass yours, add
`env_vars = ["MESHY_API_KEY", "TRIPO_API_KEY", "OPENAI_API_KEY"]` under
`[plugins."displayxr-inline3d-codex@displayxr".mcp_servers.inline3d-tools]` in `~/.codex/config.toml`.
DisplayXR receives nothing from this plugin: no telemetry, no accounts.

Needs Node ≥ 18 (with `npx`). `check` also needs Chrome or Chromium (`CHROME=/path/to/chrome`).
