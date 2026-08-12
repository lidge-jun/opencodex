# 020 — Closing record: release train v2.11.1 (2026-08-09)

Terminal outcome: **DONE**.

## What shipped

- npm `@bitkyc08/opencodex`: `preview=2.11.1-preview.20260809`,
  `latest=2.11.1` (verified via `npm view dist-tags --json` after each publish).
- GitHub Releases: `v2.11.1-preview.20260809` (prerelease), `v2.11.1`
  (not draft); matching tags created by release.yml.
- Branches: preview contains the dev RC (`2418291eb`); main contains preview
  (`git merge-base --is-ancestor` verified); main<->preview tree delta is only
  the stable version bump in `package.json`.

## Key SHAs and runs

| Item | Value |
|------|-------|
| dev RC tip (cherry-picks) | `2418291eb` |
| preview merge | `4e1bb9b03` (local), release commit `4d1b1a467` |
| preview release SHA | `4d1b1a4676a1dac045161cda0159594cf4e3dbda` |
| main promotion (commit-tree merge) | `674ab3f8ac11ca31080c26361a7a0da88642e9e4` |
| stable release SHA | `121f1ad929dc6da3356c06f5192f2f97f7a5dde5` |
| preview release.yml run | `31290112347` (success) |
| stable release.yml run | `31292505685` (success) |

## Deviations from the user's initial framing (evidence-driven)

1. **No squash merge of main into dev.** merge-tree dry-run showed 418
   conflicted files / ~191k lines of silent dev reverts: main's tip tree had
   regressed to the v2.10.0 era via `8a9c0efa7` (revert of the fab00 merge
   restored the merge's first-parent tree). Instead: cherry-picked the 9
   `docs(fab00)` commits `ce6e44182^..ec866465a` (main's only real unique
   content) onto dev; releases/noop-pair/#1265-hotfix skipped as superseded
   (dev carries the evolved hardening via `0993c53ae`/`a0740f7f1`/`f7448e7f2`).
2. **Main promoted via a commit-tree merge** (tree := released preview tree,
   parents = old main + preview) instead of a normal merge, which would have
   hit the same regressed-tree conflict set. Full ancestry preserved; no
   force-push.
3. **release.yml dispatched manually** for both releases after
   `scripts/release.ts` exited on CI-gate cancellations (see below); the
   version bump commits and gate waits the helper performed were reused, and
   the dispatch inputs mirrored `release.ts:343` exactly.

## Incidents during the run

- **#1302 CI shard hangs fired three times** (dev tip run `31287648122` shard
  3/4; preview release run `31289360063` shards 3/4+4/4; main release run
  `31291630193` shard 4/4) — each killed at ~15:15 in the Test step, each
  green on `gh run rerun --failed`. Today's hit rate (3/3 full runs) suggests
  #1302 is trending systematic, not intermittent; worth a dedicated fix unit.
- Local `translator-budget` typecheck test failed in both worktrees due to
  stale `node_modules` (tsc 5.x vs pinned typescript 7.0.2); fixed with
  `bun install`. Pre-existing environment issue, not a code regression.
- A `git checkout preview | tail && ...` pipeline short-circuit mistake moved
  the local `dev` ref onto a stray merge commit (`fdb4253f3`, now
  unreferenced); remote was never affected, local dev was reset to
  `origin/dev`. Lesson: no pipes mid-`&&` chains for branch operations.

## Stabilization notes carried forward (not release-blocking)

- #1222 (Windows STATUS_STACK_BUFFER_OVERRUN, 2.10.x) — OPEN,
  maintainer-acknowledged, shipped in v2.11.0 already; still unfixed in 2.11.1.
- #1308, #1312, #1296, #1292, #1273 — open bugs with draft fix PRs; deferred.
- PR #1323 (`test(omp): isolate path contract temp homes`) landed on dev
  (`79831c90f`) after the preview RC was cut; test-only, ships in the next
  cycle.

## Verification transcript (final)

- `npm view @bitkyc08/opencodex dist-tags --json` => latest=2.11.1, preview=2.11.1-preview.20260809
- `gh release view v2.11.1` => draft=false; `gh release view v2.11.1-preview.20260809` => prerelease=true
- `git merge-base --is-ancestor 2418291eb origin/preview` => OK (preview contains dev RC)
- `git merge-base --is-ancestor origin/preview origin/main` => OK (main contains preview)
- `git diff origin/main origin/preview --stat` => package.json only (stable version bump)
- `bun run typecheck` exit 0; `bun run privacy:scan` passed
- `bun run test` 10128 pass / 1 env-fail (stale node_modules tsc; 13/13 green after `bun install`)
