# 020 — Phase 2: service-lifecycle trigger path sync (`src/cli.ts`)

## Problem (verified 2026-07-16)

`release.yml`'s gate regex checks `src/cli.ts` but `service-lifecycle.yml` never
auto-triggers on it:

- Gate side — `.github/workflows/release.yml:152-154`:

  ```
  # Keep in sync with the service-lifecycle.yml trigger paths. src/cli.ts is
  # the pre-restructure compat stub that durable launchers still execute.
  if printf '%s\n' "$changed_files" | grep -Eq '^(src/service\.ts|src/cli\.ts|src/cli/index\.ts|src/lib/bun-runtime\.ts|package\.json|bun\.lock|\.github/workflows/service-lifecycle\.yml)$'; then
  ```

- Trigger side — `.github/workflows/service-lifecycle.yml:6-20` lists (for BOTH
  `pull_request.paths` and `push.paths`): `src/service.ts`, `src/cli/index.ts`,
  `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`,
  `.github/workflows/service-lifecycle.yml` — **no `src/cli.ts`**.

Failure mode: a release whose only service-relevant change since the last v-tag is
`src/cli.ts` hits the gate ("Service-related files changed ... no successful Service
lifecycle run") with no auto-run to satisfy it; the operator must notice and
`workflow_dispatch` service-lifecycle manually, then re-dispatch the release.
v2.7.21 was unaffected only because version bumps touch `package.json` (a real trigger).

## Diff (copy-paste executable)

`.github/workflows/service-lifecycle.yml` — apply to BOTH paths blocks
(`pull_request` lines 6-12 and `push` lines 13-20):

```diff
     paths:
       - "src/service.ts"
+      # Keep in sync with the release.yml service-gate regex (release.yml:154).
+      # src/cli.ts is the pre-restructure compat stub durable launchers still execute.
+      - "src/cli.ts"
       - "src/cli/index.ts"
       - "src/lib/bun-runtime.ts"
       - "package.json"
       - "bun.lock"
       - ".github/workflows/service-lifecycle.yml"
```

## Accept criteria

- Both `paths:` blocks contain `src/cli.ts`; `git diff` shows exactly 2 insertion
  sites (plus comments).
- AUDITED ADDITION (round 1 #4): the existing workflow contract test extracts only
  the `push` block (`tests/ci-workflows.test.ts:82-101`), so a push-only live probe
  cannot prove `pull_request.paths`. Extend that test to assert PR/push path-set
  EQUALITY (or at minimum that `src/cli.ts` appears in BOTH blocks) — this makes the
  sync property regression-proof in CI, not just at review time.
- Activation (C-ACTIVATION-GROUNDING-01): push a branch commit touching ONLY
  `src/cli.ts` (e.g. a comment) and observe service-lifecycle auto-start for that
  SHA (`gh run list --workflow service-lifecycle.yml --commit <sha>`), then drop
  the probe commit. Alternatively `act`-style dry run if available; the live-probe
  branch route is the deterministic oracle.
- No release.yml change needed (regex already correct).

## Class call

C1 — single-file CI config, no runtime behavior. Fast-path with this record doc;
the activation probe is still mandatory because trigger paths only prove
themselves by firing.
