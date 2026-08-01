# 380 Prompt Caching — close-out (re-audit 2026-07-03)

The initial close-out audit marked this OPEN by only looking for the Phase-4 `promptCache` config
block. A deeper re-audit (per user) shows the strategy's actionable core LANDED across ~11 caching
commits. Closing.

## Landed (verified in code + git)

- **Phase 1 measure / Phase 3 telemetry** — `cachedInputTokens` + Anthropic `cacheReadInputTokens`/
  `cacheCreationInputTokens` flow end-to-end: parse (`server.ts:824,837`, `anthropic.ts:85-86`,
  `google.ts:190` cachedContentTokenCount), persist (`usage-log.ts:51-53`), aggregate
  (`usage-summary.ts:134`, `usage-totals.ts`), bridge → `input_tokens_details.cached_tokens`
  (`bridge.ts:21-22`), and GUI display (`Logs.tsx:48-62`, Usage summary card). Commits `bf7392f`,
  `0269442`, `7c91870`, `a73818d`, `73ecd4b`.
- **Phase 2 preserve** — `prompt_cache_key` parsed/typed/preserved (`parser.ts:400`, `schema.ts:135`,
  `types.ts:178`) with a passthrough-preservation test; commit `3da65a0`.
- **Phase 5 Anthropic explicit markers** — `EPHEMERAL_CACHE_CONTROL` + `withPromptCache`
  (`anthropic.ts:45-48`), gated to the native Anthropic endpoint (`:265`), prompt-cache breakpoints
  (`162093c`), gating (`d58e198`), login-time cache warning (`CodexAuth.tsx` `cacheWarning`).

## Deferred by design (NOT pending work — the doc itself defaults these off/future)

- **Phase 4** derived `prompt_cache_key` + `promptCache` config block — doc: "Default should be
  preserve, not derive… derive is for later after live data proves benefit." Opt-in future.
- **Phase 6** cache-aware sticky routing — doc: "longer term… advanced… competes with quota
  failover." Deferred.

## Small residual gaps (optional follow-ups, non-blocking)

- No explicit `cacheHitRatio = cachedInputTokens/inputTokens` metric or "zero-hit routes"
  diagnostic — the raw inputs are logged/shown, so the ratio is derivable; the computed field is not.
- `prompt_cache_retention` is not explicitly parsed/preserved for ROUTED adapters (raw passthrough
  forwards it untouched; only routed reconstruction would drop it).

## Status: CLOSED — actionable strategy implemented; Phase 4/6 are explicit future options.
