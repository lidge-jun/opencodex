# 070 — close, selectively stage, and push

Date: 2026-08-01  
Work phase: wp8  
Depends on: 010–060 complete; 060 records `Open gap count: 0`  
Execution status: procedure only; this docs-only B-phase performs no commit or push.

## Terminal outcome

Close the unit only after the exact implementation HEAD passes typecheck, the full Bun
test suite, and privacy scan; the diff contains no unrelated work; the local commit is
pushed without force; and local HEAD, `origin/dev`, and remote `refs/heads/dev` resolve
to the same SHA.

The unit targets `dev`. `main` and `preview` are not moved by this phase.

## Preflight: freeze the checkout

Run from `/Users/jun/Developer/new/700_projects/opencodex`:

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git remote -v
git status --short --branch --untracked-files=all
```

Required assertions:

- repository root is exactly the path above;
- branch is `dev` unless the parent explicitly records an approved integration branch;
- remote `origin` is the intended OpenCodex repository;
- no merge/rebase/cherry-pick is in progress;
- every dirty path is classified as this unit, a named exclusion below, or unrelated
  user work that remains untouched.

Fetch read-only remote state immediately before integration:

```bash
git fetch origin dev
git rev-parse HEAD
git rev-parse origin/dev
git merge-base --is-ancestor origin/dev HEAD
git merge-base --is-ancestor HEAD origin/dev
```

If `origin/dev` advanced, do not push a stale direct update. Reconcile using the parent's
approved integration method, rerun every gate on the new exact HEAD, and refresh 060
source anchors if the rebase/merge changed them. Never force-push `dev`.

## Required change audit

Review both tracked and untracked scope:

```bash
git status --short --untracked-files=all
git diff --stat
git diff --check
git diff -- src tests docs-site gui structure scripts .github
git diff -- devlog/_plan/260801_zero_leak_state_stores
```

Acceptance:

- 010 implements durable spill, explicit miss, cleanup, accounting, and tests;
- 020 implements provenance-split blob admission plus replay/image/vision bounds;
- 030 implements only the locked TTL/reconciliation/admission assignments and receives
  the required Windows ACL security review;
- 035 covers every registry/flight/value item and returns coherent busy errors;
- 040 exposes privacy-safe `appOwnedBytes` and deterministic retained-store demotion;
- 050 bounds every translator accumulator and preserves normal 20+ interleaved calls;
- 055 keeps native shell execution disabled by default and owns every enabled child;
- 060 has commit-pinned evidence, no unexplained unknowns for the claimed cohort, and
  records `Open gap count: 0`;
- user-facing configuration/docs are synchronized, including translated configuration
  pages where an existing English field table has locale peers;
- no source/test behavior differs from the decade docs without the docs being amended
  first.

## Gate sequence

Run on one frozen HEAD with no edits between commands:

```bash
bun run typecheck
bun run test
bun run privacy:scan
```

The full suite is mandatory because this unit crosses continuation, adapters, auth,
management API, filesystem hardening, workers, and stream conversion. Focused phase
tests are useful during implementation but do not replace `bun run test` here.

Record for each gate:

- command and UTC/local timestamp;
- exact `git rev-parse HEAD` before the command;
- exit code and concise final output/counts;
- machine/OS/Bun version;
- zero failures, crashes, timeouts, or cancellations.

A cancellation is not a pass. A Bun crash is not a test assertion failure. Diagnose and
repair the concrete class, then restart the entire terminal gate sequence from
typecheck. Do not raise a timeout merely to turn an unexplained wait green.

Also run `git diff --check` after the gates. Documentation-only warnings or pre-existing
unrelated failures must be reported and resolved by the parent; they cannot be silently
declared out of scope when they block a required command.

## Selective staging contract

These paths are explicit exclusions and must never enter this unit's index/commit:

```text
devlog/_plan/260731_client_config_export/
devlog/_chase/DSCodex/
devlog/_plan/260801_pr611_volcengine_evidence/
```

Do not use broad staging commands such as `git add .`, `git add -A`, `git add devlog`, or
`git commit -a`. Build an explicit path list from the audited change manifest, then add
only those files. The list will include the implemented `src/`, focused/full-regression
`tests/`, synchronized `docs-site/` pages, and this unit's own decade documents.

Before commit, prove exclusions and scope:

```bash
git diff --cached --name-only
git diff --cached --stat
git diff --cached --check
git diff --cached
```

Fail staging if any cached path begins with an exclusion prefix, if any unrelated dirty
path is staged, or if any expected unit file is absent. Unstaged/untracked excluded work
is preserved exactly as found.

Suggested commit subject after the parent approves the final staged diff:

```text
fix(state): hard-bound retained and translator stores
```

No commit is created by this roadmap-writing task.

## Push procedure

The unit-level roadmap records authorization to push to `origin/dev`, but the executor
must still re-read current parent instructions at execution time. If authorization was
revoked or branch policy changed, stop before external mutation.

Immediately before push:

```bash
git status --short --branch
git rev-parse HEAD
git fetch origin dev
git rev-parse origin/dev
git merge-base --is-ancestor origin/dev HEAD
```

Required state is a clean index/worktree except preserved named exclusions/unrelated
user files, and `origin/dev` is an ancestor of the tested local HEAD. Push without force:

```bash
git push origin HEAD:dev
```

If the push is rejected because remote advanced, fetch/reconcile and rerun all terminal
gates. Do not use `--force`, `--force-with-lease`, or push a merge that was not gated.

## HEAD parity proof

After successful push, collect three independent values:

```bash
local_head=$(git rev-parse HEAD)
tracking_head=$(git rev-parse origin/dev)
remote_head=$(git ls-remote origin refs/heads/dev | awk '{print $1}')
test "$local_head" = "$tracking_head"
test "$local_head" = "$remote_head"
```

Then report the literal SHA and the successful equality checks. Do not report “pushed”
from command exit alone. Re-run `git status --short --branch` and list preserved dirty
paths so the user can see that exclusions survived.

If CI is part of the parent's completion gate, verify checks on this exact SHA rather
than a branch-name snapshot. Classify test failure, timeout, runner crash, and
cancellation separately; do not rerun or alter remote CI without current authorization.

## Unit closure record

Append the final evidence ledger/attestation to the unit's owning plan document, then
move the unit from `_plan` to `_fin` only after:

- all gates pass on pushed parity SHA;
- 060 has zero open gaps and only evidence-supported comparative wording;
- security review for the Windows ACL change is recorded;
- no required source/docs/test changes remain;
- named exclusions remain outside the commit.

The move itself must be selectively staged with the same exclusion audit. Record the old
and new path, final SHA, gate evidence, review verdict, push parity, and any explicitly
preserved unrelated work.

## Stop conditions

Stop and report instead of improvising when:

- checkout, branch, remote, or target SHA differs from the frozen scope;
- a locked decision cannot be preserved without truncation/silent continuation loss;
- Windows ACL review does not approve repeated-temp hardening;
- a required gate fails, crashes, times out, or is cancelled;
- remote `dev` advances after the final gates;
- selective staging cannot separate this unit from overlapping user work;
- 060 has any unconverted gap or unsupported superiority claim.

## Commit

`docs(devlog): close zero-leak state-store hardening`

## Explicitly not changed by closure

- No release promotion to `main` or `preview`, version bump, npm publish, tag, or
  GitHub Release.
- No force-push, unrelated PR/issue mutation, CI rerun/cancel, or branch-protection
  change.
- No cleanup, staging, reset, or overwrite of unrelated dirty/untracked work.
- No superiority claim unless 060's immutable-source and zero-gap gates pass.
