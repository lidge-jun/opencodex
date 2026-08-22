# 001 — Prior investigation index

Two read-only explorer lanes searched the whole tracked devlog corpus
(`devlog/_plan/**`, `devlog/_fin/**`) for every open issue and PR number, with
false-positive rejection: a bare integer match was discarded unless the
surrounding text used `#N`, `issue N`, `PR N`, or `pull/N` and the sentence
really referred to that item.

The output below is the answer to "was this already investigated" — which is the
question that decides whether the later work-phases re-derive anything.

## Headline

| Group | Count | Meaning |
|-------|------:|---------|
| Bug-class issues with **no** prior devlog investigation | 8 | genuinely new surface: #1061, #1059, #1057, #1046, #1045, #1043, #1024, #1017 |
| Bug-class issues investigated once | 1 | #994 |
| Bug-class issues investigated 3+ times | 8 | the long tail — #92 has been touched by **26** units |
| PRs with **no** prior investigation | 8 | #1056, #1047, #1039, #1036, #1019, #1018, #1010, #1008 |
| PRs with a recorded verdict | 17 | includes #1002 and #999 (one unit each); the rest mostly from `260805_bug_stack_campaign/002_pr_triage.md` |
| Drift candidates | 2 | #904, #796 |

The shape here is the useful finding. The old backlog is not under-investigated —
it is investigated to exhaustion. #92 (V2 cross-provider sub-agent loses NEW_TASK
body) has passed through 26 devlog units since 07-18 and is still open; #241
through 24; #418 through 19. Running a 27th generic sweep over them produces the
same sentence again. What is actually un-triaged is the last 48 hours of new
arrivals.

## Issues — prior art

`LATEST` marks the unit holding the most recent verdict.

| Issue | units | latest verdict | anchor |
|---:|---:|---|---|
| #1061 | 0 | — | `no prior investigation` |
| #1059 | 0 | — | `no prior investigation` |
| #1057 | 0 | — | `no prior investigation` |
| #1046 | 0 | — | `no prior investigation` |
| #1045 | 0 | — | `no prior investigation` |
| #1043 | 0 | — | `no prior investigation` |
| #1024 | 0 | — | `no prior investigation` |
| #1017 | 0 | — | `no prior investigation` |
| #1049 | 1 | "Adopting pre-substrate routed homes into the coordinator" | `devlog/_fin/260804_codex_write_substrate/041_wp12_closeout.md:1321` |
| #1048 | 1 | "WP13 composed acceptance — every production entry point funnelling through the substrate, not each helper passing its own test" | `devlog/_fin/260804_codex_write_substrate/041_wp12_closeout.md:1320` |
| #994 | 1 | "leave open; allowlist location identified, needs reporter's provider/model + wire capture" | `devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:18` |
| #919 | 4 | "Now embodied by #922/#966; we consume, not implement." | `devlog/_fin/260804_router_intelligence/000_master_plan.md:87` |
| #904 | 3 | "leave open; `eeef7a32a` fixed surrogate boundaries but the original capture is still needed" | `devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:19` |
| #796 | 6 | "leave open pending live Ark credential verification; structural fix `d3abf4345` + regression test already on dev" | `devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:20` |
| #418 | 19 | "leave open; latest same-run trace does not reproduce; needs reporter's current trace" | `devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:21` |
| #417 | 17 | bucketed as feature/provider/tracker/upstream | `devlog/_fin/260805_bug_stack_campaign/001_issue_triage.md:39` |
| #241 | 24 | bucketed as feature/provider/tracker/upstream | `devlog/_fin/260805_bug_stack_campaign/001_issue_triage.md:39` |
| #92 | 26 | bucketed as feature/provider/tracker/upstream | `devlog/_fin/260805_bug_stack_campaign/001_issue_triage.md:39` |
| #540 | 7 | bucketed as feature/provider/tracker/upstream | `devlog/_fin/260805_bug_stack_campaign/001_issue_triage.md:39` |

Non-bug open issues (#974, #823, #822, #821, #820, #809, #755, #695, #657, #572,
#561, #415, #414, #386, #201, #178, #177, #95) share the same bucket line at
`001_issue_triage.md:39`, with #820/#809 additionally at `:41`
("Improvement #820 and #809 are code-level and stay in the campaign's improvement
bucket; #820 is a larger architecture epic — deferred to its own unit").

## PRs — prior art

| PR | units | latest verdict | anchor |
|---:|---:|---|---|
| #1056, #1047, #1039, #1036, #1019, #1018, #1010, #1008 | 0 | — | `no prior investigation` |
| #1002 | 1 | "includes ignored-CLI-setting defect" | `devlog/_fin/260805_bug_stack_campaign/002_pr_triage.md:33` |
| #999 | 1 | "docs-only, draft" | `devlog/_fin/260805_bug_stack_campaign/002_pr_triage.md:31` |
| #997, #985, #983, #978 | 1 | "These stay open; the campaign does not close contributor work that merely needs the author." | `devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:43-45` |
| #947 | 2 | not carried because it conflicts with #942; author must resolve | `devlog/_fin/260803_bug_backlog_stack/070_outcome.md:100-103` |
| #936 | 2 | conflicting; requires explicit security review per MAINTAINERS | `devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:42-45` |
| #937, #872, #870, #812, #811 | 1 | "Feature programs — out of scope" | `devlog/_fin/260805_bug_stack_campaign/002_pr_triage.md:35-37` |
| #715 | 5 | out of scope here; earlier: "land after #671, rebase, add combined-selector regression, and pass credential-selection review" | `devlog/_fin/260802_issue_pr_triage/000_research.md:124-125` |
| #581 | 5 | `NEEDS-CHANGES`; missing parity/picker tests, extraneous script | `devlog/_fin/260731_pr_issue_triage_round/010_pr_triage_matrix.md:105` |
| #569 | 5 | draft, CI pass but conflicting/dirty; leave open | `devlog/_fin/260805_bug_stack_campaign/002_pr_triage.md:32` |
| #557 | 9 | `NEEDS_HUMAN` for second-maintainer review | `devlog/_fin/260728_bug_bundle_resolution/050_pr557_boundary.md:65-69` |

## Drift candidates

Both are the same shape: a devlog recorded a landed fix while the issue stayed
open. Neither is necessarily wrong — both were deliberately left open pending
reporter evidence — but both need an ancestry check in WP2 rather than a
re-reading of the note.

- **#904** — `eeef7a32a` claimed for surrogate boundaries
  (`devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:19`).
- **#796** — `d3abf4345` claimed as a structural fix already on `dev`
  (`devlog/_fin/260805_bug_stack_campaign/130_dispositions.md:20`).

The PR lane found **no** drift candidates: nothing recorded as merged is still open.

## What this changes about the plan

WP2 splits by prior-art status, not by issue age:

- **Lane A — the 8 uninvestigated issues.** These get real research: reproduce or
  structurally prove against `8949c4940`.
- **Lane B — the 2 drift candidates.** These get one ancestry check each, nothing more.
- **Lane C — the exhausted tail.** These get a carry-forward verdict citing the
  existing anchor, plus a statement of what evidence would move them. Re-investigating
  #92 for the 27th time would be the exact waste this index exists to prevent.
