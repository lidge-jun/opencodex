# 021 — Audit amendments (A-phase fold-back)

Two `xai/grok-4.6` explorers audited the plan against the tree. Both returned
`FINDINGS COMPLETE`. Their findings are folded in below; each amendment names
the document it modifies. The amendments are binding — where this document
disagrees with `010`/`020`/`030`, this document wins.

## A1 (Critical) — the filter argument in `020` was WRONG

`020` claimed provider/model filters must be a post-cache projection and must
not enter the cache key. The first half is right for the wrong reason and the
second half is **dangerous as written**.

The cache key is `\`${range}:${surface}\`` and nothing else. If a filtered
summary is ever *written* under that key, it poisons the unfiltered response:

1. `GET /api/usage?range=30d&provider=xai` computes an xAI-only summary.
2. It is stored under `"30d:all"`.
3. The next unfiltered `GET /api/usage?range=30d` — including the GUI's — is
   served xAI-only totals until `freshUntil` (60s) or local midnight.

The plan's "apply the projection after the cache read" phrasing does not by
itself prevent this, because the warm loop at `:247` writes summaries for
every key on the miss path, and a naive implementation that filtered inside
`summarizeUsage` would feed filtered data straight into that loop.

**Amendment (binding):**

- `summarizeUsage()` is **never** given a filter. It stays the unfiltered
  producer, so everything written to the cache is unfiltered by construction.
- `projectUsageSummary()` is applied **only** to the value being serialised
  into the `Response`, after the cache read and after the warm loop.
- A regression test asserts the poisoning sequence directly: filtered request,
  then unfiltered request, then assert the unfiltered response still contains
  the other providers. This test must be driven red against a
  filter-inside-summarize implementation before it counts.

## A2 (High) — `today` in the warm loop breaks a live test

`tests/settings-stream-mode.test.ts:207-217` asserts the retained cache store
holds exactly **12** entries after a single usage request — that is 3 ranges ×
4 surfaces — and then that eviction leaves **11**.

Adding `today` to `USAGE_RANGES` makes the warm loop write 16. The test fails
with an off-by-four that has nothing to do with stream mode, in a file no
reader would think to look at.

**Amendment:** `020` updates that test in the same commit, and derives the
expectation instead of hardcoding it:

```ts
expect(before.count).toBe(USAGE_RANGES.length * USAGE_SURFACES.length);
```

This also requires exporting `USAGE_SURFACES` alongside `USAGE_RANGES`. Doing
it by derivation is the point: the next person to add a range gets a passing
test instead of a puzzle.

## A3 (High) — `rangeWindow`'s default branch is a trap

`rangeWindow()` has no `switch`; it is two `if`s and a fallthrough
`return { since: null, days: 0 }` — the `all` case. So a `today` member added
to the union but not to the function does not fail to compile. It silently
becomes **all history**, with `days: 0` producing an empty grid pre-fill.

That is the worst possible failure for a cost surface: `--range today` would
report the all-time total and look plausible.

**Amendment:** `010` adds the `today` branch *first*, and adds a test that
asserts `rangeWindow("today", t).since !== null` — an assertion that fails
loudly on the fallthrough rather than one that merely checks a number.

## A4 (Medium) — day cost must be accumulated, not just declared

`010` listed the four construction sites correctly, but the audit points out
that cost is currently computed **only** in `buildModels` / `buildProviders` /
`buildAccounts` / `addEstimatedCost` — the day loop has no cost pass at all.
Declaring the field and initialising it to `0` at four sites leaves every day
row at `$0`.

**Amendment:** `010` also adds the accumulation in the entry loop
(`:366-381`) and in `bumpDayModel` (`:347-365`), using the same
`estimateComboCost` / `estimateRequestCost` branch `buildModels` uses.

The model-level overflow at `:503-505` is the exact pattern to copy for the
day overflow row.

### Combo cost does NOT double-count — verified

`020` worried that filtering could double-count combo cost. Checked directly
at `src/usage/summary.ts:462-478`: `estimateComboCost` returns
`estimate.attempts`, and each attempt's cost is attributed to *its own* model
key. The parent request's cost is not also added. So cost partitions cleanly
across models; only *request counts* can overlap.

The `020` characterisation therefore stands: cost sums correctly under a
filter, request counts may overlap for combo traffic, and the `comboOverlap`
flag is the honest disclosure. No change needed — but this is now verified
rather than assumed.

## A5 (Medium) — GUI is safe, and stays unaware

`gui/src/pages/Usage.tsx` declares its own local `UsageDay`/`UsageDayModel`
interfaces and parses with `response.json() as UsageResponse`. Extra fields
are ignored; nothing breaks. `gui/src/pages/Usage.tsx:14` also has its own
`Range = "all" | "30d" | "7d"` union that never receives `today` because the
GUI only ever sends its own three values.

Confirmed no Zod or strict key-set validation anywhere on this payload, so the
new `filter` echo block is additive and safe.

**No amendment.** GUI work stays out of scope, which also keeps the PR free of
the word `gui` and therefore free of the screenshot gate.

## A6 (Medium) — the test convention in `030` was wrong

`030` said tests stub `runtimeRequest`. They do not. The convention is to
inject `fetchImpl` through `RuntimeApiDeps`
(`src/cli/runtime-api.ts:17-21, 59-72`), with stdout captured by swapping
`console.log` and restoring it in a `finally`.

Reference implementations: `tests/cli-account.test.ts:348+` (padded-column
regex assertions on a table — the closest analogue to what we are building),
`tests/cli-codex-log-guard.test.ts:8-21`, `tests/cli-export-command.test.ts:80-101`.

**Amendment:** `030` uses `fetchImpl` injection and the `console.log` swap.
The pure `formatUsageReport()` extraction still stands — it is what makes the
table assertions readable — but the command-level test wires through
`handleObserveCommand(argv, deps)`.

## A7 (Low) — day-overflow cost has no existing test guard

`tests/usage-summary.test.ts:849-862` asserts the day `other` row exists but
never asserts its cost. So a missing overflow sum stays green today.

**Amendment:** the `010` accept criterion 6 (overflow activation) is
mandatory, not optional, and must be driven red first.

## Verdict disposition

| ID | Severity | Disposition |
|----|----------|-------------|
| A1 | Critical | Folded — `020` architecture corrected |
| A2 | High | Folded — test updated by derivation |
| A3 | High | Folded — branch added first + loud assertion |
| A4 | Medium | Folded — accumulation added |
| A5 | Medium | Verified, no change |
| A6 | Medium | Folded — test convention corrected |
| A7 | Low | Folded — criterion made mandatory |

No residual blockers. The plan proceeds to B with these amendments binding.
