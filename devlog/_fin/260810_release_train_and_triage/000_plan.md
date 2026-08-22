# 000 — release train and issue/PR triage: research and plan

Unit opened 2026-08-10 KST. Objective: release the work that accumulated on
`dev` since v2.11.1, then close every issue and pull request the released state
genuinely resolves.

## Objective and authorization

The user asked for three things in one loop: verify release readiness, deploy,
and close what can be closed. Push, npm publish, and issue/PR closure are
authorized for this train's scope. Force-push, branch deletion, contributor-PR
merges, and history rewriting are not.

## Evidence base (gathered at P, 2026-08-10 KST)

### Starting state

- Local `dev` was 90 commits behind `origin/dev` and was fast-forwarded to
  `dc4dd45b0` with a clean worktree (`git status --porcelain` empty).

> **Baseline correction — applied twice, after two audit rounds.** The first
> version of this document measured the delta as `4f746d137..dc4dd45b0`: the
> local branch position before the fast-forward. That is the wrong baseline for
> a release and it understated the delta by roughly half, producing two false
> claims (no workflow changes; no direct commits). Both are retracted below.
>
> A release delta has two correct measurements, and they answer different
> questions:
>
> - **Tree delta** `121f1ad92..RC` — what actually changes for users, measured
>   from the released v2.11.1 commit.
> - **Linear provenance** `2418291eb..RC` — from the previously *shipped* RC,
>   which is the right range for asking who authored what, because it follows
>   the integration line rather than crossing the release-branch topology.

### Delta, measured correctly

| Measurement | Range | Result |
|-------------|-------|--------|
| Tree delta | `121f1ad92..dc4dd45b0` | **373 files, +33,933 / -1,417** |
| Commits | `2418291eb..dc4dd45b0` | **340** |
| First-parent merges | same | **48** |
| First-parent non-merges | same | **44** |

**Retraction:** the earlier claim of "195 files, +15,552/-483, 35 merges, zero
non-merge commits, every change through a reviewed PR" was an artifact of the
wrong baseline. There are **44 direct first-parent commits**. Inspected, they
are maintainer squash-merges and follow-up fixes from `bitkyc08-arch`,
`Ingwannu`, `luvs01`, `Yuxin Qiao`, `马凤岐`, and `Hanbin Noh` — consistent
with `MAINTAINERS.md`'s allowance for maintainer-owned integration work, but
they are *not* all PR-reviewed, and the plan must not claim they are.

### Boundary surfaces in the true delta

```
.github/scripts/enforce-pr-target.test.cjs      7
.github/scripts/issue-quality-core.cjs        127
.github/scripts/issue-quality.test.cjs         66
.github/scripts/pr-hygiene.cjs                 69
.github/scripts/pr-hygiene.test.cjs            78
.github/workflows/ci.yml                       94
.github/workflows/enforce-pr-target.yml        88
.github/workflows/pr-hygiene.yml               63
.github/workflows/react-doctor.yml              4
bin/ocx.mjs                                     4   <- shipped in the tarball
gui/package.json                                4   <- react-doctor pin 0.9.3 -> 0.9.11
package.json                                    2   <- version only
scripts/gen-live-digests.ts                    52
```

Clean: no root dependency change, no `bun.lock` change, no `.npmrc`, no
postinstall or packaging hook. `scripts/release.ts` itself is unchanged.

`bin/ocx.mjs` and `gui/package.json`'s executable `npx --yes react-doctor` pin
are the two that were invisible under the old baseline and *do* reach shipped
or executed surfaces.
- npm dist-tags at start: `latest=2.11.1`, `preview=2.11.1-preview.20260809`,
  both published 2026-08-09 by the previous train
  (`devlog/_fin/260809_260809-release-train-main-reconcile/020_record.md`).
- `dev` package.json reads `2.10.2`; that is expected, because
  `scripts/release.ts` bumps the version on the release branch, not on `dev`.

### What is in the delta

The user-facing surface is larger than a patch release:

- **Compatibility Lab CL-03/CL-04/CL-05** — bounded live-route probes
  (`src/lab/live/`), the `ocx lab` CLI plus `GET /api/lab/*` management read
  surfaces, and a read-only GUI verdict matrix at `#models/compatibility`.
  Contract of record: `structure/09_compatibility-lab.md`.
- **Turkish GUI locale** (`gui/src/i18n/tr.ts`, 1,983 lines) and
  `readme/README.tr.md`.
- Roughly 30 bug-fix merges: bounded response/quota/SSE parsing, three ReDoS
  fixes, Windows console-popup and service-uninstall repairs, OAuth expiry
  handling, and routed tool-choice policy.

Because shipped features are involved and not only fixes, the next version is a
**minor** bump under this repository's observed convention (`v2.10.x` patch
trains vs `v2.11.0` when features landed):

- preview: `2.12.0-preview.20260810`
- stable: `2.12.0`

Both satisfy the validation in `scripts/release.ts:279-296` (semver shape;
`preview` branch requires a `-preview.` suffix, `main` forbids any suffix).

### Security-boundary review of the delta

`AGENTS.md` requires explicit security review for changes to authentication,
credential handling, OAuth, workflows, release automation, or dependency
installation. Six merged PRs touched that boundary, all through review:

| PR | Boundary files | Merge |
|----|----------------|-------|
| #1352 | `src/lab/live/credential-lease.ts`, `src/lib/lab-live-execution-authority.ts` | `68c71a4e9` |
| #1353 | `src/server/responses/core.ts` | `4ba439c90` |
| #1358 | `src/server/claude-messages.ts`, `src/server/responses/core.ts` | `c2cc24420` |
| #1360 | `src/cli/claude.ts` | `f38d960a1` |
| #1369 | `src/oauth/index.ts`, `src/oauth/local-token-detect.ts` | `e8ce2b93d` |
| #1373 | `src/codex/auth-api.ts`, `src/codex/auth-collision.ts` | `4ef5350dc` |

**Correction — the release machinery is NOT untouched.** Measured from the
released v2.11.1, six commits touch `.github/**` and package manifests:

```
$ git log --oneline 121f1ad92..dc4dd45b0 -- .github/workflows scripts/release.ts package.json bun.lock
1e07b0e28 fix(ci): fail closed on readiness evidence
d6d3878c4 fix(ci): require aggregate check evidence
9970fe205 Merge #1336 chore: bump react-doctor to 0.9.11
31954a9ea chore: bump react-doctor to 0.9.11 and clear new findings
13a20c31a fix(ci): address CodeRabbit findings on hygiene gate trust boundary
73af78f8f fix(ci): keep Ready blocked while deterministic hygiene fails
```

These never received the security review `AGENTS.md` mandates for workflow
changes. That is the release blocker recorded in `012_security_gate_record.md`.

### CI evidence

- Exact-SHA gate on `dc4dd45b0`: Cross-platform CI run **31352564082 success**;
  PR hygiene, PR Labeler, and Enforce PR target branch also success. Service
  lifecycle did not run on this SHA (it is path-filtered).
- The recent `dev` history contains 22 cancelled and 3 failed runs. Every one
  was proven superseded by the green run on the descendant `dc4dd45b0` with
  `git merge-base --is-ancestor <sha> dc4dd45b0` (exit 0 for all 25).
- `service-lifecycle.yml`: last 15 runs all success.

### Local gates on `dc4dd45b0`

| Gate | Result |
|------|--------|
| `bun run typecheck` | exit 0 |
| `bun run test` | 10,526 pass / 7 skip / **0 fail**, 651 files, 344s |
| `bun run privacy:scan` | passed |

### The moving-tip problem

`dev` moved during this audit. `origin/dev` is now `277354073`
(`fix(server): bound live sideband websocket frames (#1398)`), and its
Cross-platform CI run **31354347276 failed**: the `macos` job failed at ~5m38s
and `test 4/4` was cancelled at ~15m (the #1302 signature).

This is the central release decision of the unit and is resolved in `010`.

### Known flake #1302

`183741b82` (PR #1370) bounded one `spawnSync` in `tests/cli-help.test.ts` so
shard 3 could not hang. It did **not** close the family: issue #1302 is still
open and the same 15-minute stall with an orphan Bun process recurred on run
31349399276 (shard 4/4) after the mitigation landed. Operational consequence:
budget one `gh run rerun --failed` per release gate, and treat a second hang on
the same release SHA as a stop rather than a third retry.

## Triage findings — the headline result

Both triage sweeps were run against the released-candidate tree, and both came
back with **nothing closable**:

| Sweep | Total | Closable now | Detail |
|-------|------:|-------------:|--------|
| Issues | 59 open | **0** | 1 becomes closable after this release (#1366); 37 unfixed; 21 need maintainer judgment |
| Pull requests | 20 open | **0** | 0 superseded; 9 viable; 8 need a maintainer decision; 3 stale but not superseded |

This is a real finding rather than a gap in the sweep. The previous two triage
campaigns (`260808_bug_campaign`, `260806_disposition_sweep`) already closed the
resolvable backlog, so what remains is genuinely open work. Closing anything
else would be closing on speculation, which the goal explicitly forbids.

Detail lives in `020` (issues) and `030` (pull requests).

## Loop-spec

- **Loop archetype:** spec-satisfaction. The release gates and the
  evidence-citation rule define done; there is no metric to maximize.
- **Trigger:** user-authorized release train plus issue/PR closure sweep.
- **Goal:** a published preview and stable release containing the delta, with
  branch convergence proven, and every closable issue/PR closed with cited
  evidence.
- **Non-goals:** fixing open bugs, merging contributor PRs, resolving #1302,
  force-push, branch deletion.
- **Verifier:** `bun run typecheck`; `bun run test`; `bun run privacy:scan`;
  `gh run list --commit <sha>` for exact-SHA gates; `release.yml` run success;
  `npm view @bitkyc08/opencodex dist-tags --json`; `gh release view <tag>`;
  `git merge-base --is-ancestor` for convergence.
- **Stop condition:** all criteria met, or a release gate fails deterministically
  twice on the same SHA.
- **Memory artifact:** this unit plus the goalplan ledger at
  `.codexclaw/goalplans/release-train-from-origin-dev-dc4dd45b0-90-commi/`.
- **Terminal outcomes:** DONE / NOOP / BLOCKED / UNSAFE / NEEDS_HUMAN /
  BUDGET_EXHAUSTED.
- **Resource bounds:** write scope is this repository's `dev`/`preview`/`main`,
  tags, GitHub releases, npm dist-tags, issue and PR state, and this devlog
  unit. Wall-clock is bounded by the release helper's 20-minute per-gate wait,
  plus at most one `--failed` rerun per gate.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | this doc, `001` | Docs-only roadmap: stabilization audit, triage inventories, release plan, audit fold-back | — |
| WP1 | `010`, `011`, `012` | Security gate, RC selection, preview publish, main publish, convergence proof | WP0 |
| WP2 | `020_issue_disposition.md` | Issue sweep outcome and any post-release closure | WP1 |
| WP3 | `030_pr_disposition.md` | PR sweep outcome and contributor-facing actions | WP1 |

Dependency order, not effort order: WP2 and WP3 depend on WP1 because an
issue fixed on `dev` is only honestly closable once the fix is published to the
users who reported it.

## Accept criteria

- **c1** — this unit exists with `000` plus diff-level `010`/`020`/`030`, and
  WP0 touched no production code.
- **c2** — stabilization is audited from exact-SHA CI evidence: no unsuperseded
  failure on the chosen RC, every cancelled run proven superseded.
- **c3** — a new preview and a new stable version are on npm with successful
  `release.yml` runs and existing GitHub releases and tags.
- **c4** — the released RC is contained in **both** `preview` and `main`,
  proven with `git merge-base --is-ancestor <RC> origin/preview` and
  `... <RC> origin/main` (sibling promotion, amended per audit blocker 3);
  local gates green on the RC.
- **c7** — an independent, non-author security review of the credential
  surface on the exact RC returns a non-`BLOCK` verdict, recorded in `012`
  (added per audit blocker 4).
- **c5** — every issue closed carries a comment citing its fixing commit and the
  released version.
- **c6** — every PR closed carries a comment citing its superseding commit;
  viable contributor PRs remain open.

## Open assumptions carried into A

1. The release convention is inferred from `git log --grep='^release:'` on
   `main`, not from a written policy document. If the owner intends `2.11.2`
   rather than `2.12.0`, the version is a one-line change and the rest of the
   plan is unaffected. The round-1 reviewer independently checked this and
   found the minor bump defensible (v2.11.0 was a 50-merge feature train;
   patch trains were materially narrower).
2. `#1302` is treated as a known operational flake, not a release blocker,
   because it is a CI-infrastructure hang with no product-code symptom and the
   full suite passes locally with zero failures.

## Audit corrections applied

Round 1 returned **FAIL** with 6 High and 1 Medium blocker; all 7 were verified
and folded in, none rebutted. See `001_audit_round1.md`. The two corrections
that changed the plan's shape rather than its wording:

- **Promotion is sibling, not chained.** The RC merges independently into
  `preview` and `main`; the preview release commit never reaches `main`.
- **Security review is a hard gate, not an assertion.** Four of the six
  credential-boundary PRs in this delta carry no `APPROVED` review, and #1352
  (the CL-03 live credential lease) was authored and merged by the same
  maintainer. `012` records the independent review that `AGENTS.md` requires.
