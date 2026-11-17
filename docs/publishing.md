# Publishing `@displayxr/inline3d`

Publishing runs in **CI** (`.github/workflows/sdk-publish.yml`) via **npm Trusted Publishing
(OIDC)** — **no npm token exists anywhere**: no repo secret, nothing on the Mac or Win box, nothing
to sync or rotate. npm links the package to this repo + workflow and CI authenticates per-run with a
short-lived OIDC token. (We chose this over an Automation token because npm is restricting
2FA-bypass tokens — account changes Aug 2026, direct publishing Jan 2027.)

## One-time setup — ✅ DONE (2026-07-20), kept for reference

> **Do not re-run this.** The bootstrap is complete: the package exists, the Trusted Publisher is
> configured, `0.0.1` is published + deprecated, and no npm credentials remain on any box. This
> section is retained so the mechanism stays documented, and as a template if another
> `@displayxr/*` package ever needs the same treatment. To ship a version, skip to
> [Cutting a release](#cutting-a-release).

A Trusted Publisher attaches **per package**, and the package must exist before it can be
configured — there is no org-level trusted-publisher setting. So a brand-new package name needs a
one-time manual bootstrap:

1. **Publish a throwaway stub manually** so the package name exists. Do this from an **isolated
   directory**, not the repo checkout — a minimal `package.json` (name, version, license,
   `publishConfig.access: public`) plus a README saying "do not install". Publishing the real
   payload as `0.0.1` would strand a full, unprovenanced copy of the SDK on the registry forever,
   and editing the version in-tree risks committing the throwaway.
   ```sh
   npm login                    # interactive; passkey/2FA, no token stored
   npm publish --access public  # from the stub dir
   ```
   npm demands a **fresh 2FA approval for the publish itself**, separate from login — that's the
   "Authorization and Writes" 2FA mode working as intended, and why a stolen `~/.npmrc` can't ship
   code.
2. **Configure the Trusted Publisher** on npm: npmjs.com → the `@displayxr/inline3d` package →
   Settings → **Trusted Publisher** → GitHub Actions →
   - Organization or user: `DisplayXR`
   - Repository: `displayxr-web`
   - Workflow filename: **`sdk-publish.yml`** — filename only, NOT the full path (npm's UI:
     "Filename only (e.g., publish.yml). Must exist in `.github/workflows/` in your repository."
     A full path is rejected.)
   - Environment name: *(blank)*
   - Allowed actions: **`npm publish`** only — not `npm stage publish`; the workflow doesn't stage
3. **Set Publishing access** (same Settings page) to **"Require two-factor authentication and
   disallow tokens (recommended)"**. npm notes all options are OIDC-compatible, so this costs
   nothing and makes token-based publishing to this package structurally impossible.
4. **Deprecate the stub and drop the local session:**
   ```sh
   npm deprecate @displayxr/inline3d@0.0.1 "Bootstrap placeholder — no code. Use the latest release."
   npm logout   # clears the session token from ~/.npmrc
   ```

After this the real `1.0.0` (and every future version) publishes from CI with full provenance, and
no token exists anywhere.

**Gotcha:** a brand-new scoped package can 404 from `registry.npmjs.org` for several minutes after
a *successful* publish while the website already shows it — that's CDN propagation, not a failure.
Check the package page before re-trying anything.

## Cutting a release

1. Bump `version` in `package.json` (SemVer — see [`sdk-stability.md`](sdk-stability.md)).
2. Commit, then tag and push — CI publishes:
   ```sh
   git tag sdk-v1.0.0
   git push origin sdk-v1.0.0
   ```
   The workflow (Node 22, npm ≥ 11.5.1) typechecks, verifies the tag matches `package.json`, and
   runs `npm publish --provenance --access public` authenticated by OIDC. npm rejects a re-publish
   of an existing version, so a duplicate tag is a safe no-op.

## Validate before the first real publish

After the Trusted Publisher is configured, run the workflow manually with **dry run** (Actions →
*Publish SDK to npm* → Run workflow → `dry_run: true`). It exercises OIDC auth + packs without
uploading. Then push the real tag.

# Publishing `@displayxr/inline3d-tools`

`tools/inline3d-tools/` publishes the same way, from its own workflow
(`.github/workflows/tools-publish.yml`) and its own tag prefix, **`tools-vX.Y.Z`**. The tag must
match `tools/inline3d-tools/package.json` `version`; the workflow runs the package's tests, checks
that `AGENTS.md` and the Claude plugin's pins are in sync, smoke-tests the packed tarball, then
publishes with provenance over OIDC.

## One-time bootstrap (not done yet)

Same mechanism as the SDK above: npm attaches a Trusted Publisher **per package**, and both the npm
UI and `npm trust github` require the package to **already exist** on the registry. So the first
version cannot come from CI.

1. **Publish a stub** of `@displayxr/inline3d-tools` manually, from an isolated directory (not this
   checkout): a `package.json` with `name`, `version: "0.0.1"`, `license: "Apache-2.0"`,
   `publishConfig.access: "public"`, plus a README saying "bootstrap placeholder, do not install".
   No `bin`, no code.
   ```sh
   npm login                    # interactive; passkey/2FA, no token stored
   npm publish --access public  # from the stub dir; npm asks for a fresh 2FA approval
   ```
2. **Configure the Trusted Publisher**: npmjs.com → `@displayxr/inline3d-tools` → Settings →
   Trusted Publisher → GitHub Actions → Organization `DisplayXR`, Repository `displayxr-web`,
   Workflow filename **`tools-publish.yml`** (filename only), Environment blank, Allowed actions
   `npm publish`. CLI alternative (npm ≥ 11.15.0, while still logged in):
   `npm trust github @displayxr/inline3d-tools --repo DisplayXR/displayxr-web --file tools-publish.yml --allow-publish`.
   npm requires the first CI publish within 2 days of creating the configuration.
3. **Publishing access** → "Require two-factor authentication and disallow tokens".
4. **Deprecate the stub and log out**:
   ```sh
   npm deprecate @displayxr/inline3d-tools@0.0.1 "Bootstrap placeholder, no code. Use the latest release."
   npm logout
   ```
5. Run *Publish inline3d-tools to npm* with `dry_run: true`, then push `tools-v0.1.0`.

## Releasing a new tools version

1. Bump `version` in `tools/inline3d-tools/package.json`, then run
   `node tools/inline3d-tools/scripts/sync-agents.mjs`: it rewrites every
   `@displayxr/inline3d-tools@X.Y.Z` pin in the Claude plugin and the package README and
   regenerates `AGENTS.md`. Bump the plugin's `version` in `.claude-plugin/plugin.json` too.
2. Merge, tag `tools-vX.Y.Z`, push the tag. **Publish the package before a plugin release that
   pins it**: a plugin version whose pin is not on npm yet makes every skill command fail.
