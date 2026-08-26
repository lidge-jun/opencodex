# 000 — backlog triage: audit basis

## What this unit is

A factual record of the OpenCodex backlog as of 2026-08-26, so the next maintainer session
starts from evidence instead of re-auditing 39 items.

Two read-only audits produced it, both against `dev` at `0a0a8821b`:

- **Stale pull requests** — 18 open PRs, oldest first, checked for supersession, CI state,
  distance behind `dev`, and whether the feature landed some other way.
- **Open issues** — 21 issues checked against the actual code for quick-win feasibility.

Method: for each item, read the real body via `gh`, then verify the claim against the tree.
Nothing here is inferred from a title.

## The rule this unit follows

**Every verdict carries a commit SHA or a file:line pointer.** A triage document whose claims
cannot be rechecked is worse than none — it ages into confident misinformation, and the next
reader cannot tell which parts went stale.

Where an audit and the tree disagreed, the tree won and the disagreement is recorded.

## What was acted on immediately

Six items were terminal and were closed in the same loop (wp6):

| Item | Disposition |
|---|---|
| #2442 | already implemented — `openai-responses.ts:1587` |
| #2423 | already implemented — `empty-completion-guard.ts:309` |
| #2060 | declined with reason — 429 failover is the intended default |
| PR #1769 | superseded by `74e8ce557` |
| PR #2215 | superseded by `7fdb2cb8e` |

Three more shipped as implementations in the same loop: #2406 (wp3), #1215 (wp4), #1060 (wp5).

## Structure

- `010_stale_prs.md` — the 18-row PR table with per-item evidence.
- `020_issue_quick_wins.md` — the 21-row issue table with per-item file:line evidence.
- `030_recommendations.md` — what to do next, and in what order.

