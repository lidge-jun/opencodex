# 000 — Plan: overnight triage round 2 (2026-08-06)

## Objective

Triage everything that arrived after the 260805 bug-fix stack went up
(#1069/#1070/#1071/#1072, all CI-green, none merged), close what is proven
absorbed or duplicated, and extend the stack with fixes for newly proven
defects.

## Base

| Fact | Value |
|------|-------|
| `origin/dev` | `6e1a4e429` (merge of #1018 RI-10 routing UI) |
| Open stack | #1069 dev←deepseek-ladder, #1070 stacked on 1069, #1071, #1072 |
| Dirty user files | `src/usage/log.ts`, `tests/usage-log.test.ts` (500k cap — untouched) |

## Overnight inventory (since 2026-08-05T14:00Z)

### Issues

| # | Label | Item | First-look verdict |
|---|-------|------|--------------------|
| 1086 | enhancement | service_tier override on the fly | feature, not bug — out of scope |
| 1082 | enhancement | Gem quota display for Antigravity | feature — out of scope |
| 1078 | bug | shadow-call dropdown saves bare id | CONFIRMED at code level, dup of #1075 |
| 1076 | enhancement | Cockpit Tools account import | feature, PR #1077 attached |
| 1075 | bug | identical body to #1078, same author | canonical candidate (earlier timestamp) |
| 1073 | enhancement | fallback context window in Models GUI | feature — out of scope |
| 1065 | provider-compat | DeepSeek V4 Flash 502 on bounded JSON path | RCA lane dispatched |

### PRs

| # | Author | State | Lane |
|---|--------|-------|------|
| 1085 | n3wr1ch | ready | triage lane B |
| 1084 | agentHits | draft | triage lane B |
| 1083 | agentHits | draft | triage lane B |
| 1081 | agentHits | draft | triage lane A |
| 1079 | agentHits | draft | triage lane A |
| 1077 | agentHits | draft | triage lane A |

## Confirmed defect: #1075/#1078 shadow-call bare id

The reporter's root cause is real and locatable in source, not just the
bundle. Two selects exist for the same setting:

- `gui/src/pages/Models.tsx:914` uses `shadowModelOptions` →
  `activeModelOptions` (`models-shared.ts:96`) → `value: m.namespaced`. Correct.
- `gui/src/pages/dashboard-overview-sections.tsx:363` builds options inline
  from `ModelInfo` (`dashboard-shared.ts:42` — `{ id, provider }`, no
  namespaced field) with `value: m.id`, `label: provider/id`. This is the
  reporter's decompiled snippet, byte for byte.

`shadowCallIntercept.model` feeds `parsed.modelId` in
`src/server/responses/core.ts:1380-1400` and then `routeModel`
(`src/router.ts:668`), where a bare id resolves to the native provider. The
namespaced form is what routes to custom providers, so the dashboard select
silently breaks interception exactly as reported.

Fix shape: make the dashboard select emit `${m.provider}/${m.id}` as the
value (matching the Models page), and keep the select rendering older saved
bare values without jumping (value fallback). Regression test in gui tests.

## Work-phase map

| Phase | Doc | Content |
|-------|-----|---------|
| wp1 | 000-00x | this plan + lane reports as they land |
| wp2 | 130-style dispositions | duplicate close #1078→#1075, PR verdict actions |
| wp3 | 010 | shadow-call namespaced value fix (stack extension) |
| wp3 | 020+ | further decade docs if lanes prove more fixable defects (e.g. #1065) |

## Out of scope

Merging to dev, #1059 Windows suite, feature issues (1086/1082/1073/1076),
and the user's usage-log cap change.
