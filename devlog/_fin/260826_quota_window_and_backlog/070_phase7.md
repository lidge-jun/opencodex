# 070 — wp7: backlog triage devlog

## Deliverable

`devlog/_plan/260826_backlog_triage/` — a factual record of the current backlog so the next
maintainer session starts from evidence instead of re-auditing 39 items.

Two audits already ran against `dev` at `0a0a8821b` and their findings are written up rather
than re-derived.

## Stale pull requests — 18 audited

Verdicts, with "behind" as GitHub compare's count of `dev` commits absent from the PR head:

- **SUPERSEDED (closed in wp6):** #1769 (`74e8ce557`), #2215 (`7fdb2cb8e`).
- **REVIVABLE-SMALL:** #2033 — 14 lines across 2 files, and a real gap: both GET and PUT
  sidecar responses omit an `enabled` field
  ([config-routes.ts:571](../../../src/server/management/config-routes.ts) and :809). Worth a
  maintainer revival. Caveat: 869 commits behind.
- **REVIVABLE-LARGE:** #1794, #1829 (0 behind), #2050, #2122, #2299.
- **NEEDS-AUTHOR:** #1557, #1645, #1756, #2083, #2113, #2123, #2213, #2230, #2244, #2326.

Findings worth recording because they are non-obvious:

- **#1829 is 0 commits behind dev** with CI green — the only stalled PR that is not stale.
- **#2083 does not merely conflict, it disagrees.** The xAI image bridge landed via
  `de35caa4d`, but current code returns no image credential for OAuth configurations
  ([images/plan.ts:32](../../../src/images/plan.ts)) and the public guide states an API key is
  required. The PR proposes the opposite contract; that is an owner decision, not a rebase.
- **#1794 is a partial duplicate, not superseded.** Core recovery landed via `9bea7707b` and
  configurable OpenRouter routing via `3c6f3caa4`, but the PR's GUI exposure files have no
  equivalent on `dev`.
- **#2123 is NOT superseded** by existing Antigravity quota work: per-account eligibility
  still accepts Anthropic only ([quota.ts:1447](../../../src/providers/quota.ts)).
- No PR qualifies as abandoned — all 16 distinct author accounts still resolve. Conflict
  volume alone was not treated as abandonment.

## Open issues — 21 audited for quick-win feasibility

- **QUICK-WIN:** #2406 (wp3), #1215 (wp4), #1060 (wp5) — all three implemented in this loop.
- **ALREADY-DONE:** #2442, #2423 — closed in wp6 with code citations.
- **DECLINED WITH REASON:** #2060 — closed in wp6; 429 failover is the intended default.
- **MEDIUM (140-300 lines):** #2539, #2279, #2201, #1820, #1690, #1533.
- **NOT-QUICK (250-700 lines):** #2511, #2455, #2399, #2275, #2221, #2046, #1711, #1525, #1213.

`#1820` is the most attractive of the MEDIUM tier: the backend already computes aggregate
cache tokens and per-model estimated cost
([summary.ts:67](../../../src/usage/summary.ts)); only the GUI row types and tables omit the
columns.

## Structure

- `000_snapshot.md` — audit basis, date, dev SHA, method.
- `010_stale_prs.md` — the 18-row table with per-PR evidence.
- `020_issue_quick_wins.md` — the 21-row table with per-issue file:line evidence.
- `030_recommendations.md` — what to do next and in what order.

## Verification (C)

Files exist with the stated content, and every verdict carries a commit SHA or a file:line
pointer. A triage doc whose claims cannot be rechecked is worse than none — it ages into
confident misinformation.

Runs last: it records what wp6 actually closed.

