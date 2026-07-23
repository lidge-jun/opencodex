# 260723 Issue Fixes — #315 / #311 / #252

- Worktree: `/Users/jun/.codex/worktrees/08c8/opencodex`, branch `codex/260723-issue-triage-r2`
- Base: `origin/dev` @ af973e54
- Session: 019f8da7-0b41-7573-b119-1062cf8e4835 (HOTL goal loop, goalplan slug
  `fix-three-triaged-opencodex-issues-315-quota-mon`)
- Triage source: `devlog/_plan/260723_issue_triage_r2/010_sol_triage_lanes.md`
- Reviewer: Sol (gpt-5.6-sol, effort medium, service tier priority)

## Objective

Fix three confirmed, bounded defects/UX issues on `dev`:

1. **#315** — WHAM `primary_window` with `limit_window_seconds=2628000` (~30.4d) is
   unconditionally classified weekly by `parseUsageQuota`.
2. **#311** — shadow call intercept matches only the `gpt-5.4-mini` literal; Codex
   0.145.0 uses `gpt-5.6-luna` for helper calls, so the intercept silently stops firing.
3. **#252** — subagent placeholder guidance says `model: "sonnet"`, which makes
   placeholder-labeled calls indistinguishable from genuine Sonnet calls in the UI.

## Constraints

- Scope: `src/`, `tests/`, `devlog/` only. No `gui/`, no docs-site locale rewrites,
  no push/merge/release, no further GitHub mutations.
- Each WP: `bun run typecheck` + `bun run test` green; new regression tests must fail
  against pre-fix code; Sol review verdict recorded; local commit per WP.
- Behavior compatibility: accounts without `limit_window_seconds` must keep today's
  classification exactly (no drift for Plus/Pro/legacy payloads).

## Work-phase map (dependency-ordered)

| WP | Doc | Issue | Surface | Depends on |
|----|-----|-------|---------|------------|
| WP0 | this + 010/020/030 | — | docs only | — |
| WP1 | `010_issue315_quota_window.md` | #315 | `src/codex/quota.ts` + tests | WP0 |
| WP2 | `020_issue311_shadow_intercept.md` | #311 | `src/server/responses.ts`, `src/types.ts` + tests | WP0 |
| WP3 | `030_issue252_placeholder_haiku.md` | #252 | `src/claude/agents-inject.ts` only + tests | WP0 |

WP1-WP3 are mutually independent (disjoint write sets); ordered by user-facing severity.

## Evidence base (verified against af973e54)

- #315 reporter's live WHAM payload: `primary_window { used_percent, reset_at,
  limit_window_seconds: 2628000, reset_after_seconds }`, `secondary_window: null`,
  `tertiary_window: null`, `plan_type: "team"`. Weekly accounts show `604800`.
- `src/codex/quota.ts:10-21` (`WhamUsageResponse`) discards `limit_window_seconds`.
- `src/codex/quota.ts:101-137` (`parseUsageQuota`) maps primary→weekly unconditionally
  except the `go|free` thirty-day plan special case.
- `src/server/responses.ts:949-963` shadow intercept: `parsed.modelId.startsWith("gpt-5.4-mini")`.
- `src/types.ts:484-494` documents the intercept as gpt-5.4-mini-only.
- `src/claude/agents-inject.ts:234-236` `NO_MODEL_ARG` recommends `model: "sonnet"`.
