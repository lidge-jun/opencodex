# 030 — Phase 3 (#1497): `30d` and `all` must not silently share one byte tail

Depends on: nothing in 010/020 (disjoint files). Ordered here because it is the
first phase that changes a **response contract** rather than an adapter's
internal event stream, so it needs the adapter phases settled first to keep each
PR reviewable in isolation.

## The defect, stated precisely

`GET /api/usage` reads a bounded newest-bytes window and *then* applies the
range filter:

```ts
const effectiveReadLimit = config.managementUsageMaxReadBytes ?? 64 * 1024 * 1024;
const snapshot = await readUsageSnapshotForManagement(effectiveReadLimit);
const summary = {
  ...summarizeUsage(snapshot.entries, range, now, surface),
  historyTruncated: snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated,
```

Two distinct user-visible failures follow:

1. **`30d` is a lie by omission.** The measured installation had 175,818
   requests over Aug 4-11; the bounded read returned 46,417 (~39 hours). 73.6%
   of in-range requests were omitted from a view labelled `30d`.
2. **`Available history` is indistinguishable from `30d`.** `range=all` reads
   the same tail, so the control that promises "everything" returns the same
   incomplete set.

A third consequence is that cumulative totals can *decrease* between reloads as
older high-usage rows fall out of the moving window — a monotonic counter that
goes backwards.

## Scope decision: honest reporting, not a derived-aggregate rewrite

Draft PR #1008 proposes a daily rollup sidecar plus raw-tail merge. That is the
durable direction, but it is stale, conflicting, and carries unresolved
correctness findings (crash-safe append/commit validation, truncated-ledger
invalidation, partial-day range overlap, request dedup, disabled-rollup
behavior). **An incorrect derived aggregate is worse than an honestly truncated
view**, and adopting it here would silently take on those findings.

This phase therefore does the bounded, provably-correct part:

**IN**

- Make the API tell the truth about *what range the returned data actually
  covers*, so a client can never present a truncated window as a complete one.
- Make `range=all` and `range=30d` distinguishable when truncation occurred.
- Surface the coverage boundary in the dashboard label.

**OUT**

- The rollup sidecar (#1008 keeps that scope).
- Raising or removing `managementUsageMaxReadBytes` as the "fix" — the issue
  itself notes that only postpones recurrence and makes every summary parse a
  growing file.
- Any change to `usage.jsonl` write paths.

## Diff-level change map

### `src/usage/log.ts`

`readUsageSnapshotForManagement` already returns `truncatedPrefixBytes`,
`entriesTruncated`, `entriesDropped`. Add the one fact the caller cannot derive:
the **timestamp of the oldest entry actually read**. That is the true left edge
of coverage.

```ts
export async function readUsageSnapshotForManagement(maxReadBytes = MANAGEMENT_USAGE_MAX_READ_BYTES): Promise<{
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision | null;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
}>
```

The oldest-entry timestamp is computable in `logs-usage-routes.ts` from
`snapshot.entries` without changing this signature (entries are append-ordered,
so the first surviving entry is the oldest read). Preferring the caller-side
derivation keeps the shared reader untouched and avoids disturbing the
in-flight-dedup and revision-key logic around it.

### `src/server/management/logs-usage-routes.ts`

```ts
const snapshot = await readUsageSnapshotForManagement(effectiveReadLimit);
const historyTruncated = snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated;
// When the bounded reader dropped a prefix, the rows we have do not span the
// requested range: the oldest row we read IS the left edge of what any summary
// over these entries can describe. Reporting it lets the client label the view
// by its real coverage instead of by the range that was asked for. Without it
// `30d` and `all` are indistinguishable on a busy installation, which is the
// defect in #1497.
const coverageStart = historyTruncated ? oldestEntryTimestamp(snapshot.entries) : null;
const summary = {
  ...summarizeUsage(snapshot.entries, range, now, surface),
  historyTruncated,
  truncatedPrefixBytes: snapshot.truncatedPrefixBytes,
  entriesTruncated: snapshot.entriesTruncated,
  entriesDropped: snapshot.entriesDropped,
  coverageStart,
  rangeFullyCovered: !historyTruncated || rangeStartsAfter(range, coverageStart, now),
};
```

`rangeFullyCovered` is the field a client can act on without arithmetic:

- `range=7d` on a tail covering 39 hours → `false`;
- `range=7d` on a tail covering 30 days → `true` even though `historyTruncated`
  is `true`, because everything the range asked for is present. This distinction
  matters: today a truncated file makes *every* range look suspect.

`refreshedUsageSummary` (`:119`) re-derives range-dependent fields for cached
entries and must carry these two through consistently; the cache key already
includes `effectiveReadLimit`, so a limit change invalidates correctly.

`oldestEntryTimestamp` and `rangeStartsAfter` are small local helpers; the
range→start-instant mapping already exists inside `summarizeUsage`/`parseRange`
and is reused rather than duplicated.

### `gui/src/pages/Usage.tsx`

When `rangeFullyCovered === false`, the range control must not present the
result as the requested range. Minimum: an inline note stating the covered
window (`"showing Aug 10 18:00 onward — older rows exceed the read limit"`) and
the `Available history` option relabelled to reflect that it is bounded. This is
the user-facing half of the fix; without it the API tells the truth and the UI
still does not.

A GUI change means the PR must include a screenshot per `AGENTS.md`
(`enforce-target` rejects `gui`-touching PRs without one).

## Activation scenario (C-ACTIVATION-GROUNDING-01)

Fixture-driven, no live installation needed:

1. Write a temporary `usage.jsonl` whose total size exceeds a deliberately small
   `managementUsageMaxReadBytes` (e.g. 4 KiB), with entries spanning 40 days and
   the newest ~1 day of rows fitting inside the limit.
2. `GET /api/usage?range=30d` → `historyTruncated: true`,
   `rangeFullyCovered: false`, `coverageStart` equal to the oldest row that fit.
3. `GET /api/usage?range=all` → same `coverageStart`, `rangeFullyCovered: false`.
4. Raise the limit above the file size and repeat → `historyTruncated: false`,
   `rangeFullyCovered: true`, `coverageStart: null`, and the `30d` totals now
   match a direct summarization of every in-range row.

Observable effect proving the branch ran: `rangeFullyCovered` flips between
steps 2 and 4 for the identical request.

## Accept criteria

1. Truncated ledger + `range=30d` → `rangeFullyCovered: false` with a
   `coverageStart` matching the oldest read row. (Red before the change: the
   field does not exist.)
2. Truncated ledger + `range=all` → same, and the client can therefore tell the
   two views apart.
3. Untruncated ledger → `rangeFullyCovered: true`, `coverageStart: null`, and
   summary numbers identical to the pre-change behavior (no regression in the
   normal case).
4. A truncated ledger whose tail still fully covers a short range → 
   `historyTruncated: true` **and** `rangeFullyCovered: true`.
5. Cached responses (`refreshedUsageSummary`) carry both fields consistently.
6. GUI shows the coverage boundary when `rangeFullyCovered` is false.
7. `bun run typecheck` and `bun run lint:gui` exit 0; usage suites green on
   `ssh lidge`.

## Verification commands

```bash
bun x tsc --noEmit
bun test tests/usage*.test.ts tests/logs-usage*.test.ts tests/management*.test.ts
bun run lint:gui
```

## Delivery

Branch `codex/1497-usage-range-coverage`, PR against `dev` with
`Closes #1497` and a GUI screenshot.
