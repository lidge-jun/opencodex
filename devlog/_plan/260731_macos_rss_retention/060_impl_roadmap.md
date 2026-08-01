# Implementation roadmap — RSS retention patches (post-investigation)

Opened 2026-08-01. Consumes the investigation docs 050–053 and turns them into
dependency-ordered implementation phases. One decade doc per work-phase; one
work-phase per PABCD cycle. Push to `origin/dev` is explicitly authorized by
the user for this unit's commits.

## External evidence refreshed 2026-08-01 (Luna lanes, source-opened)

- Bun latest stable remains v1.3.14 (2026-05-13). No newer stable exists.
- Bun PR #35843 (merged 2026-07-31, UNRELEASED) fixes `Response.clone()`/tee
  deep-copy retention (~1043 MB → ~16 MB for a 100-deep clone chain) by sharing
  chunk references. Confirms tee-branch retention is a real, acknowledged Bun
  cost — and that no released runtime carries the improvement.
- Bun PR #32120 (merged 2026-06-21, unreleased) fixes the #32111 client-abort
  use-after-free. `MIN_FIXED_BUN_VERSION` stays null.
- OpenAI Responses streaming contract (platform docs): terminal
  `response.failed` carries a full response object with `status:"failed"` and
  a populated `response.error {code,message}`; `response.incomplete` uses
  `incomplete_details.reason` with `error:null`. A top-level `error` SSE event
  is a distinct stream-level shape. The existing synthetic tail in
  `relaySseWithFailedTail` must stay schema-compatible when ported to eager.
- Bounded-SSE-parser precedent: `eventsource-parser` (cap example 1 MiB,
  overflow terminates parsing), undici `dump` interceptor (1 MiB default,
  closes connection). WHATWG SSE defines no max event size — caps are
  implementation policy. Our overflow policy differs deliberately: the cap
  protects the INSPECTION branch only, so overflow degrades inspection
  (discard-and-resync) instead of killing the client stream.

## Phase map

| Phase doc | Work-phase | Content | Depends on |
|---|---|---|---|
| `070_harness_warm_fix.md` | wp2 | Apply 050's harness diff (monotonic pause clamp, child-exit/duration split) + post-patch remote smoke calibration | — |
| `080_inspection_bounds.md` | wp3 | relay.ts inspector caps + clear points + disconnect cancel (both consumers) + parse-once + observability counters on `/api/system/memory` | — |
| `090_eager_failed_tail.md` | wp4 | relay-eager.ts synthetic `response.failed` tail on mid-stream reset | 080 (dispose hook touches the eager producer finally) |
| `100_darwin_eager_optin.md` | wp5 | core.ts gate: darwin joins win32 for explicit `eager-relay` no-rewrite traffic; `auto` stays tee; local darwin abort-stress gate | 090 (tail must exist before opt-in is reachable) |
| `110_verify_and_push.md` | wp6 | full-suite/typecheck/privacy gates, devlog closeout, push | 070–100 |

Ordering rationale: 070 is independent and unblocks any future macmini re-run.
080 attacks the proven lag/retention mechanism and is measurable via its own
counters. 090 must land before 100 per 052's risk table (opt-in without the
tail loses reset semantics for opted-in clients). 110 is the terminal gate.

## Design decisions locked for 080 (from 051 §Bounded-fix proposal + Luna evidence)

1. `MAX_INSPECTION_SSE_FRAME_BYTES = 4 MiB` — strict RAW-BYTE bound (byte-slice
   accumulation, incremental cross-chunk delimiter scan, decode-once on
   completion) with discard-and-resync overflow state
   (`discardingOversizedFrame`), scanning only delimiter state while
   discarding. Client bytes are never affected. (1 MiB → 4 MiB and
   string→raw-byte accounting per audit round 1; see 061.)
2. `MAX_COMPLETED_OUTPUT_ITEMS = 256` and
   `MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES = 8 MiB` — keep lowest indexes,
   evict highest, reject single items above the aggregate cap; charges are
   source BYTES. Any eviction TAINTS reconstruction so a truncated output can
   never be persisted as replay history (061 blocker 3).
3. Clear-at-handoff: `try/finally` around `onCompletedResponse` with
   `completedItemsByOutputIndex.clear()`; immediate clear on
   `response.failed`/`response.incomplete`; `finish()` clears in `finally`;
   new `dispose()` invoked from all consumer `finally` blocks.
4. Parse-once: single `JSON.parse` per complete payload shared across
   request-log metadata, first-output, terminal detection, and continuation
   capture (currently up to 5 parses per early event).
5. Disconnect ownership: tee topology gains a client-cancel notification for
   BOTH background consumers (shared bounded pump) — bounded drain
   (15 s / 32 MiB) preserving late-terminal capture, then explicit
   `reader.cancel()` + inspector dispose + turn unregister.
6. Counters exposed on `GET /api/system/memory` (and `ocx observe memory`):
   inspection frame-buffer high-water bytes, completed-items max count,
   frame-cap overflow count, item-cap eviction count, post-cancel drain
   terminations. Process-lifetime totals; cheap monotonic counters only.

## Design decisions locked for 090 (from 052 Gap 3 + schema lane)

- Capture the producer error; when no protocol terminal, no client cancel, and
  no server abort: discard incomplete rewrite frame, enqueue delimiter +
  `response.failed` envelope + `[DONE]` (same bytes as
  `relaySseWithFailedTail`), call `onSynthetic("failed")` once, close (not
  error) the client stream, abort upstream in teardown.
- Cap the serialized error-message length; account tail bytes in the client
  queue. Suppress when `sawTerminal()` is true. Do not feed the tail through
  the inspector.

## Design decisions locked for 100 (from 052 risk table)

- Gate change only: `(win32 || darwin) && !needsClientRewrite`, and darwin
  additionally requires the EXPLICIT `streamMode: "eager-relay"` decision
  (`reason: "config-eager"`). `auto` on darwin stays tee while
  `MIN_FIXED_BUN_VERSION` is null. No rewrite-path widening.
- Bun#32111 posture per 052: eager avoids the known reproducer shape but is
  unproven on 1.3.14 — opt-in only, never default.

## Out of scope for this unit's implementation phases

- Allocator residual (053): documented NOOP until a stable Bun ships the
  allocator train. No forced GC, no FFI purge, no restart-as-fix.
- Rewrite-traffic eager migration (052 steps 4–6): future unit.
- `auto` default flip: blocked on a released Bun carrying #32120 (UNSAFE
  boundary per goalplan).
