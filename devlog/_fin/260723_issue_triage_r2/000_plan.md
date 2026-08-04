# 260723 Issue Triage R2 — New Pile Sweep

- Worktree: `/Users/jun/.codex/worktrees/08c8/opencodex`, branch `codex/260723-issue-triage-r2`
- Base: `origin/dev` @ af973e54; integration target is `dev`
- Session: 019f8da7-0b41-7573-b119-1062cf8e4835
- Prior lane: `devlog/_plan/260723_issue_triage/` covered the overnight #287-#300 sweep.
  This R2 lane covers the newly accumulated open set as of 2026-07-23 (KST evening).

## Scope

Open issues as of 2026-07-23 (15 open). Split:

- Main (this agent): #314 RAM leak (Windows 11, v2.7.31) — suspected Windows-side leak,
  direct investigation.
- Sol (parallel): triage lanes for the remaining issues — classify, verify against
  current `dev`, propose next action per issue. Read-only on GitHub (no comments,
  labels, closes without approval).

## Open set snapshot

| # | Title | Labels |
|---|-------|--------|
| 315 | Codex Auth: primary_window monthly vs weekly UI | - |
| 314 | 램 누수 (RAM leak, Win11, v2.7.31) | bug |
| 311 | Shadow call intercept mismatch Codex 0.145.0 (gpt-5.6-luna) | - |
| 294 | Claude account pool parity | - |
| 290 | V2 custom-model parent empty spawn_agent args | needs-info |
| 252 | Claude Code subagent placeholder shows Sonnet | enhancement |
| 241 | Routed models missing from Desktop picker | bug, upstream-tracking |
| 208 | Native /v1/chat/completions endpoint | enhancement |
| 201 | TRAE provider | enhancement, roadmap |
| 178 | Factory provider | enhancement, roadmap |
| 177 | Warp provider | enhancement, roadmap |
| 95 | Multi-user hosting / LiteLLM | enhancement, roadmap |
| 92 | V2 cross-provider sub-agent NEW_TASK loss | bug, upstream-tracking |
| 42 | Storage page for session usage | enhancement, roadmap |

## Units

- `010_sol_triage_lanes.md` — Sol triage output (all issues except #314)
- `020_issue314_memleak.md` — RAM leak investigation (main agent)

## Result (2026-07-23)

- Bucket A (actionable on dev): #315 quota-window classification (src/codex/quota.ts:112-135
  treats monthly primary_window as weekly), #311 shadow intercept literal
  (src/server/responses.ts:949-963 only matches gpt-5.4-mini, misses gpt-5.6-luna).
- Bucket B (needs-info): #290 (no reporter reply since capture request).
- Bucket C (upstream): #241, #92 (labels verified correct), #314 → Bun 1.3.14 Windows
  runtime leak (see 020; corroborated by oven-sh/bun#28035 and our own user's
  oven-sh/bun#32585). Mitigation lane: evaluate Bun pin bump 1.3.14 → 1.4.x
  (security-review lane — touches CI/release pins).
- Bucket D (roadmap/park): #294, #252, #208 (tracked by PR #279), #201, #178, #177, #95, #42.
- No GitHub mutations, no production code changes. Next work-phases if approved:
  (1) #315 fix + tests, (2) #311 fix + tests, (3) Bun pin bump spike behind CI.
