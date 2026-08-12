# 031 — Phase 3 REVISED (#1497): report only what is provable

Supersedes `030`. Written after audit blockers B2 and B3.

## Why 030 was wrong

`030` proposed `rangeFullyCovered`, derived from the oldest retained entry's
timestamp. That is unsound:

- `usage.jsonl` is appended when a request **completes**;
- the persisted timestamp is the request's **start** time;
- so a long-running request that started early can be appended after later,
  shorter requests.

The bounded reader keeps the newest *bytes*, i.e. the newest *appends*. The
minimum start-timestamp among retained rows therefore does not bound the
start-timestamps inside the dropped prefix. `rangeFullyCovered: true` could
claim a range is complete while an old long-running request sits in the dropped
prefix inside that range.

A field whose entire purpose is to be trusted, which can be wrong, is worse than
no field. Shipping it would reproduce #1497's own defect class: a label that
asserts more than the data supports.

## What this phase delivers instead

Only facts the reader can prove:

1. **Truncation is already reported** (`historyTruncated`, `truncatedPrefixBytes`,
   `entriesTruncated`, `entriesDropped`). Keep as-is.
2. **Add the loaded-snapshot window**, named so it cannot be read as a
   completeness claim or as a description of the summarized rows:

```ts
// The bounded reader keeps the newest BYTES of an append-ordered ledger, and rows
// are appended on completion while their timestamp is the request start. So the
// oldest retained timestamp is NOT a bound on what the dropped prefix contains:
// a long-running request started earlier can be appended later. This field is
// therefore reported as the window of the rows the READER LOADED — never as
// proof that the requested range is fully covered (#1497 audit B2), and never
// as a description of the summarized subset (audit R2-3).
snapshotWindowStart: number | null;   // min timestamp across snapshot.entries
snapshotWindowEnd: number | null;     // max timestamp across snapshot.entries
```

**Population is `snapshot.entries`, before any filtering.** `summarizeUsage`
applies both the range window and the surface predicate
(`src/usage/summary.ts:706-716`), so the summarized subset is strictly smaller
and describes the *query*, not the *read*. Truncation is a property of the read,
which is why the reported window must be the read's. Naming them
`snapshotWindow*` rather than `retainedWindow*` removes the ambiguity that audit
R2-3 caught.

3. **Make the dashboard stop presenting a truncated view as the requested
   range.** When `historyTruncated` is true, the range control shows that the
   summary is computed over a bounded tail and names the retained window. The
   `Available history` label specifically must stop implying completeness — it
   is the more misleading of the two, because `30d` at least states a bound.

**No `Closes #1497`.** The issue's bar is complete 7d/30d aggregation and
monotonic all-time totals. This phase does not achieve that; it removes the
false presentation while the durable fix (daily rollup sidecar, #1008) is worked
separately. The PR says so explicitly and links #1008.

## Scope

IN: `src/server/management/logs-usage-routes.ts` (two derived fields +
`refreshedUsageSummary` passthrough), `gui/src/pages/Usage.tsx` (truncation
disclosure), locale modules for any new visible string, tests.

OUT: the rollup sidecar; raising `managementUsageMaxReadBytes`; any change to
usage write paths; any completeness claim.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

1. Fixture `usage.jsonl` larger than a deliberately small
   `managementUsageMaxReadBytes`, rows spanning 40 days.
2. `GET /api/usage?range=30d` → `historyTruncated: true`, and
   `snapshotWindowStart` equals the min timestamp across the rows the reader
   loaded — asserted against a directly-computed expectation, not against the
   reader's own output.
3. Raise the limit above file size → `historyTruncated: false`,
   `snapshotWindowStart` spans the whole fixture, and the `30d` totals equal a
   direct summarization of every in-range row (proving no regression in the
   normal path).
4. GUI: with `historyTruncated: true` the disclosure renders; with `false` it
   does not.
5. `surface=claude` on the same fixture → `snapshotWindow*` is **unchanged**
   from the `surface=all` request, proving the fields track the read and not the
   filtered result (audit R2-3).
6. Empty snapshot → both fields are `null`, not `NaN` or `Infinity`.

Observable effect: the disclosure element appears and disappears across steps 2
and 3 for the identical request.

## Accept criteria

1. Truncated ledger → `snapshotWindowStart`/`End` match independently computed
   values. (Red before: fields do not exist.)
2. Untruncated ledger → summary numbers byte-identical to pre-change behavior.
3. Cached responses carry both fields consistently through
   `refreshedUsageSummary`.
4. GUI discloses truncation and no longer labels a bounded tail as complete
   history.
5. No field in the response asserts range completeness.
6. Surface and range filters do not move `snapshotWindow*`; an empty snapshot
   yields `null` for both.
7. Gates: root `bun x tsc --noEmit`, root usage/management suites, and inside
   `gui/`: `bun test tests`, `bun run lint`, `bun run build`, `bun run lint:i18n`
   (per `gui/AGENTS.md`), plus every locale module updated for new copy.
8. PR includes a GUI screenshot (`enforce-target` gate).

## Delivery

Branch `codex/1497-usage-truncation-disclosure`. PR against `dev`, references
`#1497` and `#1008`, **without** `Closes`.
