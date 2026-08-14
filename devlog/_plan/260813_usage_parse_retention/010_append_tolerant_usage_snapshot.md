# 010 One owner flight, single-pass compact artifacts

No module-level PersistedUsageEntry[]. No mergeUsageSummary. Waiters never receive entries[].

Owner flight key = identityKey + maxReadBytes + overlayVersion.
Owner reads the 64MiB window once, then ONE loop over entries that fills:
- 12 compact UsageSummary buckets (7d/30d/all x all/codex/claude/grok)
- one generic API-key attribution map (apiKeyId -> {totalRequests, requests7d, lastUsedAt, attributionSince, historyTruncated})
Do not call summarizeUsage 12 times. Add accumulateUsageSummaries(entries, now) in src/usage/summary.ts that does a single pass. Existing summarizeUsage can wrap it for one pair.
Then drop entries and resolve waiters with compact artifacts only.

Install rule: after compute, if userCostOverlayVersion() !== owner.overlayVersion OR a newer overlay flight exists, discard (do not write caches). Only the current overlay generation installs the 12 summaries and the API-key map. generationFreshUntil = now + 60000.

Hit: identity + overlay + now < generationFreshUntil + maxReadBytes matches installed generation. Return compact summary. No log read.
Sequential API-key after /api/usage: project configured IDs from the compact map, including duplicate-id ambiguous behavior already in rollupApiKeyUsage. No second parse.

Abort in-flight only on identity change, size decrease (replacement), or 30s stale. Append does not abort.

Tests:
1. append + GET within 60s: requests unchanged, fullReads 1
2. two concurrent different range/surface GETs: fullReads 1; one accumulateUsageSummaries invocation (spy); both summaries present
3. /api/usage then API-key sequentially: fullReads 1
4. Date.now +60s: one more fullReads
5. overlay bump DURING parse: old owner installs nothing; new owner fullReads; no mixed-price cache
6. size decrease: next GET fullReads

MODIFY src/usage/summary.ts (accumulateUsageSummaries), src/usage/log.ts (flight key identity+maxReadBytes, no abort on size growth), logs-usage-routes.ts (owner + install check), usage-summary-cache.ts (identityKey, generationFreshUntil, maxReadBytes), api-key-usage.ts (project compact map), tests/api-usage.test.ts, tests/usage-summary.test.ts, tests/usage-log.test.ts, tests/api-key-attribution.test.ts as needed.

identityKey = path + dev + ino + birthtimeMs only. Normalize maxReadBytes with Number() before keying. Shared owner API: loadUsageGeneration(maxReadBytes) in src/server/management/usage-generation.ts. API-key projects from generation.apiKeyAttribution { map, attributionSince, historyTruncated }.
