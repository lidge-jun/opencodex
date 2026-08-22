# 001 — PR verdicts (three parallel lanes, origin/dev @ 6e1a4e429)

Two triage lanes covered the six overnight PRs; every claim below was
verified against fetched `origin/dev` and the open stack #1069–#1072.
File-overlap with the stack is zero for all six.

## Verdict table

| PR | Author | Verdict | Core finding |
|----|--------|---------|--------------|
| 1085 | n3wr1ch | READY-FOR-REVIEW | clean; rename complete, locales consistent, tests real; security review is the merge gate |
| 1084 | agentHits | NEEDS-WORK | `googleAntigravityAccountPool` config has **no consumer** — pool/failover never activates; clear-cooldown for antigravity drains an anthropic-only map (no-op); duplicated quota fetch ignores `baseUrl`; hygiene `unsponsored_surface` |
| 1083 | agentHits | NEEDS-WORK | account filter only drives a badge — `usageTotals`/`quotaReport`/`modelUsage` stay combined; 4 dead i18n keys ×6 locales; hygiene `missing_regression_test` |
| 1081 | agentHits | NEEDS-WORK | does not compile: `locale` undeclared in `ProviderAuthPanel.tsx`, 6 locale files broken; shows OAuth token expiry where the issue asked for plan expiry; `expiresAt` already on dev (`src/oauth/index.ts:1126`, `12aff0102`) |
| 1079 | agentHits | NEEDS-WORK | does not compile: same broken-locale signature in all 6 files (`en.ts:662`); promised daily breakdown absent from diff; `yesterday` is rolling 48→24h, not calendar |
| 1077 | agentHits | NEEDS-WORK | closest to reviewable; CLI accepts refresh tokens via argv (repo convention is stdin `PIPE_GUIDANCE`); GUI change without screenshot; restricted surface needs sponsorship |

## Cross-cutting

- #1079 and #1081 share an identical i18n corruption signature (existing
  key's value displaced past inserted keys) — a faulty automated insert.
  Both PRs' "typecheck 0 errors" verification claims are false for the
  pushed state (parse failures reproduced with `bun build`).
- All five agentHits branches sit on `80e4075eb`, 17 commits behind dev —
  over the 10-commit readiness gate.
- None of the six is absorbed by dev or by the stack: no closes from this
  table. Dispositions are review comments, not closures (002).
