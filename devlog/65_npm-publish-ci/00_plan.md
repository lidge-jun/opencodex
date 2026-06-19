# npm publish CI + release runbook

## Why
`bun install -g opencodex` / `npm install -g opencodex` install from the **npm registry**, NOT from
GitHub. Pushing to GitHub does not make those commands work — opencodex must be **published to npm**
first. This adds a GitHub Actions workflow that publishes on a version tag.

## What shipped
- `.github/workflows/publish-npm.yml` — on a pushed tag `vX.Y.Z` (or manual dispatch):
  setup bun (for the `prepublishOnly` GUI build) + node (for `npm publish`), `bun install`, verify the
  tag matches `package.json` version, then `npm publish --provenance --access public`.
- Package was already made publish-ready (earlier `63_release-prep`):
  `files` allowlist (src + gui/dist + scripts/postinstall.mjs + README + LICENSE), `bin` (opencodex/ocx,
  `#!/usr/bin/env bun`), `engines.bun`, `prepublishOnly` (typecheck + build the GUI into gui/dist so the
  published tarball always carries a fresh dashboard). `npm pack --dry-run`: 54 files / 634 KB, ships
  gui/dist + the bin, excludes devlog/docs-site/gui-src.

## One-time setup (owner)
1. Create an npm **Automation** access token: npmjs.com → Access Tokens → Generate → *Automation*.
2. Add it to the repo as a secret named **`NPM_TOKEN`**: GitHub → Settings → Secrets and variables →
   Actions → New repository secret.
3. (First publish only) the npm name `opencodex` is currently unclaimed, so the first tagged release
   claims it under your npm account.

## Releasing (each version)
```bash
# from a clean main
npm version patch        # or minor/major — bumps package.json + creates the vX.Y.Z git tag
git push --follow-tags   # pushes the commit AND the tag → CI publishes to npm (with provenance)
```
After the workflow goes green:
```bash
bun install -g opencodex     # or: npm install -g opencodex
ocx init && ocx start
```

## Notes
- opencodex is **bun-native** (the `ocx` bin is `#!/usr/bin/env bun` and the server uses `Bun.serve`),
  so installers still need **bun** on PATH even via `npm install -g`. `engines.bun` documents this.
- The consumer-side `postinstall` (interactive [Y/n] GitHub-star prompt) is TTY-gated → it no-ops in
  CI / piped installs, so it never blocks an automated install.
