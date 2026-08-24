# 081 — WP8 execution and the program's closing reconciliation

Four candidates reviewed at their current heads, and a final count that is honest about
a backlog which never stopped moving.

| PR | Verdict | Why |
|----|---------|-----|
| #2083 image relay | **FAIL** | its own test file cannot parse |
| #2366 usage timeline | **FAIL** | nothing persists; commit claims `closes #1217` |
| #2368 nested delimiters | **FAIL** | 35 commits behind, unrelated test still bundled |
| #2033 sidecar status | **FAIL** | 615 commits behind, four recorded blockers still open |

## #2083 — the most mergeable PR, and still not mergeable

This was the strongest remaining candidate: APPROVED, mergeable, and with genuinely
complete security work. Reverting hunks in a throwaway worktree confirmed the aggregate
relay budget, the empty-edit 400 before any Imagine POST, `redirect: "manual"` with 3xx
rejection, and sanitized upstream errors are all load-bearing.

Then the runner said:

```
$ bun test tests/images/z-fulfill.test.ts
SyntaxError: Export named 'resolveXaiAspectRatioLiteral' not found in module 'src/images/xai-client.ts'
 0 pass, 1 fail
```

The test file mocks `xai-client` and exports only `callXaiImages`, while `fulfill.ts` now
also imports `resolveXaiAspectRatioLiteral`. The isolate runner therefore fails before a
single assertion runs — **the new `aspect_ratio` regression never executes**.

The approval also predates this head by four substantive commits, and cross-platform CI
has never run on this SHA. A one-line mock fix makes it landable.

## #2366 — a schema nothing writes

```
addRequestLog(... five fields ...)  ->  {streamTimeline:null, failureSide:null, ... }
appendUsageEntry directly           ->  round-trips fine
requestLogEntryFromPersistedUsage   ->  projects all five back to null
```

`RequestLogEntry` was never extended, and the function `GET /api/request-history/:id`
projects through copies none of the fields. Live `/api/logs` can show `transportPhase`
until restart; durable history can never show any of it. There is no runtime producer at
all — `rg` finds the field names only in `src/usage/log.ts` and its test.

Its first commit says `closes #1217`. Also, one of its two new tests passes with the
source reverted, because the allowlist rebuild already dropped unknown keys.

## What the four have in common

Every one is *good work that is not finished*, and in three of four cases the gap is
invisible from the diff: a mock missing an export, a persist path that silently drops
fields, a branch 615 commits behind whose file has since changed underneath it. None
would have been caught by reading the patch.

## Reconciliation, and the honest count

```
45 open at unit open   ->   45 open now
```

That number looks like nothing happened, and it is the most useful thing in this
document. **Ten PRs merged and eight closed during the program**, while roughly the same
number arrived — three of them (#2387, #2388, #2390) after this phase's own inventory
was taken.

A backlog with an active contributor base is not a queue that drains; it is a flow. The
useful measure is not the open count but whether each item carries a recorded, evidenced
disposition — and every PR this program touched now does.

## Program totals

**Merged (10):** #2309, #2313, #2335, #2339, #2359, #2361, #2371, #2310, #2301 (rebuilt),
plus the record PRs.
**Closed with reasons (8):** #2360, #2357, #2041, #2222, #2302, #2303, #2304, and #2033's
predecessor lane.
**Left open with reproduced blockers (9):** #2350, #2351, #2355, #2362, #2363, #2364,
#2083, #2366, #2368.
**Issues closed (4):** #2316, #2356, #2330, plus #2308 addressed via #2309.
**Deferred with evidence (2):** #1049 (needs a publisher phase), #2221 (needs a
fingerprint decision).

## The recurring defect class

Six PRs this program held back shared one shape: **the code does something the
description denies, and the tests pass either way.**

- #2350 deletes non-empty tool outputs while claiming to annotate empty ones.
- #2351 records the admission secret while claiming never to record secrets.
- #2355 clears its own staleness warning.
- #2363's tests pass with the feature disconnected.
- #2364's second commit deleted the validation its first commit added.
- #2366 persists nothing while claiming a durable timeline.

Not one was visible from the diff. Each needed the same move: revert the hunk, re-run,
and watch what does *not* go red. That is the single most transferable finding here.

