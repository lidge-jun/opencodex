# Terminal-repair PR: profiled redaction follow-up

## Scope and revisions

PR #8774 originally changed terminal-repair buffering. Its failing CI assertion
exercises the shared credential masker, unchanged between the original base and
head. The initial bounded comparison remains in `010_bounded_comparison.md`;
this follow-up fixes measured work without changing assertions or deadlines.

- Original base: `1d10758fa6ced80cdd780cb000bc5c4b83f84703`.
- Original PR code: `ada6a63b052da9b95f71f23e738ddaee08c78303`.
- Refreshed comparison base: `c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc`.
- Refreshed dev merge: `cb8f180d2ac174447abc0ffe937cf94101048afe`.
- Lazy ASCII offsets: `56bc8e92b`.
- Complete redaction fix: `16d3b83be0c1380038f77ae967c5b9231a5b988c`.

Registry, folding, redaction and the failing test have no source change between
the original and refreshed bases. The branch includes dev through a normal merge.

## Profile and counted work

A Bun 1.4.4 CPU profile on Windows used the original four 16,000-character fixture
credentials and 3,900,001-character message. The diagnostic driver separately
invoked exact masking, pattern masking, excerpt masking, the complete rewrite and
a 20,000-value registry check. This deliberately repeats work and is not a
breakdown of the test's timer. The excerpt closure, `markSubstringSpans` and
`containsIndexedSecret` accounted for approximately 71% of self time; each sliced
eight characters at every position before its Set/Map lookup. Folding also
initialized large offset arrays even when no label matched. Profiler-enabled
times are not used as speed evidence.

A separate source-counter experiment counted ASCII identity-array constructions
larger than one million entries. Temporary copies redirected folding/redaction/
registry imports, preserving real other helpers; counters ran only at allocation.
Counting and timing runs were separate. The original full rewrite created:

| Identity-array size | Original count | Lazy-map count |
| --- | ---: | ---: |
| 3,900,002 entries | 10 | 0 |
| 3,836,046 entries | 10 | 0 |
| Total initialized entries | 77,360,480 | 0 |

The complete output SHA-256 matched with original, lazy-map-only and combined
implementations: `9d4440072fee38f7e34a66e12877b610751506ec331c131aaaf05fa4ea0b04d9`.
Entries are counted, not converted into a claimed engine-specific heap saving.

## Changes and bounds

1. ASCII folding caches its identity map on first access; four pattern consumers
   request offsets only after matching. Unicode/escape folding and offset
   fallbacks are unchanged. Repeated access returns the same array. No repository
   consumer assigns the `map` property.
2. Literal ASCII without label delimiters (`:`, `=`, `<`) or escape introducers
   bypasses label folding. Every labelled grammar requires those delimiters;
   Unicode and escaped input keeps both matching views. Token-pattern masking,
   including unlabelled bearers and JWTs, still runs.
3. Window/prefix indexes reject impossible first-two-code-unit pairs before
   slicing. Each nonempty index adds an 8 KiB UTF-16 low-byte bitset. Collisions
   still require the original exact lookup; no filter match grants acceptance.
4. The prefix walk stops once every deduplicated long secret has had its full
   overlapping KMP scan. Short matches are already marked; unscanned/non-overlapping
   secrets prevent the return. Work-budget charges and fail-closed results remain.

Worst-case time stays O(n). An ASCII nonmatch needs O(1) offset-map space instead
of O(n). Prefix slices become O(c), for c candidate starts <= n, while the filter
still scans O(n) characters. Deterministic regressions count 4,089 -> 0 slices on
a 4,096-character impossible-prefix input in four paths, and 4,089 -> 1 prefix
lookup for a fully scanned repeated key.

The lazy-map-only Bun variant removed the arrays but still failed the original
elapsed assertion locally. An intermediate combined variant exceeded the
eight-file deadlines too (target 1,547.85 ms; repeated-key case 1,537.24 ms).
This motivated delimiter rejection. Those failures were retained, not retried
until green or hidden by weakening assertions.

## Regression and differential evidence

Seven deterministic work checks fail on unchanged base code: five prefix/lookup
checks and two folding checks. Their focused negative controls select test names
only to prove the new regressions are red on old code. Successful validation runs
entire files. New coverage includes raw/escaped control characters, quotes,
backslashes, lone surrogates, low-byte collisions, cached-index reuse, multiple
overlapping secrets, safe surrounding copy and later short matches. Existing
credential-content, protocol, classification, scan-cap, overflow, bounded-work
and elapsed-time assertions remain in place.

Temporary differential drivers compared complete outputs rather than selected
credential excerpts:

- Seed 41: 20,006 comparisons of masks, guards and indexed containment, including
  short/overlapping values, UTF-16, cached reuse, scan boundaries and overflow.
- Seed `0x8774da`: 2,048 complete pattern-redaction outputs, 4,096 complete folded
  strings/offset arrays across both decode modes, and 256 complete terminal SSE
  rewrites with nested output/metadata: 6,400 comparisons.
- All 26,406 comparisons matched. Digests of the result sequences:
  `91462475c6365181e26e33b6915e3b235275f7904b002afae60682be35c7bb8a`
  and `e80e31c7fa760a441fd80ab36caf68618787b3a857d9e047f4a4f6da53850831`.

## Fixed-order full-file comparison

Both revisions used one native Windows machine, Bun 1.4.4, the same installed
dependencies, repository wrapper and home isolation, with fresh processes and
four workers configured. The detached base shared dependency directories by
junction; neither dependencies nor runtime changed. No other agent test, build
or profile ran concurrently with these samples.

Sample count/order were fixed before starting: three pairs per scenario,
**base, head, head, base, base, head**. Both checkout hashes were checked first.
Every sample/exit code is retained. The initial comparison's clock preload
captured real timestamps at unchanged line 548; no clock or assertion was faked.
The new counter tests run after the original timed tests in that file.

The commands use the initial document's preload as an absolute PROBE path:

```sh
bun run test -- --parallel=4 --preload PROBE tests/responses/sse-untyped-credential-mask.test.ts
bun run test -- --parallel=4 --preload PROBE tests/responses/sse-untyped-credential-mask.test.ts tests/responses/responses-terminal-repair.test.ts tests/responses/sse-payload-rewrite.test.ts tests/responses/sse-failed-tail.test.ts
```

The one-file scenario has no other test-file worker load. The four-file scenario
includes the actual terminal-repair tests on each revision, including PR cases.

The elapsed column is the original assertion's measurement, not runner test time:

| Run | Scenario | Revision | Elapsed ms | Pass / fail | Exit |
| ---: | --- | --- | ---: | --- | ---: |
| 1 | One file | Base | 3194.34 | 96 / 2 | 1 |
| 2 | One file | Head | 406.46 | 116 / 0 | 0 |
| 3 | One file | Head | 393.22 | 116 / 0 | 0 |
| 4 | One file | Base | 2414.40 | 97 / 1 | 1 |
| 5 | One file | Base | 2358.95 | 97 / 1 | 1 |
| 6 | One file | Head | 398.84 | 116 / 0 | 0 |
| 7 | Four files | Base | 2476.73 | 407 / 1 | 1 |
| 8 | Four files | Head | 443.71 | 430 / 0 | 0 |
| 9 | Four files | Head | 452.78 | 430 / 0 | 0 |
| 10 | Four files | Base | 2395.23 | 407 / 1 | 1 |
| 11 | Four files | Base | 2633.43 | 407 / 1 | 1 |
| 12 | Four files | Head | 378.49 | 430 / 0 | 0 |

Medians: one file **2414.40 -> 398.84 ms**; four files **2476.73 -> 443.71 ms**.
All six base invocations failed the unchanged target assertion. All six head
invocations passed every selected test. No samples were discarded or retried.
These are bounded local measurements, not a cross-machine speed guarantee.

## Other verification and limits

The final full eight-file related set at four workers passed 633 tests, with
0 failures and 2,600 assertions (58.76 s): the four comparison files plus
`tests/lib/redact.test.ts`, `tests/usage/upstream-failure-diagnostics.test.ts`,
`tests/responses/responses-fetch-helpers-boundary.test.ts`, and
`tests/responses/responses-request-compression.test.ts`. Additional framing/provider
coverage passed 69 tests and 420 assertions (18.82 s):
`tests/responses/sse-payload-rewrite-continuation.test.ts`,
`tests/responses/sse-carriage-return.test.ts`,
`tests/providers/deepseek-inbound-wire.test.ts`,
`tests/providers/opencode-muse-terminal-repair.test.ts`.

A synthetic bearer fixture initially tripped privacy scanning. It was replaced
with the existing allowed test sentinel; the entire library file then passed
53 tests/306 assertions. Scanner rules and exceptions were unchanged.

Typecheck passed for 2,564 files; structure, privacy and whitespace checks passed.

Full-suite scope exception: the common redactor's import graph is broad (previous
CI selected 903 files and over 23,000 tests). This run uses the focused full-file
suites above rather than another full repository or `test:changed` run on Windows.
It does not claim full cross-platform coverage or explain the Linux scheduling/GC
conditions. Required CI must succeed on the new PR head; the existing CI hold
remains. No hosted dispatch or retry was requested. Credential handling requires
explicit maintainer security review before merge.
