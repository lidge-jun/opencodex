# wp2 — Lane A: approved, CI-clean bug PRs (#2798 security-gated)

Dependency position: after wp8. These two PRs are the cheapest correct merges in the
campaign, and they are the ones that prove the repaired base actually turns inherited red
into green.

## Members

| PR | head SHA | behind dev | state at triage | reviewer |
|----|----------|-----------|-----------------|----------|
| #2799 drop default_verbosity when verbosity is unsupported | e9a7bb7bb00f2ab73b9eee1479fbb115f544ebae | 94 | MERGEABLE/CLEAN, 7 real gates pass / 0 fail | Ingwannu APPROVED (exact head) |
| #2798 classify NAT64-embedded IPv4 instead of refusing the wrapper | 856ad72d414f27556729d70ed077e04494bb7336 | 97 | MERGEABLE/CLEAN, 8 real gates pass / 0 fail | Ingwannu APPROVED, "No reportable security issue remains in this diff." |

Both ship their own regression tests (tests/catalog-verbosity-default.test.ts,
tests/destination-policy-resolved.test.ts).

Neither is flagged by the hygiene gate's restricted-path list — running that predicate
returns `restricted=NONE` for both. **But #2799 and #2798 are not equivalent in risk, and
an earlier draft of this doc wrongly called both non-security.** #2799 changes
`src/codex/catalog/parsing.ts`, which is genuinely not a security surface. #2798 changes
`src/lib/destination-policy.ts`, which governs whether an OAuth bearer may be sent to an
overridden destination — a security boundary under `MAINTAINERS.md`'s "other
security-boundary changes", regardless of the mechanical list. #2798 is therefore
security-gated in this lane and needs its approval re-earned on the rebased head.

## Pre-verification already completed (2026-08-29)

Both were rebased onto the keystone branch in isolated /tmp worktrees before any push, and
the author patches survived byte-identically:

| PR | patch-id before | patch-id after | range-diff |
|----|-----------------|----------------|------------|
| #2799 | 358ba635ce5545fd280508f152d9b46c628db98b | 358ba635ce5545fd280508f152d9b46c628db98b | both commits `=` |
| #2798 | c1f9650e04863ecb64a981928091c9a582641ef1 | c1f9650e04863ecb64a981928091c9a582641ef1 | single commit `=` |

Tests on the repaired base (after `bun install` in each worktree):

```
#2799  tests/catalog-verbosity-default.test.ts      4 pass 0 fail
#2798  tests/destination-policy-resolved.test.ts +
       tests/release-version-line.test.ts          39 pass 0 fail
```

## Procedure per PR

1. Create a rebase worktree under /tmp (never the session worktree):
   git worktree add /tmp/ocx-lane-a-<N> <headSHA>
2. Record the author patch identity BEFORE rebasing:
   git diff-tree -p <base>..<head> | git patch-id --stable
3. git rebase origin/dev (the repaired dev from wp8).
4. Prove the author patch survived: git range-diff <oldBase>..<oldHead> origin/dev..HEAD
   must show only base movement, and git diff --name-only origin/dev...HEAD must list the
   same files as before.
5. Push the rebased head with --no-verify to the PR's own branch, then wait for exact-head
   CI. Merge only when ci, all four test N/4, macos, hygiene, and gates are green.
6. Merge with a merge commit (preserving the author commits), then record the merged SHA.

## Accept criteria

1. Both PRs merged into dev; gh pr view <N> --json state,mergedAt,mergeCommit confirms.
2. patch-id --stable before and after rebase is recorded for each; a changed patch id must
   be explained, not silently accepted.
3. Exact-head CI green per required check, quoted from gh pr checks.
4. Both authors keep authorship in git log on dev.
5. `bash scripts/ci/assert-mergeable-review.sh <N>` exits 0 on the FINAL head, and the merge
   uses `--match-head-commit`. A pre-rebase approval does not satisfy this: the repository
   ruleset has `dismiss_stale_reviews_on_push: false`, so GitHub keeps approvals that no
   longer describe the code.

## Out of scope

Any behavioral change to either patch. If a rebase produces a semantic conflict, the PR
leaves this lane and joins wp5.
