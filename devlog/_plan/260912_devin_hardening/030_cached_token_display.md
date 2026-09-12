# wp4 — Cached-token companion on every total

Branch: codex/260912-cached-token-companion (base dev, sibling of the Devin chain)

## The complaint

A cached request whose total is 58,000 tokens is about 57,000 cache-read plus 1,000 fresh.
The Logs table row already renders that as a total with a stacked "c 5.7만". Every other
surface prints a bare 5.8만, which reads as a different, smaller request rather than the same
request with its breakdown hidden. The conversation-totals banner sits directly above rows
that do show the companion, so the mismatch is visible in one screenshot.

## Where the data already is

/api/logs rows carry usage.cachedInputTokens, cacheReadInputTokens and
cacheCreationInputTokens; /api/usage carries the same on summary, models, providers and
day-models. Nothing needs a backend change. The loss is client-side: the GUI row types drop
the cache fields, and the aggregators sum only totals.

## Approach

One shared helper beside formatTokens in gui/src/format-tokens.ts:

    formatTokensWithCache(total, cached, locale) -> "5.8만 c5.7만"

It returns the bare total when cached is undefined, zero, or not less than the total, so a
provider that reports no cache is untouched. The "c" marker matches the existing
logs.tokens.cacheRead label, which already reads "cache read (c)", so no new i18n key is
needed.

Surfaces to convert, in order of how visible the mismatch is:

1. Logs conversation-totals banner — summarizeFilteredLogs also sums cacheSplit(entry).read.
2. Usage per-model and per-provider token columns — widen the row types to keep the cache
   fields the API already sends.
3. Dashboard 30-day total tile — widen the summary type the same way.
4. Log detail "total tokens" cell, for parity with the row it was opened from.
5. CLI usage report provider/model/account rows, matching the summary line that already
   prints "cached N".

## Verification

bun test for the formatter and the CLI report, plus bun run lint:gui.
