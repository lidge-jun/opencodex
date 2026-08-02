# 010 — Merge Candidates: Gate Checklist + Merge Plan (wp2)

Each candidate gets one independent reviewer subagent reading the full diff
and CI rollup before any merge. Gates per MAINTAINERS.md: targets `dev`,
required CI green on current head, at least one maintainer approval (owner
review here counts, provided the reviewer is not the PR author — none of
these six is authored by lidge-jun), security review where the surface
touches a security boundary. A candidate that fails a gate is skipped,
documented here, and gets a needs-author-work comment instead (folded into
wp6).

## Per-PR checklist

### PR 866 — feat(codex): classify reset-eligible quota rejection
- Triage: full CI green (Linux/Windows/macOS + npm-global gates); bounded
  body handling; focused tests; first slice of issue #657; no maintainer
  review yet.
- Security surface: touches quota-rejection classification (account-pool
  semantics) but no credential storage; reviewer must confirm classification
  is fail-closed (unknown shapes must not be treated as reset-eligible).
- Merge plan: comment "merged, scheduled for next release" then
  `gh pr merge 866`.

### PR 862 — docs(codex): clarify pool routing and account continuity
- Triage: docs-only, locales synced, CI green, bot findings resolved.
- Gate: docs consistency (no contradiction with src behavior). Low risk.

### PR 860 — fix(responses): gate service tiers by provider capability
- Triage: prevents OpenAI-only `service_tier` breaking DeepSeek; capability
  modeling + registry backfill + wire tests + multilingual docs. Agent saw
  only target/label checks — reviewer must confirm full CI ran green on the
  current head before merge.

### PR 854 — fix(claude): honor authoritative context windows in generated profiles
- Triage: minimal fix + regression test; partial CI visibility — same
  full-CI check required.

### PR 853 — feat(server): reasoning-effort ladders on raw /v1/models
- Triage: CI green, bot findings addressed, Wibias (maintainer) verified.
- Public API surface (/v1/models payload) — reviewer confirms the added
  fields are additive-only.

### PR 653 — feat(providers): Baseten Model APIs preset (conditional)
- Triage: Ingwannu security APPROVED on current head; CI green; stale
  lidge-jun CHANGES_REQUESTED outstanding. Provider preset = credential-
  destination change: reviewer must verify the contributing-guide evidence
  is present in the PR thread — documented OpenAI-compatible endpoints
  (including authenticated `GET /v1/models` when the entry declares
  `liveModels`), terms of service and operating legal entity, resale or
  routing authorization when the preset is an aggregator, a named
  maintenance owner, and a citable verification date.
- Owner (lidge-jun) is executing this triage; if the independent review
  passes, the stale CR is superseded by this owner re-review and the PR
  merges. If evidence is incomplete, skip + request it.

## Merge mechanics

- Comment first: "Merging — this is scheduled for the next release train
  (dev -> main promotion + npm release are maintainer-controlled)."
- Merge with the repo's usual strategy (check recent dev history; default
  `gh pr merge <n> --merge` unless history shows squash convention).
- Record merge SHA + comment URL per PR in this doc's results section.

## Results (2026-08-02, wp2 executed)

Six independent reviewer subagents (one per PR) read full diffs, CI rollups,
and local source. Outcome: 2 merged, 4 blocked with precise feedback — the
meticulous review caught real defects that green-CI snapshots had hidden.

| PR | Verdict | Outcome |
|---|---|---|
| 862 | MERGE | MERGED 2026-08-02T00:02:36Z; comment 5154095016 |
| 653 | MERGE | MERGED; owner re-review superseded stale CR; comment 5154097081 |
| 866 | NO-MERGE | classifier not fail-closed (trim/lowercase + ambiguous shapes); blocking comment 5154104384 |
| 860 | NO-MERGE | unknown capability fails open; volcengine-agent-plan exposed; no full CI; comment 5154104403 |
| 853 | NO-MERGE | Luna advertised ultra vs canonical max; test gap; windows CI pending; comment 5154105797 |
| 854 | NO-MERGE | stale 200k Sonnet 4.6 metadata vs upstream 1M; registry omits windows; no full CI; comment 5154105790 |

Note: 854's blocker overlaps #839's needed reconciliation (Claude 4.6/4.7
1M source of truth) — flagged for coordination in the 854 comment.
