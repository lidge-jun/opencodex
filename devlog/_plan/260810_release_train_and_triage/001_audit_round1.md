# 001 — A-phase audit round 1: verdict and fold-back

An independent adversarial reviewer audited `000`/`010`/`020`/`030` against the
live repository. **VERDICT: FAIL**, 6 High and 1 Medium blocker. Every blocker
was verified independently before being folded in; none were rebutted.

The one hypothesis the reviewer was specifically pointed at — that
`release.ts` might hang waiting for a `service-lifecycle` run that never fires
on the release SHA — was **disproved**. `release.ts:325` waits for both
workflows, and `package.json` is a trigger path in `ci.yml` *and*
`service-lifecycle.yml`, so the version-bump commit starts both. The plan was
right there.

## Blocker 1 (High) — verifiers read stale remote-tracking refs

`git rev-parse origin/dev` returned `277354073` while `git ls-remote origin
refs/heads/dev` returned `0a76ee854`. Every merge-tree dry run in `010` had
therefore certified an obsolete tree.

**Folded in.** All branch state is now pinned to `ls-remote` output taken at
decision time, and `010` requires a fresh `ls-remote` immediately before each
promotion. Pinned at 2026-08-10:

| Ref | SHA |
|-----|-----|
| `refs/heads/dev` | `0a76ee854a7605b9fed6c7dcc3844c0455425dc2` |
| `refs/heads/preview` | `4d1b1a4676a1dac045161cda0159594cf4e3dbda` |
| `refs/heads/main` | `121f1ad929dc6da3356c06f5192f2f97f7a5dde5` |

## Blocker 2 (High) — the RC decision was stale

`dev` advanced twice during the audit: `dc4dd45b0` → `277354073` (#1398,
bounded live sideband websocket frames) → `0a76ee854` (#1396, bounded
reset-credit lookup responses). Both are resource-exhaustion hardening, not
cosmetic, so `010`'s "one defensive commit with no reported user impact" was
wrong.

**Folded in.** The plan now spends its one authorized rerun on the live head
rather than silently dropping two hardening commits. See `011` for the outcome.

## Blocker 3 (High) — the promotion path contradicted policy

`010` step 3 merged the *preview release commit* into `main`, which imports the
prerelease version bump into the stable line and manufactures the very
`package.json` conflict the plan then had to resolve. `MAINTAINERS.md:22` says
promotion to `main` happens from `dev`.

**Folded in.** The corrected model is **sibling promotion**: merge the same
pinned RC independently into `preview` and into `main`, then let each branch
take its own version bump. Convergence is proven as `RC ⊆ preview` and
`RC ⊆ main`, not as `preview ⊆ main`. Accept criterion **c4** in `000` is
amended accordingly.

## Blocker 4 (High) — required security review was asserted, not evidenced

`000` claimed the six credential-boundary PRs "all arrived through review".
Checking review state disproves that:

- **#1352** — authored by `Wibias`, merged by `Wibias`, zero `APPROVED`
  reviews; only `coderabbitai` and self `COMMENTED`. This is the CL-03 live
  credential-lease subsystem, the highest-risk item in the delta.
- **#1353**, **#1358**, **#1360** — no `APPROVED` review state.
- **#1369** — has a genuine maintainer security re-review.

`AGENTS.md` calls this class of gap a release blocker, and `MAINTAINERS.md:45`
requires explicit security review for credential-boundary changes. A
PR-template checkbox is not that review.

**Folded in.** An independent non-author security audit of the credential
surface on the exact RC is now a hard precondition of WP1, recorded in `012`.
The release does not proceed on a `BLOCK` verdict.

## Blocker 5 (High) — the flake recovery could not actually resume

`010` said "rerun once" without a resume path. `waitForSuccessfulCi`
(`release.ts:217-228`) exits the process the moment it sees a completed failed
run — and by then the version bump is already committed and pushed. Re-invoking
the helper then dies at `npm version` because the version is already current
and `allow-same-version` is false.

**Folded in.** `010` now carries an explicit manual continuation keyed to the
existing release-bump SHA: wait for both workflows green on that SHA, re-read
the live branch head, dispatch `release.yml` with `expected-sha`, watch it.
That mirrors `release.ts:343` exactly and is the same recovery the 2026-08-09
train used.

## Blocker 6 (High) — this worktree cannot pass the clean-tree guard

`git status --porcelain` shows `.dirfd-probe-29692.ok` (a pre-existing
untracked artifact belonging to the user, not to this work) and this devlog
unit. `release.ts:297` aborts on any dirty tree.

**Folded in.** Releases run from the dedicated clean `preview` worktree at
`/Users/jun/.codex/worktrees/260728-preview/opencodex` and a separate clean
`main` checkout. The probe file is left untouched; nothing is stashed or
deleted on the user's behalf.

## Blocker 7 (Medium) — both inventories were already stale

Live counts moved during the audit: 61 open issues (not 59; #1400 and #1401 are
new) and 19 open PRs (not 20; #1396 merged). The zero-close conclusion may
survive, but a stale sweep cannot authorize writes to issue state.

**Folded in.** WP2 and WP3 re-run their inventories against the final released
state immediately before any closure. The reviewer's own falsification checks
(#1145, #1236, #938 already closed; #1161, #1008, #581 confirmed not
superseded) support the conclusion's direction.

## Disposition

All 7 blockers folded into the plan; 0 rebutted. Re-audit required before
`A → B`.
