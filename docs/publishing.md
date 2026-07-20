# Publishing `@displayxr/inline3d`

Publishing runs in **CI** (`.github/workflows/sdk-publish.yml`), so **no developer box needs an
npm token** — not this one, not the Mac. You provision one token once as a repo secret; after that
a release is a tag push from anywhere.

## One-time setup (account owner)

1. **Create the npm account/org.** On [npmjs.com](https://www.npmjs.com/), sign in (or sign up),
   then create the **`displayxr`** organization (Add Organization → name `displayxr` → **Free** plan;
   Free covers unlimited **public** packages). This claims the `@displayxr` scope. The package is
   already marked public (`publishConfig.access=public`).
2. **Mint an automation token.** npm → **Access Tokens** → **Generate New Token** → **Automation**
   (bypasses 2FA in CI). Copy it.
3. **Add it as a repo secret.** GitHub → `DisplayXR/displayxr-web` → Settings → Secrets and
   variables → Actions → **New repository secret** → name **`NPM_TOKEN`**, value = the token.

That's it — the token lives only in GitHub, never on a laptop, so there's nothing to sync to the
Mac box over Slack.

## Cutting a release

1. Bump `version` in `package.json` (SemVer — see [`sdk-stability.md`](sdk-stability.md) for what a
   major/minor/patch means here).
2. Commit, then tag and push — CI publishes:
   ```sh
   git tag sdk-v1.0.0
   git push origin sdk-v1.0.0
   ```
   The workflow typechecks, verifies the tag matches `package.json`, and runs
   `npm publish --provenance --access public`. npm rejects a re-publish of an existing version, so a
   duplicate tag is a safe no-op.

## Validate before the first real publish

Once `NPM_TOKEN` is set, run the workflow manually with **dry run** (Actions → *Publish SDK to npm*
→ Run workflow → `dry_run: true`). It packs + auths without uploading, confirming the token and
package are good. Then push the real tag.

## Publishing locally (optional, discouraged)

If you ever must publish from a box instead of CI: `npm login` (or an `~/.npmrc` `_authToken`), then
`npm publish` from the repo root on `main`. Prefer the CI path so no laptop holds the token.
