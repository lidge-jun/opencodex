# WP11 — #395 404 log-flood investigate + comment (100)

Issue #395: anthropic-adapter providers whose baseUrl lacks `/v1/models`
(e.g. Azure AI Foundry) flood the log with repeated
`Provider model discovery for "X" failed with HTTP 404 [urlClass=provider-models,
fallback=configured]` on every catalog poll.

## Findings (Sol explorer, read-only)

- Anthropic adapters always `GET {baseUrl}/v1/models?limit=1000`
  (`src/oauth/index.ts:421-455`); Azure Foundry lacks it → permanent 404.
- Discovery runs whenever no fresh success cache (`provider-fetch.ts:291-299`); a
  non-2xx records failure and logs UNCONDITIONALLY (`provider-fetch.ts:303-335`).
- Failure state only sets a 30s cooldown (`model-cache.ts:44-76`) — does NOT cache
  the fallback verdict. After 30s the next poll re-probes and re-warns; dashboard
  polls every 10s. Net: ~1 warning per 30s per provider forever.
- Configured-model fallback is correct; inference unaffected — pure log noise.

## Plan (recommended: log-once-per-signature)

MODIFY:
- `src/codex/model-cache.ts` — helper comparing previous discovery status to the
  incoming failure; returns whether this signature should warn.
- `src/codex/catalog/provider-fetch.ts:329-335` — record status but `console.warn`
  only for a new/changed signature (ok/undefined→404, 404→other).
- Keep 30s retry + configured/stale fallback. Reset suppression via
  `markProviderDiscoveryOk()` and `clearModelCache()` (`model-cache.ts:55-64,95-105`).

Activation (C-ACTIVATION-GROUNDING-01): regression proving first 404 warns; polling
during cooldown neither fetches nor warns; post-cooldown identical 404 re-fetches
but does NOT warn; success→404 warns again; cache clear resets.

TESTS: extend `tests/codex-catalog.test.ts` (discovery ~1449-1865).

## Decision

User said "조사하는 pabcd 코멘트": required artifact = investigation comment on #395
with root cause + recommended fix. The log-once fix is small/safe and may ride the
same cycle if time allows.

Terminal: DONE = comment posted on #395. Optional: log-once fix landed with tests.
