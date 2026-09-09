# 000 — admin-merge remaining ready PRs, starting with #3190

Frozen at `origin/dev` = `5557772b7` (after #3189), 2026-09-02T02:40Z.
Worktree: `codex/260902-admin-merge-3190` tracking `origin/dev`.
Session: `01a05b23-083f-7413-a4d8-159a2ff4e2a1`.

## Loop-spec

- Archetype: HOTL maintainer merge train. One work-phase per PABCD cycle.
- Trigger: user said merge remaining ready work with admin, `--no-verify` pushes, no local full suite.
- Goal: land #3190 on `dev`, close superseded #2734, then refresh the live non-draft inventory and land only authorized mechanical leftovers.
- Non-goals: new product features, remote host QA, PDF/guide work, merging drafts, merging conflicting PRs, merging security-boundary PRs without a named security review, local `bun run test`.
- Verifier: `gh pr checks` on the exact head SHA (full rollup, not `--required` empty), then `git fetch origin && git merge-base --is-ancestor <merge> FETCH_HEAD`. Privacy repair also needs `bun run privacy:scan` exit 0.
- Stop: DONE when the inventory refresh finds no remaining authorized MERGEABLE item; BLOCKED if privacy/CI cannot be repaired without a new product change; UNSAFE if an auth/credential/workflow/release/dependency PR would land without security review.
- Memory: this unit. Goalplan slug `admin-merge-remaining-ready-opencodex-prs-onto-o`.
- Escalation: stop for a missing owner choice between two overlapping feature PRs that are not a documented carry.
- Resource bounds: this worktree + `gh`; serialize pushes/merges; unlimited `xai/grok-4.6` read-only reviewers already authorized.

## Class

C4 for the merge itself (protected `dev`, admin bypass). The only production-adjacent write in this train is the privacy-scan text fix in wp1. #3190's unique commits already exist; wp2 rebases and lands them.

## Why #3190 is first

It is the only current non-draft, MERGEABLE, maintainer-authored feature PR that is not `CHANGES_REQUESTED` and not a stale carry. Head `5f8cd24dd` is two unique commits on merge-base `e40245e4c` (#3169). It is 19 commits behind `origin/dev`. Cross-platform CI `gates` already failed on Privacy scan because GitHub merges that head with current `dev`, and current `dev` contains two remote-macOS home citations in `devlog/_plan/260902_multiplatform_qa_and_gui/091_wp6_merge_outcome.md`.

The scan only flags the macOS home-path shape. POSIX home prefixes and the Windows npm prefix that uses the allowed username `user` are a different detector. Allowed usernames in `devlog/` are the maintainer account plus `u` / `user` / `me` / `test`. The two remote macOS usernames in 091 are none of those.

## Why the other non-drafts are not in this train

| PR | Disposition | Reason |
| --- | --- | --- |
| #3142 | DEFER | CONFLICTING, CHANGES_REQUESTED |
| #3061 | DEFER | MERGEABLE but CHANGES_REQUESTED; macos/ci red; prior train already parked it |
| #2986 | DEFER | carry of #2083, CHANGES_REQUESTED; do not merge both |
| #2877 | DEFER | docs closeout, CHANGES_REQUESTED |
| #2805 | DEFER | CONFLICTING |
| #2783 | DEFER | CONFLICTING, CHANGES_REQUESTED |
| #2527 | DEFER | CONFLICTING, CHANGES_REQUESTED |
| #2366 | DEFER | MERGEABLE but CHANGES_REQUESTED, contributor feature |
| #2083 | DEFER | APPROVED original of the #2986 carry; merging both is forbidden |
| #2734 | CLOSE after #3190 | draft, CONFLICTING, superseded by #3190 |

wp3 re-reads this table live. A new MERGEABLE non-conflicted item that appears after #3190 can be appended; shrinking the table to escape the loop is forbidden.

## Work-phase map (dependency-ordered)

```
wp0  this unit (docs-only)                         -> 000 + 010 + 020 + 030
 ├── wp1  anonymize leaked remote home paths       -> 010
 ├── wp2  rebase + exact-head CI + admin-merge 3190, close 2734  -> 020
 └── wp3  refresh leftover inventory               -> 030
```

Stack decision (`DEV-STACK-01`): do **not** stack wp1 under #3190. wp1 is a one-file text fix that every later PR inherits once it is on `dev`. Landing it first, then rebasing #3190 onto that tip, is cheaper than a mid-stack cascade. wp2 and wp3 are sequential because each merge invalidates the next candidate's merge-base.

## Scope boundary

**IN**

- Text-only anonymization of the two remote macOS home citations in 091 (and 020 if the Windows path is also a forbidden home-path hit).
- Rebase of #3190 unique commits onto current `origin/dev` after wp1 lands.
- `--no-verify` push of the rebase branch, exact-head CI, authorized admin squash merge.
- Close #2734 with credit after #3190 is an ancestor of `origin/dev`.
- Live refresh of open non-draft PRs; admin-merge only items that are MERGEABLE, not conflicting, not CHANGES_REQUESTED without a documented carry, and not security-boundary.

**OUT**

- Local full suite.
- Direct push to `dev`/`main`/`preview`.
- Merging #2083 and #2986 together.
- Re-implementing review blockers on parked PRs.
- Any auth, credential, workflow, release, or dependency-install change.

## Verifier commands that actually exist

- `bun run privacy:scan` -> `scripts/privacy-scan.ts` (reads `git ls-files`, including 091). Live run on HEAD `befefeb20` **exit 1**. Hits 091 line 13, two remote macOS homes. This is the wp1 red proof. After wp1 the same command must be exit 0 and name no 091 line.
- `gh pr view 3190 --json number,headRefOid,mergeable` live at freeze: `{"head":"5f8cd24ddf01082f35079c695a810324c33f4b3e","mergeable":"MERGEABLE","n":3190,"state":"OPEN"}` exit 0. Reads GitHub PR 3190, not the local 091 file.
- `gh pr checks 3190` live: `gates` fail (Privacy scan, job 99959406196, run 33538646261). Reads the exact-head check rollup for `5f8cd24dd`.
- `git merge-base --is-ancestor e40245e4c origin/codex/adaptive-reasoning-effort-2731` is true (merge-base of 3190). After merge, the command becomes `git fetch origin && git merge-base --is-ancestor <merge> origin/dev` and must exit 0.

Deferred non-draft freeze (same `gh pr list --state open` pass): #3142 CONFLICTING+CHANGES_REQUESTED, #3061 MERGEABLE+CHANGES_REQUESTED with macos/ci red, #2986 carry of #2083 CHANGES_REQUESTED, #2877 CHANGES_REQUESTED, #2805/#2783/#2527 CONFLICTING, #2366 CHANGES_REQUESTED, #2083 APPROVED original of the carry, #2734 draft CONFLICTING.

No `bun run test`. Focused tests only if wp2's rebase conflict touches `src/` or `tests/` unexpectedly.

## Field chain (PLAN-FIELD-CHAIN-01)

No new runtime field. N/A: this train does not add config/API keys. #3190 already added `reasoningEffortMode` and `omitReasoningEffortWithToolsModels` on its own branch; wp2 lands that existing chain, it does not invent a second one.

## Bypass named (PLAN-BYPASS-NAMED-01)

Admin squash merge is the named bypass of required maintainer approval on owner-authored PRs. It does not bypass: exact-head CI evidence, `enforce-target`, privacy:scan, or security review for security-boundary diffs. Record the bypass rationale on each merge comment.
