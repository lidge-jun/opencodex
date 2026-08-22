# 020 — WP3: open pull-request verdicts

> **Status: EXECUTED.** Sections above `# Verdicts (executed)` are the phase spec
> as it stood when WP3 ran, kept for auditability; the table at the bottom is the
> result.

## What this phase must produce

One row per open PR with a disposition, the CI/base evidence behind it, and a
prior-art pointer.

## The structural filter comes first

Before any diff is read, three mechanical facts decide most of the surface. From
`002`:

1. **Freshness.** Only #1019 (2 behind), #1018 (4), #1010 (5), #1056 (7) satisfy
   the readiness gate's "latest `dev` or at most 10 commits behind". The other 21
   are 196–1514 commits behind.
2. **Mergeability.** #947, #936, #811, #715, #581, #569 are `CONFLICTING`.
3. **Checks.** #1019 and #1010 fail `hygiene`; #936 and #872 fail `label`; #569
   fails `enforce-target`; #811 fails five platform legs; #557 fails four.

A PR that is conflicting, or red, or 200+ commits behind, cannot be
`ready-to-review` no matter how good the change is — so those rows are settled by
structure and the diff read is spent only where it can change the answer.

## Lanes

### Lane P1 — the four fresh PRs

#1019, #1018, #1010, #1056. These are the only candidates that could plausibly
merge today. Each needs: the failing check's actual log line (for #1019, #1010),
scope sanity, and whether the change duplicates something already on `dev`.

#1019 is 47 commits ahead across 100 files, which is large enough that "hygiene
fails" may be the least of it; the row must say whether the size is a review
blocker in itself.

### Lane P2 — the conflicting six

#947, #936, #811, #715, #581, #569. Disposition is bounded by
`stale-needs-author` unless a stronger reason applies. Two need a stronger
reason recorded:

- **#936** carries a security boundary (`fix: harden credential and runtime trust
  boundaries`) and prior art says it needs explicit security review per
  `MAINTAINERS.md`. Its disposition is `blocked`, not `stale-needs-author`, because
  a rebase alone does not unblock it.
- **#715** is 1514 commits behind with 42 commits of its own. The row must state
  whether a rebase is even tractable or whether the change should be re-authored.

### Lane P3 — behind-but-clean contributor PRs

#1047, #1039, #1036, #1002, #999, #997, #985, #983, #978, #937, #872, #870, #812.
Green or policy-only-red, mergeable, but far behind. For each: does the change
still apply to today's code, and did anything on `dev` already supersede it? A
PR whose target code has been rewritten needs that said explicitly, not a generic
"please rebase".

#1036 claims to fix #1017, which is a Lane A issue in WP2 — that pair is resolved
in WP4, not here.

### Lane P4 — maintainer PRs

#1008 and #557, both `lidge-jun`. #1008 is green and mergeable but 326 behind;
#557 is red on four legs and has nine prior devlog units, the latest recording
`NEEDS_HUMAN` for second-maintainer review. Neither gets a special pass for
authorship.

## Exact item ledger (25 rows)

```
P1 fresh (4):        1019 1018 1010 1056
P2 conflicting (6):  947 936 811 715 581 569
P3 behind-clean (13):1047 1039 1036 1002 999 997 985 983 978 937 872 870 812
P4 maintainer (2):   1008 557
```

## Self-modification map

| File | Action | Content |
|------|--------|---------|
| `020_pr_verdicts.md` | MODIFY (done) | appended `# Verdicts (executed)` with the 25-row table |
| any other file | — | none |

## Executable commands

Copy-paste runnable as-is. `PRS` is the ledger above; no placeholders.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
PRS="1019 1018 1010 1056 947 936 811 715 581 569 1047 1039 1036 1002 999 997 985 983 978 937 872 870 812 1008 557"

# 1. failing check names
for n in $PRS; do
  echo "== #$n"
  gh pr view "$n" --json statusCheckRollup \
    --jq '.statusCheckRollup[]?|select(.conclusion=="FAILURE" or .conclusion=="CANCELLED")|"\(.name)\t\(.conclusion)"'
done

# 2. freshness WITHOUT writing local refs — GitHub compare API, read-only
for n in $PRS; do
  head=$(gh pr view "$n" --json headRefOid --jq .headRefOid)
  gh api "repos/lidge-jun/opencodex/compare/dev...$head" \
    --jq "\"$n head=${head:0:9} merge_base=\(.merge_base_commit.sha[0:9]) ahead=\(.ahead_by) behind=\(.behind_by)\""
done

# 3. every issue reference in a PR body, untruncated and type-resolved
for n in $PRS; do
  gh pr view "$n" --json body,title --jq '[.title, .body]|join("\n")' \
    | grep -oE '#[0-9]{2,4}' | sort -u | tr -d '#' | while read -r ref; do
        kind=$(gh api "repos/lidge-jun/opencodex/issues/$ref" \
          --jq 'if .pull_request then "PR" else "ISSUE" end + " " + .state')
        echo "$n -> $ref $kind"
      done
done
```

Command 2 replaces the earlier `git fetch ...:refs/remotes/prq/<n>` form. That
fetch writes local refs, which contradicts this unit's read-only scope; the
compare API returns `ahead_by`/`behind_by` against `dev` without touching the
working repository. Note the direction: GitHub's `compare/dev...head` reports
`behind_by` as commits on `dev` missing from the head, which is the number this
unit calls "behind".

Every row records the head sha it was judged against, because a head that moves
mid-phase invalidates a freshness verdict silently otherwise.

## Issue references already extracted (feeds WP4)

| PR | references |
|---:|---|
| 1036 | fixes #1017 |
| 999 | tracks #241 (docs only) |
| 1010 | `Closes #1009` |
| 1039 | separated from closed #922; rebased past #1023 |
| 1019 | continues #671 and #949 |
| 1018 | rebased after RI-09 (#1016) |
| 936 | rebase of #916; explicitly *not* superseded by #917 |
| 557 | supersedes #533, maintainer takeover |

## Table format (mandatory columns)

```
| PR | disposition | head sha | behind/ahead | checks | mergeable | evidence | prior art |
```

## Accept criteria

- 25 rows, one per open PR, no omissions.
- Every row records the head sha used for its freshness judgment.
- Every `stale-needs-author` row names the specific blocker (conflict, red check,
  or behind-count), not a generic staleness claim.
- Every `superseded-by` claim defers to WP4 rather than being asserted here.
- No row recommends a merge; this unit has no merge authority.

---

# Verdicts (executed)

Base `origin/dev = aaa71967a`, 2026-08-05T13:59:09Z. Head shas as recorded in `002`.

| PR | disposition | head sha | behind/ahead | checks | mergeable | evidence (blocker) | prior art |
|---:|---|---|---:|---|---|---|---|
| 1019 | stale-needs-author | `dd2cd6d9f` | 7/47 | `hygiene` FAILURE | MERGEABLE | red check + 100 files / 47 commits is a review-size problem in itself | none |
| 1018 | ready-to-review | `b3dae43b6` | 9/15 | ok | MERGEABLE | none — green, mergeable, inside the gate | none |
| 1010 | stale-needs-author | `0e37a89d8` | 10/8 | `hygiene` FAILURE | MERGEABLE | red check; at the gate boundary and drifting | none |
| 1056 | stale-needs-author | `3a7cc03ee` | 12/1 | ok | MERGEABLE | fell out of the 10-commit gate during this session | none |
| 1047 | stale-needs-author | `18784cdea` | 201/2 | ok | MERGEABLE | 201 behind | none |
| 1039 | stale-needs-author | `199382912` | 253/1 | ok | MERGEABLE | 253 behind | none |
| 870 | stale-needs-author | `59d551c0a` | 278/2 | ok | MERGEABLE | 278 behind | `260805_bug_stack_campaign/002_pr_triage.md:35-37` |
| 1036 | stale-needs-author | `a35115c39` | 297/4 | ok | MERGEABLE | 297 behind; targets #1017, itself UNVERIFIED | none |
| 1008 | stale-needs-author | `b0d5417d8` | 331/4 | ok | MERGEABLE | 331 behind; maintainer-authored, no special pass | none |
| 1002 | stale-needs-author | `eb017e087` | 331/4 | ok | MERGEABLE | 331 behind | `002_pr_triage.md:33` (ignored-CLI-setting defect) |
| 947 | stale-needs-author | `015ca8fcd` | 331/2 | ok | **CONFLICTING** | conflict target #942 is now closed — a plain rebase | `260803_bug_backlog_stack/070_outcome.md:100-103` |
| 812 | stale-needs-author | `a1dcde8cb` | 388/3 | ok | MERGEABLE | CHANGES_REQUESTED + 388 behind | `002_pr_triage.md:35-37` |
| 985 | stale-needs-author | `db284da38` | 428/3 | ok | MERGEABLE | 428 behind | `130_dispositions.md:43-45` |
| 983 | stale-needs-author | `1ad2be010` | 436/3 | ok | MERGEABLE | 436 behind | `130_dispositions.md:43-45` |
| 978 | stale-needs-author | `753ffdc37` | 474/1 | ok | MERGEABLE | 474 behind | `130_dispositions.md:43-45` |
| 569 | stale-needs-author | `15613e672` | 478/6 | `enforce-target` FAILURE | **CONFLICTING** | red check + conflict | `002_pr_triage.md:32` |
| 999 | stale-needs-author | `d849dc631` | 497/1 | ok | MERGEABLE | 497 behind; docs-only, tied to the #241 pair | `002_pr_triage.md:31` |
| 997 | stale-needs-author | `4b6532bdd` | 497/1 | ok | MERGEABLE | 497 behind for a 1-file test-isolation fix | `130_dispositions.md:43-45` |
| 937 | stale-needs-author | `d717f77e7` | 620/1 | ok | MERGEABLE | 620 behind; #572 batch sibling | `002_pr_triage.md:35-37` |
| 936 | blocked | `727722cba` | 620/4 | `label` CANCELLED | **CONFLICTING** | **requires security review per MAINTAINERS.md**; a rebase alone does not unblock it | `130_dispositions.md:42-45`; `260804_stack7_service_vision/030_merge_and_close_sequence.md:108-112` |
| 872 | stale-needs-author | `fc7222f78` | 620/2 | `label` CANCELLED | MERGEABLE | red check + 620 behind; #572 batch sibling | `002_pr_triage.md:35-37` |
| 557 | blocked | `c297dba30` | 869/18 | 4 legs FAILURE | MERGEABLE | trust-boundary review outstanding | `260728_bug_bundle_resolution/050_pr557_boundary.md:65-69` (`NEEDS_HUMAN`) |
| 581 | stale-needs-author | `e1cf92fa5` | 935/13 | ok | **CONFLICTING** | CHANGES_REQUESTED; 74 files of localization | `260731_pr_issue_triage_round/010_pr_triage_matrix.md:105` |
| 811 | stale-needs-author | `faee6a650` | 1271/8 | 5 legs FAILURE | **CONFLICTING** | red + conflict + 100 files | `002_pr_triage.md:35-37` |
| 715 | stale-needs-author | `cfe0f4d3c` | 1519/42 | ok | **CONFLICTING** | 1519 behind with 42 own commits — rebase tractability is itself in question | `260802_issue_pr_triage/000_research.md:124-125` |

## Reading the table

**One PR is actually reviewable today: #1018.** Green, mergeable, 9 behind, 15
commits, 23 files. Everything else is blocked by something its author controls or
by a review authority this unit does not hold.

**Two are `blocked`, not stale, and the distinction matters.** #936 and #557 both
touch credential and trust boundaries. Telling their authors to rebase would be
wrong advice: even a perfectly rebased #936 cannot merge without the security
review `MAINTAINERS.md` requires. Prior art has said so since 07-27
(`devlog/_fin/260727_owner_decision_ledger/010_bug_bundle_fixability.md:36-47`),
and repeating "please rebase" for a fourth round would be the failure mode.

**#715 is the one where "rebase" may be the wrong ask.** 1519 commits behind with
42 of its own, across 62 files, in the account-pool selection path that
`260804_router_intelligence` has since reworked. The row does not recommend a
close — that is not this unit's authority — but a maintainer decision between
"re-author against current `dev`" and "close with thanks" is more honest than
another rebase request.

**The behind-counts are not the author's fault in most cases.** `dev` moved five
commits during this session alone. A PR at 201 behind was opened against a tree
that no longer exists in any practical sense; that is a statement about merge
latency in this repository, not about contributor diligence.
