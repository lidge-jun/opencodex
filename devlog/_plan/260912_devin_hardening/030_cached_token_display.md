# wp4 — Cached-token companion on every total

Branch: codex/260912-cached-token-companion (base dev, sibling of the Devin chain)

## The complaint

A cached request whose total is 58,000 tokens is about 57,000 cache-read plus 1,000 fresh.
The Logs table row already renders that as a total with a stacked "c 5.7만". Every other
surface prints a bare 5.8만, which reads as a different, smaller request rather than the same
request with its breakdown hidden. The conversation-totals banner sits directly above rows
that do show the companion, so the mismatch is visible in one screenshot.

## Where the data already is

/api/logs forwards the whole usage object, and /api/usage already emits cache on summary,
models, providers and day-models. No backend change is needed. The loss is client-side, and it
is not only the GUI row types: Usage's UsageModel and UsageProvider, the dashboard's
UsageSummary30d, summarizeFilteredLogs in Logs.tsx, and the CLI's CostRow each drop the fields
before they reach a renderer.

## Approach

One shared helper beside formatTokens in gui/src/format-tokens.ts:

    formatTokensWithCache(total, cached, locale) -> "5.8만 c5.7만"

It returns the bare total when cached is undefined or zero. It does not hide the companion when
cached equals the total: an all-cache turn with no fresh input is exactly the case worth
showing, and suppressing it would blank the most cached request on the page. The "c" marker
matches the existing logs.tokens.cacheRead label, which already reads "cache read (c)", so no
new i18n key is needed.

Surfaces to convert, in order of how visible the mismatch is:

1. Logs conversation-totals banner — summarizeFilteredLogs also sums cacheSplit(entry).read.
2. Usage per-model and per-provider token columns — widen the row types to keep the cache
   fields the API already sends.
3. Dashboard 30-day total tile — widen UsageSummary30d the same way.
4. CLI usage report provider/model/account rows, matching the summary line that already
   prints "cached N".

The log detail panel is deliberately left alone: it already has separate cache read and cache
write cells, so stacking the companion onto its total would duplicate them.

## CI gate

missing_ui_screenshot in .github/scripts/pr-quality.cjs is path-based: touching gui/src trips
it whether or not the description says "gui". This PR therefore carries a real screenshot of
the changed surface, produced from a build of this branch served by a throwaway proxy instance
on its own port and its own OPENCODEX_HOME, so the operator's running service is untouched.

## Verification

bun test for the formatter and the CLI report, plus bun run lint:gui.
