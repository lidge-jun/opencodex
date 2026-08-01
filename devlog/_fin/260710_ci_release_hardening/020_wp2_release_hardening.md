# 020 - WP2 release and deployment gate hardening with dry-run proof

Work class: C4 (release integrity). Archetype: spec-satisfaction repair.

## P - Audit findings

1. **Service-gate path drift (real gate bypass).** `release.yml` requires a
   successful Service lifecycle run only when files matching
   `^(src/(service|cli|bun-runtime)\.ts|package\.json|bun\.lock|\.github/workflows/service-lifecycle\.yml)$`
   changed since the previous tag. After the src restructure (e322f404) the
   service surface is `src/service.ts`, `src/cli/index.ts`, and
   `src/lib/bun-runtime.ts` — exactly the paths `service-lifecycle.yml`
   triggers on. `src/bun-runtime.ts` no longer exists and `src/cli/index.ts`
   does not match, so a release touching the CLI service entry or bun runtime
   would skip the required service check. Fix: sync the regex to the
   service-lifecycle trigger paths (keep `src/cli.ts`, the compat stub that
   durable launchers still execute).
2. **Raw `${{ inputs.* }}` interpolation in `run:` blocks.** `inputs.version`,
   `inputs.tag`, and `inputs.dry-run` are spliced into bash source. Dispatch
   requires write access, but a crafted version string is still a script
   injection primitive. Fix: pass all three through `env:` and reference the
   shell variables.
3. **Mutable action tags** in `release.yml` and `deploy-docs.yml`. Pin, same
   as WP1: checkout v7 `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`, setup-bun
   v2 `0c5077e51419868618aeaa5fe8019c62421857d6`, setup-node v4
   `49933ea5288caeca8642d1e84afbd3f7d6820020`, withastro/action v3
   `56781b97402ce0487b7e61ce2cb960c0e2cc5289` (gh api tag target 2026-07-10),
   actions/deploy-pages v4 `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e`.
4. **deploy-docs.yml has no job timeouts.** Add `timeout-minutes` to build and
   deploy jobs.
5. `scripts/release.ts` audit: branch/dist-tag/channel checks, clean-tree
   requirement, unused-version preflight (npm+tag+release), CI wait keyed to
   the exact release SHA, and an origin-moved abort are all present. No change.
6. Non-changes: the post-publish smoke hardcodes the package name it also
   derives elsewhere (equal today); release concurrency stays
   `cancel-in-progress: false` (a release must never be cancelled mid-publish);
   Pages concurrency likewise. WP1's intentional CI cancellation on
   dev/preview pushes stays.

## Build scope

1. `.github/workflows/release.yml`: fix service-gate regex; env-indirect all
   `inputs.*` in run blocks; pin actions.
2. `.github/workflows/deploy-docs.yml`: pin actions; add job timeouts.
3. `tests/ci-workflows.test.ts`: extend invariants — every `uses:` across all
   four workflows is SHA-pinned; release.yml run blocks contain no raw
   `${{ inputs.` interpolation; service-gate regex covers
   `src/cli/index\.ts` and `src/lib/bun-runtime\.ts` and matches every
   service-lifecycle push path; release dry-run input defaults to true;
   release concurrency does not cancel in progress.

## Verification

- `actionlint` on all four workflows; focused `bun test
  tests/ci-workflows.test.ts`; `bun x tsc --noEmit`; full suite in an
  isolated worktree at the commit.
- Push dev, fast-forward preview and main; require green Cross-platform CI
  (+ Service lifecycle, which triggers on the workflow change) on the SHA.
- Dry-run proof (wp2-t3): from a main worktree run
  `bun scripts/release.ts 2.7.5` (dry-run default) — bumps package.json,
  pushes the release commit to main, waits for CI, dispatches Release with
  dry-run=true, and must end in a successful run that builds and packs
  v2.7.5 from that exact SHA. WP3 then publishes the same SHA with
  dry-run=false.

## Resource bounds

- Write scope: the two workflow files, `tests/ci-workflows.test.ts`, this
  devlog unit, plus the `release: v2.7.5` package.json bump commit produced
  by the trusted script.
- Credentials: existing `gh` auth; trusted-publishing OIDC only; no npm token.
- Wall clock: 60 minutes for WP2. No force pushes, no tag rewrites.

## LOOP-PESSIMIST

- If the dry-run fails in the workflow, read the failing step log first; do
  not retry blindly or weaken the gate that failed.
- If main cannot fast-forward, stop and inspect; never force.
