# 020 — API layer: range plumbing, filters, cache correctness

Work-phase **wp3**. Depends on `010` (the `today` member must exist).

## The cache cross-product is the real work here

`src/server/management/logs-usage-routes.ts:247` warms the cache by iterating
a **hardcoded literal** that duplicates the `UsageRange` union:

```ts
const ranges: UsageRange[] = ["7d", "30d", "all"];
```

TypeScript accepts a subset without complaint, so adding `today` to the type
in `010` produces **no compile error here**. The failure is silent and
behavioural: `today` is never warmed and never re-stamped when the log
revision changes, so it takes a different (slower, and differently-invalidated)
path than its siblings forever.

Fix — derive the list from one exported constant so the two cannot drift:

```ts
// src/usage/summary.ts
export const USAGE_RANGES = ["today", "7d", "30d", "all"] as const;
export type UsageRange = typeof USAGE_RANGES[number];
```

```ts
// logs-usage-routes.ts
const ranges: readonly UsageRange[] = USAGE_RANGES;
```

Now the union and the warm loop have a single source. The CLI's own
validation list (`observe.ts:132`) should import the same constant for the
same reason.

A guard test asserts `USAGE_RANGES.length` equals the number of distinct
values the warm loop writes, so a future member added to the type without
touching the loop fails a test instead of quietly degrading.

### Expiry is already correct

`usageSummaryExpiresAt()` (`:96`) returns `nextLocalMidnight(now)` for every
entry. That is precisely the correct expiry for a today-window: the cached
`today` summary dies exactly when "today" stops meaning what it meant. No
change needed — but it is worth stating, because it is the reason `today` can
be cached at all.

`refreshedUsageSummary()` (`:105`) re-derives `since` from
`rangeWindow(range, now)` on a cache hit, which keeps `since` honest for a
served-from-cache `today`.

## Filters are a projection, not a cache dimension

`provider` and `model` must **not** enter the cache key. The key is
`\`${range}:${surface}\`` and the warm loop is a cross-product; adding two
free-text dimensions multiplies it by the cardinality of every provider and
model ever seen. That is unbounded memory for a filter that is trivially
computable from the already-cached payload.

So: fetch (or hit) the unfiltered summary for `range:surface`, then project.

```ts
// applied AFTER the cache read, before jsonResponse
const providerFilter = url.searchParams.get("provider");
const modelFilter = url.searchParams.get("model");
const filtered = projectUsageSummary(summary, { provider, model });
```

### What the projection does

`projectUsageSummary()` is a new pure function in `src/usage/summary.ts`
(kept next to the shapes it rewrites, and unit-testable without a server):

- `models[]`, `providers[]` — keep matching rows.
- `days[]` — keep all day rows (the date axis stays intact so a range still
  renders as a range), but filter each `day.models[]` and **recompute**
  `day.requests`, `day.totalTokens`, `day.estimatedCostUsd` from the retained
  model rows.
- `summary` totals — recomputed from the retained rows.
- `accounts[]` — dropped to `[]` when a filter is active. Account rows are
  not provider-partitioned in a way we can honestly re-derive here, and
  emitting unfiltered account totals next to filtered model totals would
  invite exactly the wrong reading. Empty is honest; wrong is not.
- A new `filter` echo block is added to the response so a consumer can tell a
  filtered payload from an unfiltered one:
  `filter: { provider: string | null, model: string | null, matched: boolean }`.

Matching is case-insensitive exact on the canonical id, matched against the
same `baseProviderLabel()`-normalised provider key the summary rows carry —
not the raw request field. Otherwise `--provider xai` misses rows whose stored
provider is a labelled variant.

### Recomputation caveat, stated plainly

Recomputing totals from retained rows is **not** identical to re-summarising
the raw entries under a filter. A request that attributes to two providers
(combo) contributes its request count to both provider rows, so a filtered
total can double-count relative to a true re-summarisation. Two options:

1. Recompute from rows (cheap, cache-friendly, slightly wrong for combo).
2. Re-summarise raw entries with a filter predicate (exact, bypasses cache).

**Decision: (1), with the inaccuracy surfaced.** The filter's job is "how much
is xAI costing me", where cost sums correctly even when request counts
overlap; and the alternative gives up the cache for every filtered query. The
`filter` echo block therefore also carries `comboOverlap: boolean`, set when
any retained row came from a combo attribution, and the CLI prints a one-line
note when it is true. An approximation that announces itself is acceptable; a
silent one is not.

## Change map

| File | Change |
|------|--------|
| `src/usage/summary.ts` | export `USAGE_RANGES`; add `projectUsageSummary()` + `UsageFilterEcho` type |
| `src/server/management/logs-usage-routes.ts` | derive warm-loop ranges from `USAGE_RANGES`; parse `provider`/`model`; apply projection after cache read (both hit and miss paths) |

Note both paths: the cache-hit early return at `:215` and the fresh-compute
return. A projection applied to only one of them yields a filter that works
until the cache warms, then stops — the worst possible failure shape.

## Accept criteria

1. `USAGE_RANGES` contains `today`, and the warm loop writes a cache entry
   for every member (asserted by count, not by eyeballing).
2. `GET /api/usage?range=today` returns a single day row.
3. `GET /api/usage?provider=xai` returns only xAI rows; `summary.estimatedCostUsd`
   equals the sum of the retained `providers[]` rows.
4. `GET /api/usage?provider=XAI` matches case-insensitively.
5. `GET /api/usage?provider=nope` returns empty rows, zero totals, and
   `filter.matched === false` — not a 404 and not the unfiltered payload.
6. **Cache-hit activation:** the same filtered request issued twice returns
   identical filtered payloads, proving the projection is applied on the
   cache-hit path too. This test must drive the second request through the
   cache (assert on the hit) or it proves nothing.
7. `accounts` is `[]` whenever a filter is active.

## Verifier

`bun test tests/api-usage.test.ts tests/usage-summary.test.ts`
