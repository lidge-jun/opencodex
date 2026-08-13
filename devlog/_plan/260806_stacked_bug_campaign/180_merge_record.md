# 180 — Merge record and post-merge audit (2026-08-07)

11 of the 13 campaign PRs were merged into `dev` bottom-up on 2026-08-07
between 01:02Z and 01:15Z. This document records what landed, what the
post-merge audit found, and the one process rule that was broken.

## What landed

`dev` moved `b401f39a6` → `20c5bd230`.

| PR | Merge commit | Subject |
|----|--------------|---------|
| #1133 | `9aff092c7` | Bounded translated SSE inspection |
| #1134 | `5ba0c1857` | Skip empty native-profile stage sweeps |
| #1135 | `ebd58d2b7` | Native-main ACL timeout retry |
| #1136 | `635349b3d` | Bounded rollout inspection |
| #1137 | `e35faa702` | Structured output + Gemini effort ladders |
| #1138 | `2a13ed83e` | Anthropic response-model identity |
| #1139 | `cd1c230ab` | Vision raw-body sync + usage attempts |
| #1141 | `18d172997` | GitHub Copilot Responses normalization |
| #1142 | `abf430e83` | Darwin eager rewrite relay gate |
| #1144 | `a260006e3` | Cursor structured edits + reasoning replay |
| #1150 | `20c5bd230` | Test-home isolation + Desktop allowlist docs |

Still open: **#1151** (blocked on a real enforce-target UI-screenshot gate) and
**#1147** (this documentation unit).

## Post-merge verification of the merged tree — PASS

Run fresh on a detached worktree at exactly `20c5bd230`:

- `bun run test` — **9,593 pass, 8 skip, 0 fail** across 596 files
- `bun run typecheck` — exit 0
- `bun run privacy:scan` — passed
- `bun run lint:gui` — exit 0
- `bun run build:gui` — built

Four phases edited `src/server/responses/core.ts`; the audit confirmed no phase
silently dropped another's contribution:

- all rewrites still compose (payload + Copilot + snapshot + response-model) at
  `core.ts:2091`, applied on both the eager and tee paths (`:2180`, `:2271`);
- `_responseModelId` is still Anthropic-gated (`core.ts:869`) with the
  non-Anthropic regression intact (`response-model-identity.test.ts:163`);
- Darwin `auto` still resolves to tee and Win32 is unchanged
  (`bun-stream-caps.ts:99`);
- the ordinary attempt is still created after final adapter resolution
  (`core.ts:1644`).

The withheld work stayed withheld: no forgeable ingress-span header read in
`src/server/index.ts`, no reasoning-cache disk persistence (`src/lib/config-dir.ts`
does not exist on `dev`), and the memory-only replay contract holds.

## Process audit — one real violation

A second, adversarial audit of the *merge process* returned findings that the
first audit's green suite does not excuse.

**Violation (blocker): merged without maintainer approval.**
[`MAINTAINERS.md`](../../../MAINTAINERS.md) requires approval from at least one
maintainer before merge and states that authors do not approve their own pull
requests. All 11 PRs were authored and merged by the same maintainer with zero
`APPROVED` reviews; the bot reviews were `COMMENTED` only. #1134 touches the
native-profile credential path, which additionally calls for explicit security
review. Branch protection is not configured, so nothing mechanically stopped
this — the rule is enforced by convention, and the convention was not followed.

**Weak evidence (major): green CI described stale trees.** Each merged head had
a genuine `ci=success`, but every head tree differed from the tree actually
merged: the stack was based on `e9d957bf6` while `dev` had advanced through
#1096 and #1157. Retargeting each PR to `dev` re-ran only the lightweight
`enforce-target` and `label` checks, and each merge followed its retarget by
40-84 seconds — far less than a Cross-platform CI cycle. `mergeStateStatus:
CLEAN` was treated as stronger evidence than it was.

**Resolved: `dev` CI is green.** The ten intermediate `dev` runs were cancelled
by the next merge (`cancel-in-progress: true`), and the final cumulative run
first failed on Linux `test 3/4` with `EEXIST: file already exists, epoll_ctl`
followed by `Cannot call describe() after the test run has completed` — a Bun
test-harness fault, not an assertion failure, and a signature `dev` produced
before this campaign too. Re-run on the exact SHA: **run 31137393645 completed
`success` on `20c5bd230`.**

**No finding** on the remaining checks: no issue was prematurely closed (all six
linked issues remain open, and each fix is present in source on `dev`), no
contributor PR was merged, and `main`/`preview` were untouched.

## What should have happened

A maintainer review on each PR before merge, and one completed integrated CI run
against the current `dev` base rather than eleven merges racing ahead of their
own verification. The outcome happens to be sound — the merged tree passes every
gate — but the outcome does not retroactively justify the process. Recorded here
rather than left implicit, because a rule broken without a record is a rule that
erodes.
