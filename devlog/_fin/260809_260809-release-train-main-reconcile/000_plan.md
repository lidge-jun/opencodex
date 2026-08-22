# 000 — release-train-main-reconcile: Research + Plan

## Objective

Run the approved release train: verify dev CI + stabilization since v2.11.0,
reconcile main's 17 unique commits into dev content-wise (user suggested a
squash merge; evidence below shows that is catastrophic, so the equivalent is a
targeted cherry-pick), promote dev -> preview -> main, publish
`@bitkyc08/opencodex` 2.11.1-preview.20260809 and 2.11.1 to npm.

## Evidence base (gathered at P, 2026-08-09 KST)

### Branch topology

- `git rev-list --left-right --count origin/main...origin/dev` = `17 204`
  (dev moved mid-audit: PR #1109 merged, tip `637711b3e`; dev is highly
  active — re-fetch and re-apply immediately before any push).
- Merge-base = `6a42b438a` (PR #1246 nanoid merge), an ancestor of dev.
- origin/preview = `12de87905 release: v2.11.0-preview.20260808`, 1 ahead of
  dev's base line, dev 204 ahead of it.
- npm dist-tags: `latest=2.11.0`, `preview=2.11.0-preview.20260808`.
- package.json versions: dev=2.10.2, main=**2.10.0** (regressed), preview=2.11.0-preview.20260808.

### Why squash-merging main into dev is catastrophic (subagent Rawls, verified)

- Main tip tree is byte-identical to `ec866465a` (`git diff 36c17d06e^1 origin/main` = empty):
  the merge `36c17d06e` (main -> fab/00-agent-fabric) followed by its revert
  `8a9c0efa7` reset main's tree to the v2.10.0-era fab fork point
  (`f9b9440c5`, already an ancestor of dev) plus 32 fab00 docs files.
- `git merge-tree --write-tree origin/dev origin/main` => **418 conflicted files**;
  `git diff 6a42b438a origin/main` = 1,485 files, +10,232 / -191,418 lines.
  Even "clean" hunks would silently revert dev's 196 commits to v2.10.0-era state.
- Net content dev actually lacks: ONLY `devlog/_plan/800_agent-fabric/**`
  (32 files, ~3,023 lines, from 9 `docs(fab00)` commits `ce6e44182^..ec866465a`).
  All new files, zero path overlap with dev.
- Audit amendment (blocker 2): 8 further files appear in a main<->dev diff but
  are NOT content to port — 7 `gui/public/provider-icons/*.svg` and
  `tests/jawcode-metadata-sync.test.ts`, deliberately deleted on dev
  (`d6dcc946d`, `0720efc6d`) and resurrected on main only by the revert
  `8a9c0efa7`. After the cherry-pick these 8 still diff main-vs-dev; that is
  expected, and the promotion (main tree := released preview tree) correctly
  re-deletes them on main.
- Already-on-dev / noise: v2.11.0 + preview release bumps (reverted at main tip;
  dev's 2.10.2 line supersedes), `x`/noop pair (self-canceling), PR #1265 hotfix
  (dev has the evolved 1,330-line hardening via `0993c53ae`, `a0740f7f1`, `f7448e7f2`).

### Stabilization audit since v2.11.0 (subagent Beauvoir, verified)

- Zero `failure` CI conclusions in last 30 dev runs. 14 `cancelled` runs all
  confirmed concurrency-supersession via `git merge-base --is-ancestor` against
  latest green `31286915809@3c40df209`.
- Service lifecycle path-filtered; last 3 runs green (`31259450254` etc.).
- Open bugs with draft fix PRs (deferred, none labeled regression): #1308
  (sync data loss), #1312 (Vertex session sharing), #1296, #1292, #1273.
- #1222 (Windows STATUS_STACK_BUFFER_OVERRUN, 2.10.x): OPEN, maintainer-acknowledged,
  unfixed — but it shipped in v2.11.0 stable already; carried-over known issue,
  not a new regression since last release.
- Verdict: STABLE-WITH-NOTES. Mechanically releasable.

## Loop-spec

- Loop archetype: verifier-defined (release gates define done).
- Trigger: user-approved release train (push/merge/npm publish approved in chat).
- Goal: dev contains all main content; preview+stable 2.11.1 published; branches converged.
- Non-goals: fixing open bugs (#1308/#1312/#1222...), touching the ~21 draft PRs,
  force-push, branch deletion.
- Verifier: `bun run typecheck` + `bun run test` locally; exact-SHA `ci.yml` +
  `service-lifecycle.yml` green via `gh run list --commit <sha>`; release.yml run
  success; `npm view @bitkyc08/opencodex dist-tags --json`.
- Stop condition: all criteria met, or a release gate fails deterministically.
- Memory artifact: this unit + goalplan ledger.
- Terminal outcomes: DONE / NOOP / BLOCKED (permissions, unpassable gate) /
  UNSAFE (new regression found) / NEEDS_HUMAN.
- Resource bounds: write scope = this repo's branches + GitHub releases/tags +
  npm dist-tags + this devlog unit; wall-clock bounded by CI_WAIT_TIMEOUT_MS
  (20 min/gate, release.ts) plus one retry per flake.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP1 | 010_phase1.md | Full train: reconcile -> dev push -> preview release -> main reconcile+release -> verify | - |

Single work-phase exemption (cxc-loop LOOP-DOCS-FIRST-01): operational runbook
execution per `opencodex-release-train` skill, one PABCD cycle.

## Accept criteria

- c1: stabilization findings recorded (this doc). The dev release-candidate
  base SHA (`637711b3e`) has a green ci.yml run (in-flight run 31287648122
  awaited); the cherry-pick SHA is docs-only and gets no CI run by design
  (ci.yml push.paths exclude `devlog/**`) — green is inherited from the base
  SHA, and the binding exact-SHA gates (ci.yml + service-lifecycle.yml) fire
  on the release SHAs via the package.json trigger path (release.ts:323-329).
- c2: after cherry-pick, `git diff origin/main <new-dev> -- devlog/_plan/800_agent-fabric`
  is empty (dev contains 100% of main's real content); typecheck+test green.
- c3: pushed dev tip = base SHA + docs-only cherry-picks; no CI run expected
  on it (path-filtered). Evidence = base SHA's green run + path-filter proof.
- c4: `npm view` dist-tags show preview=2.11.1-preview.20260809 and latest=2.11.1;
  release.yml runs succeeded; GitHub Releases/tags exist.
- c5: main tree == released tree; preview/main contain dev; this unit's record
  doc written; goalplan criteria marked with capturedEvidence.
