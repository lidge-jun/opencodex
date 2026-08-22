# 001 — Current-state inventory

Read-only survey of the code the later phases touch. Every claim below was
checked against `dev` at `7185ecc80`.

## The request path

```
ocx usage  ->  src/cli/observe.ts usage()
           ->  GET /api/usage?range&surface
           ->  src/server/management/logs-usage-routes.ts (cache + parse)
           ->  src/usage/summary.ts summarizeUsage()
           ->  src/usage/cost.ts estimateRequestCost()
```

Cost is computed at the bottom of that stack and survives all the way back to
the CLI. It dies in the last four lines.

## Gap 1 — the renderer discards what it is given

`src/cli/observe.ts:129` `usage()` ends with:

```ts
const result = await runtimeRequest(`/api/usage${query({ range, surface })}`, {}, deps);
printData(result, wantsJson, summaryLines(result));
```

`summaryLines()` (`src/cli/runtime-api.ts:294`) is a generic DTO flattener:

- `depth > 1` returns early, so nested rows are never walked.
- an array of objects renders as `${child.length} item(s)`.

So `models`, `providers`, `accounts` and `days` — the four arrays that carry
every per-entity cost — print as `models: 45 item(s)`. The totals block does
print, because it is scalar at depth 1; `summary.estimatedCostUsd` is
therefore the *only* cost number a user sees, and it is the whole-window
total across every provider.

This is a shared helper used by `storage`, `memory`, `debug`,
`claude-inbound` and `injection`. It must not be changed to serve usage:
those callers are well-served by a flat view. Usage needs its own renderer.

## Gap 2 — no today window

`src/usage/summary.ts:7` `export type UsageRange = "7d" | "30d" | "all"`.

`rangeWindow()` (`:145`) already does local-midnight arithmetic through
`startOfLocalDay()` (`:139`), so a `today` member is a two-line addition:
`{ since: startOfLocalDay(now), days: 1 }`. The helper it needs exists.

`parseRange()` (`:129`) falls back to `"30d"` for anything unrecognised. It
never throws, so an unknown `--range` silently returns a month of data. The
CLI guards this itself (`observe.ts:132`) — that guard list must be updated in
lockstep or `--range today` is rejected at the CLI before the server ever
sees it.

## Gap 3 — day rows have no cost field

`UsageDay` (`:37`) and `UsageDayModel` (`:46`) declare
`requests / measuredRequests / reportedRequests / totalTokens / models` and
`model / provider / requests / attemptCount / totalTokens` respectively.
Neither has `estimatedCostUsd`.

`buildDayGrid()` (`:338`) is the single construction site, and it has **four**
places that materialise these objects:

1. `bumpDayModel()` `:351` — creates a `UsageDayModel`.
2. the pre-fill loop `:369` — creates empty `UsageDay` rows for the grid.
3. the entry loop `:375` — creates a `UsageDay` for a date outside the grid.
4. the `retainedBreakdownRows` overflow collapse `:390` — synthesises an
   `other` row by summing the tail.

All four must set the new field, and (4) must *sum* it, or the overflow row
silently zeroes the cost of everything past row 255.

Note the day loop attributes per-entry via `usageAttributions(entry)`, which
is combo-aware (one request can attribute to several provider/model pairs).
Cost attribution must go through the same seam that `buildModels()` uses
(`estimateAttemptCost` for combo attempts, `estimateRequestCost` otherwise) —
see `:470` and `:477` — rather than re-deriving a price, or day totals will
disagree with model totals for combo traffic.

## Gap 4 — surface is not provider

`UsageSurface` is `all | codex | claude | grok` and selects the **client**
that made the call. `--surface grok` means "requests that came from the Grok
client", not "requests served by xAI".

For the user who prompted this unit those two readings differed by two orders
of magnitude: `--surface grok` reported 10 requests for the 30d window, while
their xAI provider traffic for that window was 1,447 requests in a single day.
A flag that looks like the answer and returns a different number is worse than
no flag; the fix is a real `--provider` (and `--model`) filter, not a
redefinition of `--surface`.

## The cache is the sharp edge

`/api/usage` (`logs-usage-routes.ts:197`) is cached, and the cache is
**precomputed as a cross-product**:

```ts
const ranges: UsageRange[] = ["7d", "30d", "all"];              // :247
const surfaces: UsageSurface[] = ["all", "codex", "claude", "grok"];
for (const nextRange of ranges) for (const nextSurface of surfaces) { ... }
setUsageSummaryCacheEntry(`${nextRange}:${nextSurface}`, ...)
```

Three consequences for this unit:

1. That literal array is a second, independent definition of `UsageRange`'s
   members. Adding `today` to the type does not add it here — TypeScript is
   perfectly happy with a subset. `today` would simply never be warmed, and
   worse, would never be *invalidated* alongside its siblings.
2. `refreshedUsageSummary()` (`:105`) re-derives `since` from
   `rangeWindow(range, now)` when serving a cache hit, so a `today` entry
   served from cache does get a correct `since` — but the **rows** inside it
   are whatever the window was when it was computed. `usageSummaryExpiresAt()`
   (`:96`) already expires every entry at `nextLocalMidnight(now)`, which is
   exactly the boundary `today` needs. That is a real piece of luck: the
   existing expiry policy is correct for a today-window without modification.
3. Adding `provider`/`model` to the cache key would multiply the cross-product
   by the cardinality of providers × models — unbounded. The filters must
   therefore be applied **after** the cache lookup, as a projection over an
   already-summarised payload, not as another cache dimension.

That last point decides the architecture of phase `020`: filtering is a
post-summary projection, not a summarisation parameter.

## Test surface

`tests/usage-summary.test.ts`, `tests/usage-cost.test.ts`,
`tests/api-usage.test.ts`, and the `tests/cli-*.test.ts` family. The CLI
tests are the convention to match for stdout capture; the exact helper is
confirmed in phase `030` before writing new tests.
