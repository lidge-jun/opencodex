# Phase 30 Antigravity Cache Visibility Plan

## Objective
Investigate the user report that Google Antigravity caching appears not to work, prove the actual runtime behavior from local usage logs, and make per-request cached-token counts visible in the dashboard table instead of hiding them in a tooltip.

## Findings before edit
- Local `/Users/jun/.opencodex/usage.jsonl` contains 222 `google-antigravity-*` rows.
- 149 rows include numeric `usage.cachedInputTokens`; recent examples include `inputTokens=159132`, `cachedInputTokens=154663`.
- Recent failed Antigravity rows are 429/502 rate/upstream failures and one Claude-on-Antigravity 400, not missing cache parsing.
- `src/adapters/google.ts` maps Gemini/Antigravity `usageMetadata.cachedContentTokenCount` to `OcxUsage.cachedInputTokens` for both streaming and non-streaming paths.
- `gui/src/pages/Logs.tsx` currently shows only total tokens in the visible table cell; cached tokens are only in `title`, so the UI can look like caching is absent.

## Official-source baseline
- Google Gemini docs describe implicit caching as automatic for repeated prefixes and expose cached tokens through usage metadata.
- Explicit Google cached-content resources are separate and are not implemented in this pass.

## Scope

### IN
- Add Antigravity-specific regression coverage proving `response.usageMetadata.cachedContentTokenCount` becomes `cachedInputTokens` in non-streaming and streaming CCA envelope parsing.
- Make request-log token cells visibly show cached-token counts when present, while preserving total-token display.
- Run targeted Google/usage/log tests, typecheck, and GUI build.

### OUT
- No live upstream calls.
- No Google explicit cached-content resource manager.
- No changes to Antigravity auth, quota, or model availability in this slice.
- No push.

## Diff-level map

MODIFY: `tests/google-antigravity-wire.test.ts`
- Add non-streaming test: CCA `response.usageMetadata.cachedContentTokenCount` is mapped to `done.usage.cachedInputTokens`.
- Add streaming test or extend existing stream unwrap test to assert cached usage survives usage-only final chunks.

MODIFY: `gui/src/pages/Logs.tsx`
- Add visible cached-token sublabel or badge in the Tokens column when `log.usage.cachedInputTokens` is numeric.
- Keep total token formatting as the primary visible value and keep the existing tooltip detail.

MODIFY: `devlog/_plan/260701_cache-audit-hardening/01_cache-surface-audit.md`
- Record Antigravity runtime evidence and clarify that visible dashboard logs now expose cached tokens per row.

## Acceptance criteria
- `bun test tests/google-antigravity-wire.test.ts tests/adapter-usage.test.ts tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts`
- `bun x tsc --noEmit`
- `bun run --cwd gui build`
- Independent read-only verifier confirms Antigravity cache parsing and dashboard display evidence.
