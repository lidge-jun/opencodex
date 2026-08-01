# Phase 2 Aggregate Display Plan

## Objective
Prove that cached token data is not only parsed, but also remains visible through request logs, usage summaries, and GUI-facing API shapes. Fix only if the proof fails.

## Code read
- `src/usage-summary.ts`: totals include `cachedInputTokens`, but `UsageModel` and `UsageProvider` do not expose cached-token breakdowns.
- `src/server.ts`: `/api/usage` fallback summary includes `cachedInputTokens: 0`; `usageFromResponsesPayload` handles Responses and ChatCompletions cached-token shapes.
- `tests/request-log.test.ts`: request log already checks cached token capture from Responses JSON.
- `tests/usage-summary.test.ts`: summary coverage exists but needs an explicit cached-token aggregate assertion.
- `gui/src/pages/Usage.tsx`: top summary type includes `cachedInputTokens`; model/provider rows focus on total tokens.
- `gui/src/pages/Logs.tsx`: per-request rows display `cached=<n>` when present.

## Scope boundary

### IN
- Add usage-summary regression coverage for `cachedInputTokens` totals across reported and estimated rows.
- Add API/fallback shape regression only if existing tests do not already cover it.
- Document that model/provider tables intentionally aggregate total tokens only; cached-token detail is top-summary and per-log level.

### OUT
- No GUI redesign in this phase.
- No live upstream calls.
- No new provider-specific cache forwarding.
- No changes to request log display unless tests reveal a missing field.

## Diff-level map

MODIFY: `tests/usage-summary.test.ts`
- Add one focused test asserting `summarizeUsage(...).summary.cachedInputTokens` sums cached token fields and does not affect `totalTokens`.
- Include an estimated provider row to prove Kiro-style estimated status still contributes numeric cached tokens if present.

MODIFY: `devlog/_plan/260701_cache-audit-hardening/01_cache-surface-audit.md`
- Add aggregate/display findings: request logs show per-request cached tokens; `/api/usage` top summary exposes `cachedInputTokens`; model/provider aggregates intentionally stay total-token-only.

No source change expected unless the new regression test fails.

## Acceptance criteria
- `bun test tests/usage-summary.test.ts tests/api-usage.test.ts tests/request-log.test.ts tests/usage-log.test.ts`
- `bun x tsc --noEmit`
- If no source code changes are needed, commit tests/docs only as an audit-hardening commit.
