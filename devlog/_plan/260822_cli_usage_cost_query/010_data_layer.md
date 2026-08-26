# 010 — Data layer: `today` range and day-level cost

Work-phase **wp2**. Depends on nothing. Everything after this consumes it.

## Change map

### `src/usage/summary.ts`

**1. Range type and parser**

```ts
export type UsageRange = "today" | "7d" | "30d" | "all";

export function parseRange(input: string | null | undefined): UsageRange {
  if (input === "today" || input === "1d") return "today";
  if (input === "7d" || input === "30d" || input === "all") return input;
  return "30d";
}
```

`1d` normalises to `today` at the parse boundary, so exactly one member
reaches the rest of the system. The alias never becomes a second enum value —
that is deliberate: a second member would need its own cache slot, its own
grid arm, and its own test matrix for zero user-visible gain.

**2. `rangeWindow()`**

```ts
if (range === "today") return { since: startOfLocalDay(now), days: 1 };
```

Placed first. `startOfLocalDay()` already exists at `:139` and is the same
helper `7d`/`30d` use, so the day boundary is consistent by construction
rather than by a second implementation that agrees today and drifts later.

**3. Day-level cost fields**

```ts
export interface UsageDay {
  // ... existing fields unchanged ...
  estimatedCostUsd: number;
}

export interface UsageDayModel {
  // ... existing fields unchanged ...
  estimatedCostUsd: number;
}
```

Required (not optional). `UsageModel.estimatedCostUsd` is optional today
because a model row can exist with no priced request at all; a day row is
always constructed by us and always summable, so `0` is the honest value and
`undefined` would only push a null check into every consumer.

## The four construction sites (all must be updated)

`buildDayGrid()` materialises these objects in four places. Missing any one
leaves a row whose cost is `undefined` at runtime despite a required type —
the object literals are the only thing TypeScript checks here.

| # | Line | Site | Action |
|---|------|------|--------|
| 1 | `:351` | `bumpDayModel` creates `UsageDayModel` | init `estimatedCostUsd: 0` |
| 2 | `:369` | grid pre-fill creates empty `UsageDay` | init `estimatedCostUsd: 0` |
| 3 | `:375` | entry loop creates off-grid `UsageDay` | init `estimatedCostUsd: 0` |
| 4 | `:390` | `retainedBreakdownRows` overflow `other` row | **sum** the tail's costs |

Site 4 is the one that fails silently. It synthesises an aggregate row from
everything past breakdown row 255; if it does not sum `estimatedCostUsd`, the
`other` row reports `$0` and the day's model rows no longer add up to the
day total. It is invisible in any test with fewer than 256 distinct
provider/model pairs, which is every test we would naturally write.

## Cost attribution must reuse the existing seam

Do **not** re-derive prices in the day loop. `buildModels()` already
establishes the correct pattern at `:470` / `:477`:

- combo attempts -> `estimateAttemptCost(...)`
- ordinary requests -> `estimateRequestCost(...)`

The day loop iterates `usageAttributions(entry)`, which is combo-aware: one
request can attribute to several provider/model pairs. Pricing it a second way
would make `days[].estimatedCostUsd` disagree with `models[].estimatedCostUsd`
for exactly the combo traffic where the disagreement is hardest to notice.

Implementation: compute the estimate once per entry (as the totals path
already does at `:335`), then distribute per attribution using the same
branch `buildModels` uses, and add the day-model contribution and the day
total from that single source.

## Accept criteria

1. `rangeWindow("today", t)` returns `since === startOfLocalDay(t)` and
   `days === 1`, for `t` at 00:00:00, at 12:00, and at 23:59:59 local.
2. `parseRange("today")` and `parseRange("1d")` both return `"today"`;
   `parseRange("2d")` still returns `"30d"` (unchanged fallback).
3. A summary over fixtures spanning two local days, with `range: "today"`,
   contains exactly one day row and excludes yesterday's entries.
4. `days[].estimatedCostUsd` equals the sum of that day's
   `days[].models[].estimatedCostUsd`.
5. The sum of `days[].estimatedCostUsd` over a window equals
   `summary.estimatedCostUsd` for that window.
6. **Overflow activation (C-ACTIVATION-GROUNDING-01):** a fixture with more
   than `MAX_USAGE_MODEL_BREAKDOWN_ROWS` distinct provider/model pairs in one
   day produces an `other` row whose `estimatedCostUsd` is non-zero and
   equals the summed tail. This test must be written to *fail* against an
   unsummed site-4 before it is accepted as passing.

## Verifier

`bun test tests/usage-summary.test.ts tests/usage-cost.test.ts`

Confirmed to exist and to read `src/usage/summary.ts` (both suites import from
it directly).
