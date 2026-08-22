# 032 — The retainer is the allocator, not a live reference

Live evidence 2026-08-14, PID 56953 (post-restart, patches through b583d6497 landed):

```
rss                7,907,115,008   (7.36 GiB)
heapUsed             130,792,295   (125 MiB)
heapTotal            102,749,184
jscHeap.heapSize     110,233,413   objectCount 451,975
appOwnedBytes.retainedBytes  33,020,688 / 268,435,456 budget
appOwnedBytes.overBudgetBytes         0
enforcement.entriesDemoted            0
```

Every registered store is small and inside budget; the enforcer has never had to evict.
The watchdog samples are the decisive part:

```
heapUsed 2.99 GiB -> 186 MB -> 1.75 GiB -> 147 MB -> 153 MB -> 113 MB -> 129 MB
rss      8.53 GiB -> 9.33 GiB -> 6.93 GiB -> 7.89 GiB -> 7.88 GiB -> 7.91 GiB -> 7.91 GiB
```

The JS heap rises to gigabytes and falls back to ~130 MB, so the objects ARE collected.
RSS does not follow it down. This is allocator arena growth from a large recurring
transient, not a retained reference. Hunting for a "second retainer" (031) was correct
to close out, but it could not have found anything: there is nothing alive to find.

## The transient, measured in isolation

`.tmp/probe-cost.mjs` against the real 245 MB / 454,704-row `usage.jsonl`:

```
entries parsed from the 64 MiB tail   53,045
parse                                 408 ms   rss  69 MB -> 393 MB
summarize x12 (3 ranges x 4 surfaces) 1,432 ms rss 393 MB -> 713 MB
```

One cold `/api/usage` allocates ~644 MB and holds ~53k objects plus 12 summary
projections simultaneously. On the live proxy, competing with two active turns, the
same call measured **25.6 s wall and +680 MB RSS** (7.72 -> 8.40 GiB).

## Why it recurred every minute

`freshUntil = now + 60_000` bounds the summary cache. Warm hits are ~1 ms and all 12
combinations are pre-primed, so tab switching within the window is free. One minute
later the next tab switch pays the full cold cost again, and RSS ratchets up once more
because the allocator never returns the pages. That is the "탭전환이 너무 느려" report:
not a slow render, a 25-second blocking reparse.

## Fix

Retain the parsed tail across requests and parse only appended bytes
(`readUsageEntriesIncrementally`, src/usage/log.ts). `usage.jsonl` is append-only under a
stable identity, so the prefix is reusable. The retained rows are registered as
`usage_snapshot` under the app-owned budget and are evictable, so this trades a bounded,
accounted ~27 MB of retention for eliminating an unbounded, unaccounted ~644 MB transient.

Refusal conditions (fall back to a full bounded read): identity change, file shrink,
different `maxReadBytes`, retained window starting before the current bounded window, or a
covered offset that is not on a record boundary.

Measured after the fix, same real ledger: cold 350 ms / 388 MB, then **five further reads
in 1 ms total and +2 MB**, `fullReads` 1, `tailReads` 5, `parsedLines` flat at 53,012.

## Independent review: one real defect, folded in

Sol (gpt-5.6-sol) returned VERDICT: DEFECT FOUND on the first landed version and it was
correct. `usageLogIdentityKey` deliberately excludes size/mtime/ctime so appends share
work, which also means an **in-place rewrite that keeps the inode is invisible**. Neither
the identity check nor the shrink check sees it, so the reader could concatenate stale
retained rows with bytes from the replacement content.

Reproduced directly, guard disabled, same inode, file only grows:

```
first: aaa1,aaa2,aaa3
after: aaa1,aaa2,aaa3,bbb4     <- three rows that no longer exist in the file
```

Note the record-boundary check masks this whenever the rewrite shifts row widths, which
is why a naive regression test passes vacuously. The reproduction needs **fixed-width
request ids** so a newline still lands exactly at the previously covered offset.

Fix: carry a `prefixDigest` (SHA-256 over the last 4 KiB ending at the covered offset)
on the snapshot and re-verify it before reuse or extension. With the guard:

```
after: bbb1,bbb2,bbb3,bbb4     fullReads 2, tailReads 0
```

Sol's other three points were checked and stand as sound: retained entries stay capped by
`MANAGEMENT_USAGE_MAX_ENTRIES` and the window-refusal bound, `concat()` does not alias,
and concurrent callers share one flight and each receive a copy. Its caveat on the 512 B
per-row estimate is accepted and recorded: `usage_snapshot` accounting is coarse
telemetry for eviction ordering, not a guaranteed byte ceiling.

The regression test was driven red against the disabled guard before being accepted, so
it is not vacuous.

## Opus review: the fix did not engage on the file it was written for

Opus (claude-opus-5) returned VERDICT: DEFECT FOUND and its primary finding was the
serious one — worse than the digest question.

**The incremental path was dead code on any ledger larger than the read window.** The
original refusal required the retained window to start at or after the current window.
Once the file exceeds 64 MiB, every append slides the window forward, that check fails
every time, and the reader falls back to a full reparse. Reproduced on an over-window
file:

```
6 appends -> fullReads 7, tailReads 0, parsedLines 37,254
```

So the first two commits fixed nothing on the 245 MB ledger that caused the incident.
The check was backwards: a retained window that starts EARLIER is a superset of the
current window and already contains every row the window needs. It is kept, and a full
read re-anchors only once the retained span reaches `RETAINED_USAGE_SPAN_FACTOR` (2x)
the window — about one full read per window of appended data instead of one per append.

```
same 6 appends -> fullReads 1, tailReads 6, parsedLines 6
400 appends, 256 KiB window -> fullReads 6, tailReads 394, maxSpan 522,050 <= 524,288
```

## Sampled digest rejected on Opus's evidence

Opus also broke the 8-probe sampled digest: 32 KiB of probes over a 4.8 MB prefix covers
0.68% (0.05% at 64 MiB), so an ordinary fixed-width in-place edit lands in a gap by
default. It demonstrated a rewritten row 5038 still being served as `old005038`. Its
objection to the code comment was fair — length-preserving edits are the normal case for
a redaction or compaction script, not an adversarial construction.

Timestamps were evaluated as the cheap alternative and rejected: an append and an
in-place rewrite BOTH move mtime and ctime forward, so they cannot separate the two.

The digest therefore covers the entire covered prefix. That is a sequential read of
already-cached pages with no JSON parsing and no allocation, and it is cheap in practice:

```
7.48 MB file: mid-prefix rewrite CAUGHT (served new005038), 5 appends 32 ms
real 245 MB ledger: cold 67 ms / 117 MB, then 5 reads in 8 ms and +1 MB
```

Both regression tests were driven red against the defective implementation before being
accepted — the rewrite test against a disabled guard, the mid-prefix test against a
reinstated sampled digest.

## Second review round: two more defects, and a corrected measurement

A re-review of the landed state found two further defects, and also caught that one of my
numbers was measured wrong.

**Corrected measurement.** The "real 245 MB ledger: 5 reads in 8 ms" figure in the earlier
section is wrong. It was taken AFTER a reviewer agent had truncated `usage.jsonl` to 4 MB,
so it measured a 4 MB file. Rebuilt at true scale, the honest figures are below.

**Defect 1 — the caller received rows outside its window.** Keeping a retained window that
starts earlier than `size - maxReadBytes` returns rows a fresh bounded read would exclude,
which makes `maxReadBytes` advisory instead of binding and lets `snapshotWindow` describe a
superset. Worse in practice: when the oversized window finally re-anchored, visible history
halved in a single poll on an append-only file, so dashboard totals swung ~2x between
refreshes. Measured before the fix: rows oscillated 688..1376.

Fixed by trimming in place. Rows that fall outside the window are dropped using recorded
per-row byte lengths (`entryLengths`), so the result equals a fresh bounded read exactly,
at O(dropped) instead of a reparse. Verified against a fresh read on every one of 60
rounds: 0 mismatches. Row count across 900 polls: flat at 1330, min == max.

**Defect 2 — the digest was O(file), not O(window).** Digesting `0..coveredThroughBytes`
twice per call is unbounded work while the read it replaces is capped at `maxReadBytes`,
so the ratio degrades as the ledger grows and the optimization becomes a PESSIMIZATION
past roughly 1-2 GB (measured 1.26x slower than a full read at 2 GB).

Fixed by digesting only `truncatedPrefixBytes..coveredThroughBytes` — exactly the span the
retained rows were parsed from, never wider than the window. Bytes before the retained
start are not described by any retained row, so reading them proved nothing.

Cost is now flat in ledger size:

| ledger | full read | incremental | ratio |
|---|---|---|---|
| 245 MB | 828 ms | 54 ms | 0.07 |
| 1029 MB | 813 ms | 53 ms | 0.07 |
| 2051 MB | 846 ms | 56 ms | 0.07 |

900 appends on an over-window ledger: 1 full read, 900 tail reads, span always within the
window. The sawtooth regression test was driven red (spread 20) against a deliberately
widened window before being accepted.

## Third review round: the trim under-counted skipped bytes

A third pass confirmed the below-window question (a rewrite in bytes no retained row
describes cannot corrupt output: those bytes appear in no returned row, and the window
only ever slides forward, with any re-anchor going through a full read) and the flat cost
curve. It then found a real defect in the trim arithmetic.

`entryLengths` recorded a length only for lines that PARSE. Malformed JSON, rows without a
string `requestId`, and torn final writes were skipped with `continue`, so their bytes went
unrecorded. The trim walk advances by summing those lengths, so it under-counted the true
byte distance and consumed extra rows to reach the window start — the mirror image of the
sawtooth: instead of showing too much history it silently showed too little, and it never
self-corrected. Reproduced at one bad line per five, 600 polls:

```
cached 1313 rows first R000873   |   fresh 1326 rows first R000860
```

Fixed by folding skipped bytes into the next accepted row's recorded length, carrying a
trailing remainder across the append boundary, and adding a self-check: the recorded
lengths plus that remainder must equal `size - truncatedPrefixBytes`, or the retained rows
are rejected and a full read runs. Two subtleties surfaced while proving it — `split`
leaves a zero-byte trailing element after the final newline, and deriving the offset from
the kept span double-counts the remainder; both are handled.

After the fix, at the same malformed-line density: 1326 rows both ways, identical first
row, identical `truncatedPrefixBytes`. The regression test asserts `tailReads` rather than
only output, because the consistency check makes the output correct either way — without
skipped-line accounting it simply degrades to a full read per poll (tailReads 0), which
the test now catches.

## Fourth round: three more, on a state nobody had reviewed

Rounds 1-3 all returned DEFECT FOUND, so the shipped head had never actually been
reviewed. A fourth pass on it found three more.

**Entry cap desynchronized the accounting.** Rows removed by `MANAGEMENT_USAGE_MAX_ENTRIES`
left the result without their bytes being accounted for, so the self-check failed and the
incremental path shut off permanently once the cap was reached — correct output, but the
optimization silently gone (13 full reads / 0 tail reads over 12 appends).

Fixing this exposed a design error of mine. My first attempt folded capped bytes into
`truncatedPrefixBytes`, which broke an existing test asserting that byte-window truncation
and entry-count truncation are INDEPENDENT API signals. That test was right: they are
different facts and consumers see both. The accounting offset is now a separate internal
field, `rowsBeginAtBytes`; `truncatedPrefixBytes` keeps its API meaning. The digest is
anchored to `rowsBeginAtBytes` at both write and verify — anchoring it to one and checking
the other is what made the cap case miss.

**Malformed-only appends were unbounded.** If every retained row is trimmed away and only
an unparseable remainder remains, nothing is left to advance the offset, so the retained
span kept growing past `maxReadBytes` while the accounting still balanced. Now re-anchors
with a full read.

**CRLF ledgers never used the incremental path.** `split(/\r?\n/)` consumes two bytes but
leaves no trace of it, so recorded lengths were one byte short per line and the self-check
rejected every reuse. Splitting on `"\n"` keeps the `\r` inside the line where its byte is
counted; `JSON.parse` tolerates the trailing `\r`. Before: 2 full reads / 0 tail. After:
1 full / 1 tail.

All three regression tests were driven red against the defective implementation. Cost
remains flat: 0.07x at 245 MB, 1 GB and 2 GB.

### Equivalence across all four truncation states

Checking `truncatedPrefixBytes` against a cold read in every combination — none, byte
window, entry cap, both — found two more problems that single-scenario probes had missed:

`entriesTruncated` was being ORed with byte truncation, so a byte-truncated read claimed
rows had been dropped when none had. It means ENTRY-count truncation only; the route ORs
the two signals itself.

When BOTH truncations apply, a cold read caps across the whole window and reports the
window boundary alone, while an incremental read reaches the cap by a different route and
cannot reconstruct that ordering from retained state. It now re-anchors there. This is not
a theoretical branch: real rows average **118 bytes**, so 500,000 of them occupy ~56 MiB
and fit inside the 64 MiB window, which means both truncations genuinely co-occur.

```
no-truncation         MATCH  trunc 0 vs 0          dropped 0 vs 0
window-truncation     MATCH  trunc 37830 vs 37830  dropped 0 vs 0
entrycap-truncation   MATCH  trunc 0 vs 0          dropped 40 vs 40
both-truncations      MATCH  trunc 74496 vs 74496  dropped 9 vs 9
```
