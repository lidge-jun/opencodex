# 150.10 — Verification: Cross-Platform CI and Release Gate

## Local Verification

Ran:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test tests
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
bun run src/cli.ts help
ruby -e 'require "yaml"; ARGV.each { |p| YAML.load_file(p); puts "ok #{p}" }' .github/workflows/ci.yml .github/workflows/release.yml
```

Results:

- dependency check: pass, no lockfile changes;
- typecheck: pass;
- test suite: pass, 92 tests;
- release helper build smoke: pass;
- CLI help smoke: pass;
- workflow YAML parse: pass.

## Plan Audit

Initial read-only audit found three blocking risks:

- Release workflow needed `actions: read` for `gh run list` with explicit token permissions.
- `scripts/release.ts` needed to ensure the SHA it waited on was the SHA it dispatched.
- Root `tsc` does not include `scripts/`, so release helper verification needed a separate smoke.

The plan was revised to:

- add `actions: read`;
- set `GH_TOKEN` on the release-gate step;
- wait for `ci.yml` success on the pushed release SHA;
- verify `origin/main` still equals the release SHA before `gh workflow run release.yml --ref main`;
- verify `scripts/release.ts` with `bun build`.

Final read-only audit verdict: PASS.

## Build Verification

Read-only build verification confirmed:

- `.github/workflows/ci.yml` contains Linux/Windows matrix and the intended short command set.
- `.github/workflows/release.yml` gates publish on a successful `ci.yml` run for `GITHUB_SHA`.
- `scripts/release.ts` waits for CI, checks `origin/main`, then dispatches Release on `main`.
- `structure/06_docs-and-release.md` documents the CI/release split.

The verifier returned `NEEDS_FIX` only because the new workflow/devlog files had not yet been staged,
committed, pushed, or remote-CI-verified at that point. The remaining steps are commit, push, and
GitHub Actions verification.

## Remote Verification Plan

After push:

1. Confirm the new `Cross-platform CI` workflow starts for the pushed head SHA.
2. Watch the run to completion.
3. Record run URL/result here or in the final task summary.

## Residual Limitations

- macOS is intentionally not in the matrix.
- The release workflow still performs `prepublishOnly` during dry-run/publish because npm publish
  semantics and GUI packaging need that check; ordinary CI remains short.
