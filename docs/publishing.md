# Publishing `@displayxr/inline3d`

Publishing runs in **CI** (`.github/workflows/sdk-publish.yml`) via **npm Trusted Publishing
(OIDC)** — **no npm token exists anywhere**: no repo secret, nothing on the Mac or Win box, nothing
to sync or rotate. npm links the package to this repo + workflow and CI authenticates per-run with a
short-lived OIDC token. (We chose this over an Automation token because npm is restricting
2FA-bypass tokens — account changes Aug 2026, direct publishing Jan 2027.)

## One-time setup (account owner)

The npm account `dfattal` + the **`displayxr`** org (Free plan) already exist, so the `@displayxr`
scope is claimed. What's left is a bootstrap, because a Trusted Publisher attaches **per package**
and the package must exist before you can configure it (there is no org-level trusted-publisher
setting):

1. **Publish a throwaway stub manually** so the package name exists. From a checkout on `main`:
   ```sh
   npm version 0.0.1 --no-git-tag-version   # temporarily; do NOT commit this
   npm login                                 # interactive, uses your 2FA (no token stored)
   npm publish --access public
   git checkout -- package.json              # restore version to 1.0.0
   ```
2. **Configure the Trusted Publisher** on npm: npmjs.com → the `@displayxr/inline3d` package →
   Settings → **Trusted Publishers** → add GitHub Actions →
   - Repository: `DisplayXR/displayxr-web`
   - Workflow: **`sdk-publish.yml`** — filename only, NOT the full path (npm's UI: "Filename
     only (e.g., publish.yml). Must exist in `.github/workflows/` in your repository." A full
     path is rejected.)
3. **Deprecate the stub** (optional, tidy): `npm deprecate @displayxr/inline3d@0.0.1 "bootstrap stub — use >=1.0.0"`.

After this the real `1.0.0` (and every future version) publishes from CI with full provenance, and
no token ever exists.

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
