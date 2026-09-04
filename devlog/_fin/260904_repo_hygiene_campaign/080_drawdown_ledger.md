# 080 — PR and issue drawdown ledger

## What the evidence actually showed

The campaign assumed a backlog full of superseded work. It was not. Running the
content-landing test against all 53 open PR heads found exactly one fully landed
(#3367, which merged during the campaign) and one mostly landed (#2877, a devlog
PR). Re-running it across 35 contributor PRs returned **0% landed for every
single one** — 68 files unlanded on #1645, 95 on #2462, 65 on #2113, and so on.

That is the finding, not a failure to find one: this backlog is not stale, it is
unreviewed. Closing those PRs as "superseded" would have destroyed real work and
told 30-odd contributors their submissions were duplicates when they were not.

## Overlap that looked like duplication and was not

A file-overlap pass surfaced 35 PR pairs sharing ≥30% of their files. Nearly all
were false positives of two kinds:

- **Intentional stacks.** #3340 → #3349 → #3350 (@Flowershangfromthebranches) is
  a declared 3-PR stack; each says so and names the commit that is uniquely its
  own. #3365 and #3370 target their parent's head branch, which is the
  documented stacked-PR workflow, not a duplicate.
- **Shared surface.** Ten GUI PRs touch `gui/src/pages/Models.tsx` and the i18n
  bundles because that is where GUI work lives. Co-editing a file is not
  supersession.

One real supersession existed: #3312 and #3348, same author, same 30 source
files, v2 versus v4 of one failover audit. #3348 fixes a cooldown key that v2
derives from a positional pool id — a correctness bug, not a style change — so
the older PR was closed toward the newer one with that diff quoted.

## Issues

| Verdict | Count |
|---|---|
| SUPERSEDED — closed, implementation cited | 3 |
| PARTIAL — closed into a consolidated issue | 11 |
| LIVE — left open | 24 |
| STALE-NOINFO — left open, specific request posted | 7 |

Closed as implemented: #1572 (policy fallback, cd7ea8a88 + 457c33675), #2288
(remote hub, 91a4f6c40), #3158 (four P2 follow-ups, eceb02d9d + 0d8147c20).

### Consolidated issues

| New | Absorbs | Theme |
|---|---|---|
| #3375 | #695, #1062, #1977, #2275 | OAuth account-pool lifecycle |
| #3376 | #2344, #2874, #2969 | quota history and reset windows |
| #3377 | #3268, #3271, #3281 | per-model capability declarations |
| #3378 | #3344, #3362 | OpenCode Go wire contract |
| #3379 | #2399, #2748, #3017 | dashboard management gaps |

Each consolidated issue states the surviving requirement in its own words, cites
the code that proves what already shipped, links every absorbed issue, and names
every original reporter. Each closure comment credits its reporter, says what
landed and what did not, and invites correction on the new issue. Where an
absorbed issue has an open PR against it (#2973, #3282), the closure says
explicitly that the PR is not superseded.

The seven STALE-NOINFO issues were not closed. Each got a comment saying where
the code stands and naming the one artifact that would unblock it. Closing a
report because the reporter has not answered yet is how a project stops
receiving reports.

## An attribution defect found in the carry PRs

Four maintainer PRs (#3371–#3374) carry contributor work. Three name their
author in a linked `Co-authored-by` trailer. #3374 carried @blackjune67's #3333
with:

```
Co-authored-by: hajune <june@smartix.co.kr>
```

That is the git identity on the contributor's commits, but GitHub matches
co-authors by **account-linked** email, so this trailer credits nobody —
@blackjune67 would not appear on the contributor graph for their own patch. The
description now carries
`blackjune67 <46661504+blackjune67@users.noreply.github.com>`, and the PR has a
comment telling whoever squashes it to keep that exact trailer.

This is the failure mode `CREDITS.md` exists to repair, caught before the merge
rather than after. `missing_coauthor_credit` in
`.github/scripts/pr-carry-attribution.cjs` verifies a trailer is *present*; it
cannot tell that a present trailer points at an unlinked identity. Worth
tightening, and recorded here rather than fixed silently.

## Final counts

| Surface | Before | After |
|---|---|---|
| Local branches | 241 | 171 |
| Remote branches | 61 | 59 |
| Open PRs | 53 | 56 |
| Open issues | 45 | 32 |

Open PRs rose because four carry PRs and two stacked PRs were opened by other
work during the campaign; one PR (#3312) was closed by it. Issues fell by 13
with 5 consolidated issues created — net 14 closed.
