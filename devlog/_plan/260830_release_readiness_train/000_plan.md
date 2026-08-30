# 260830 — Release-readiness train for `dev`

Snapshot: `dev@47b8d1643` (v2.36.0), open-PR/issue manifest taken 2026-08-30T01:46:46Z.
Later arrivals are out of scope for this unit by construction; they queue for the next one.

## Execution state

The snapshot remains the audit boundary, but it is no longer the integration head. `origin/dev` is
now `dca16949b` with #2952 merged. That PR landed cleanly because its head was left untouched after
the contributor's author-bound review-readiness attestation.

The planned repairs are already present at #2957 head `08c5b5005`, #2950 head `79b5eab34`, #2953
head `12a4d92fa`, and #2947 head `be3d28706`. Those pushes also reset each exact-head checklist and
returned all four contributor PRs to DRAFT/BLOCKED/REVIEW_REQUIRED. A maintainer cannot attest the
author checklist on the contributor's behalf. The remaining landing work is therefore to cherry-pick
each contributor's commits plus its repair onto a maintainer-owned branch, preserving Git author
metadata, open a maintainer PR that credits the author and names the original PR it carries, and close
the original as carried once that replacement is established.

The original Windows baseline is unavailable. Run `33286530705` on `47b8d1643` was cancelled at
02:02:16Z after #2952 merged at 02:01:56Z and its competing `dev` push run entered the same ref-keyed
concurrency group; all four Windows shards died with it. Recovery has already been dispatched from
the isolated branch `codex/win-gate-260830`: run `33287093789` on `dca16949b`. That post-#2952 run is
a different baseline, not a substitute pass for `47b8d1643`.

The goal is a `dev` that is ready to promote: every bug-class pull request in the snapshot
has a terminal disposition, the priority issues that are actually fixable now are fixed,
and the final head is green on the three gates that matter — Cross-platform CI on a
`push` event, Service lifecycle, and the Windows leg, which only `workflow_dispatch`
can start (`.github/workflows/ci.yml`, `platform-windows.if`).

## Candidate set and how it was chosen

Of 56 open pull requests, eight are bug-class, target `dev`, are not drafts, and are small
enough to audit to a verdict in one pass: #2947, #2949, #2950, #2951, #2952, #2953, #2955,
#2957. Every one was a fork PR with `maintainerCanModify=true`, but that permission does not
make a repaired contributor head mergeable: a push resets the exact-head author attestation.
Repaired candidates use maintainer-owned carry PRs instead.

The rest are excluded on stated grounds rather than by neglect: drafts under
CHANGES_REQUESTED (#2939, #2921, #2860, #2881, #2954, #2956), maintainer stacks awaiting
their own trains (#2771 → #2789, #2783, #2877, #2940), large refactors (#2805, #2462), and
feature work whose review is not a bug fix (#2818, #2083, #1829, and the long tail).

## Audit verdicts

Each PR was audited in an isolated worktree against its own head, with focused tests only.
A green CI check was treated as necessary and not sufficient; every verdict below rests on
reading the diff and running the covering test files.

| PR | Subject | Verdict | Blocker found |
|---|---|---|---|
| #2952 | README asset check tells files from directories | MERGE_AS_IS | none; guard driven red twice to prove it is not vacuous |
| #2955 | one log record per empty-completion notice | MERGE_AS_IS | none; fresh per-request observer state, no body in the notice |
| #2950 | capacity panel survives an unformattable expiry | MERGE_AS_IS on its own diff | inherits #2951's xAI defect through the shared commit |
| #2951 | drop expiry timestamps no formatter can render | MERGE_AFTER_FIX | valid xAI `creditUsagePercent` discarded with the bad reset |
| #2953 | namespaced MCP exec must not authorize bare shell | MERGE_AFTER_FIX | authorized bare `tool_choice` selector now 502s |
| #2947 | start when proxy settings hold unconstrained values | MERGE_AFTER_FIX | invalid proxy silently becomes direct egress, no warning |
| #2957 | install gui deps the local runner needs | MERGE_AFTER_FIX | Windows path separators in the test; partial install cached as complete |
| #2949 | scope the test-run lock to the user | REIMPLEMENT | home-rooted lock couples hosts across a network mount; unwritable home aborts discovery |

### The #2950/#2951 relationship

They are not two independent fixes. `6fcd39ac0` — the `src/providers/quota-wire.ts` change
and its `tests/command-code-quota.test.ts` case — is byte-identical in both branches, and
#2950 adds GUI work on top. So #2950 supersedes #2951 rather than conflicting with it, and
the xAI blocker found in #2951 is present in #2950 too. One repair commit, applied to
#2950, closes both. #2951 then closes as superseded, with the superseding merge named.

## Overlap matrix

Intersecting the changed-file sets, not the titles:

```
#2957 x #2949   scripts/test.ts, tests/test-runner.test.ts
#2951 x #2950   src/providers/quota-wire.ts, tests/command-code-quota.test.ts  (identical commit)
#2955 x #2953   src/server/responses/core.ts
```

Everything else is disjoint. Three collisions, and each one dictates an ordering constraint
rather than a conflict to resolve at merge time.

## Merge order

1. #2952 — DONE at `dca16949b`; touches only `tests/repo-hygiene.test.ts` and collides with nothing.
2. #2957 — repairs DONE at `08c5b5005`; carry the contributor commits and repair through a
   maintainer-owned PR. Lands the `scripts/test.ts` shape that #2949 rebuilds on.
3. #2949 — reimplemented on top of #2957, so the runner surface has one author at a time.
4. #2950 — repair DONE at `79b5eab34`; carry it through a maintainer-owned PR, then close #2951
   as superseded by the carried merge.
5. #2955 — first of the two `core.ts` PRs, because it is MERGE_AS_IS and adds no branch.
6. #2953 — bare-selector repair DONE at `12a4d92fa`; carry it through a maintainer-owned PR
   rebased onto #2955.
7. #2947 — operator-warning repairs DONE at `be3d28706`; carry them through a maintainer-owned
   PR. Only `src/config.ts`, no collision.

`core.ts` is the one file two PRs both edit, and it is a core-path file: `src/router.ts`,
`src/server/lifecycle.ts`, and `src/server/responses/core.ts` must not reach `src/lab`.
`tests/core-lab-boundary.test.ts` was run for both and stays in the gate for the repairs.

## Issue triage

Fifteen issues were audited against `47b8d1643` in four parallel lanes. The honest result is
that most of the backlog is not fixable-now work:

| Issue | Class | Disposition |
|---|---|---|
| #2899 | REAL_BUG_FIXABLE_NOW | implement — Antigravity Gemini 3.7 Flash rejects one system-prompt paragraph, blocking Claude Code Task subagents |
| #1298 | FEATURE_SMALL | implement — Windows ACL mutation runs unconditionally where a read-only proof would do |
| #1690 | FEATURE_SMALL | finish #2860's core rather than reimplement #2122 |
| #2885, #2813, #1527, #1419 | NEEDS_INFO | each needs a measurement nobody has taken; implementing now would ship a hypothesis |
| #2901, #2894, #2279, #1711, #1221, #1525, #2730 | FEATURE_LARGE | design cycles, not release patches |
| #2288 | NEEDS_INFO | docs recipe, blocked on reporter confirmation |

#2885 deserves a note because it looks like a P1 bug and is not actionable: the report is
against Bun 1.3.14, `dev` bundles 1.4.0, and the fix hinges on whether pinning HTTP/1.1
resolves it — a Windows measurement, not a patch decision.

## Work phases

| Phase | Content | Doc |
|---|---|---|
| wp1 | #2952, #2957 (+2 repairs), #2949 (reimplemented) | `010` |
| wp2 | #2950 (+xAI repair), #2951 closed as superseded | `020` |
| wp3 | #2955, #2953 (+repair), #2947 (+repairs) | `030` |
| wp4 | issue #2899 — Antigravity system-prompt compatibility | `040` |
| wp5 | issue #1298 — read-only ACL proof gate | `050` |
| wp6 | final gates: push CI, service lifecycle, Windows dispatch, close-out | `060` |

## Verification contract

The local full suite is not run in this train; focused `bun test` files carry each change
locally, and the merge-time evidence is remote CI on the exact head. The Windows leg is
dispatched once at the start of the train and once on the final head, because a `push` run
skips it and would otherwise leave the platform unmeasured across seven merges. Every Windows
dispatch targets a dedicated branch ref, never `dev`: `.github/workflows/ci.yml:52` groups both
push and manual runs by `github.ref` with `cancel-in-progress: true`, so the next merge's `dev`
push can cancel a `dev`-targeted dispatch and all four Windows shards with it.
