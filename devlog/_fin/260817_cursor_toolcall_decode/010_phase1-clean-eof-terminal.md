# 010 — Phase 1: fail an unlabeled EOF that truncates a tool call

Answers **F1** (`003`). Severity High. One PABCD cycle.
**Revised four times under adversarial audit** (rounds 2, 4, 5, 6). Round 6
reversed round 5. Read "Scope, finally settled" before anything else.

## Scope, finally settled (round 6)

Round 5 claimed the duplicate-terminal defect already ships on `dev` and demanded
this phase enforce "exactly one terminal per turn" turn-wide. Round 6 disproved
that premise, and I verified it directly:

- The **bridge already enforces terminal singleness.** Streaming stops and cancels
  upstream at the first terminal (`bridge.ts:1248`); batch ignores later events
  after the first error (`:1619`).
- `tests/bridge-terminal-singleness.test.ts` exists precisely for this and covers
  error->done, done->error, and producer abort. I ran it: **3 pass, 0 fail**.

So a second *adapter* terminal never becomes a second *protocol* terminal. Round
5's tests 7 and 8 would have been red at the adapter boundary and green at the
boundary users actually observe — a regression test for a bug nobody can see.

Round 6 also showed the proposed enforcement could not have worked anyway: the
transport `push` seam is not the choke point, because adapter-owned errors bypass
it entirely (`cursor.ts:127` on abort, `:180` on a transport throw).

**Therefore this phase reverts to its original, narrow scope: F1 only.** Internal
adapter tidiness is not a defect worth a scope expansion, and the honest record is
that round 5 was wrong. Round 6's finding 3 (a genuine zero-terminal path on
unexpected `NGHTTP2_CANCEL`, `cursor.ts:181`) is recorded as a follow-up in
`000_index.md`, not absorbed here.

## Problem restated

`live-transport.ts:1029` settles gracefully whenever the HTTP/2 stream ends with
at least one complete frame, without asking whether a terminal was ever emitted.
With a client tool call still open, its buffered arguments are discarded and the
call never reaches the bridge at all.

Streaming partly repairs this — a terminal-less adapter EOF becomes
`response.incomplete` / `adapter_eof` (`bridge.ts:1283`). Non-streaming does not:
with no error and no incomplete event, status defaults to `"completed"`
(`:1829`). **The user-visible defect is a truncated turn reported as success on
the non-streaming path, and a lost tool call on both.**

## What `state.terminated` means (round 4 correction, retained)

Not "a real `turnEnded` arrived". `finalizeTurnEvents` sets it, and both the real
`turnEnded` (`protobuf-events.ts:1327`) and the synthetic client-tool finalize
(`finalizeAfterDrain`, `live-transport.ts:386`, armed at `:750`) reach it. The
predicate wants "a terminal was already emitted", and for the EOF branch that is
what `state.terminated` provides.

The round-4 concern — a mapper error leaves calls open without setting
`terminated` — still applies **to this branch specifically**: after such an error
the bridge has already failed the turn, so failing again at EOF adds a duplicate
adapter error for no benefit. The narrow guard is an `emittedTerminal` flag on the
transport's `push` (`live-transport.ts:531-535`), read **only** by the EOF
branch. Round 6's objection was to using that seam for a turn-wide invariant; as
a local guard for one branch it is sound, because every mapper-produced terminal
does pass through `push`.

## Contract

At the `end` handler, after the existing leftover-bytes and zero-frame checks:

```
!expectedClose && !state.terminated && !emittedTerminal && openToolCalls.size > 0
  -> releaseBacklogLease(); settler.settleFail(new CursorStreamTruncatedError(...))
otherwise -> unchanged settleFinish()
```

The transport owns this terminal; `finalizeTurnEvents` is **not** called at EOF,
so `cursor.ts:180` produces exactly one error. `protobuf-events.ts` is unmodified.

## Not in scope

- The non-streaming `completed` default (`bridge.ts:1829`) — real, but needs
  evidence about whether Cursor ever legitimately ends a stream without
  `turnEnded`; a wrong guess fails healthy turns.
- Turn-wide adapter terminal ownership — disproved as user-visible by round 6.
- The `NGHTTP2_CANCEL` zero-terminal path (`cursor.ts:181`) — real, separate.
- Retry. `committed` is set on HTTP/2 `connect` (`:780`), so a post-frame EOF can
  never satisfy `canRetry` (`transport-retry.ts:99`). The round-1 claim stays
  withdrawn.

## Diff-level plan

**`src/adapters/cursor/cursor-errors.ts`** — add `CursorStreamTruncatedError`
carrying the open call ids and frame count. Not retryable.

**`src/adapters/cursor/live-transport.ts`** — add the per-run `emittedTerminal`
flag set in `push` for `done`/`error`; add the single EOF branch above. Nothing
else changes; in particular `failAndClear` and the message dispatch are untouched.

## Tests (`tests/cursor-eof-terminal.test.ts`)

Fixtures (round 5): `withDiscoveryServer` (`tests/cursor-hardening.test.ts:17-39`),
`startedFrame`/`execFrame` (`tests/cursor-tool-finalize-race.test.ts:20-59`),
`turnEndedFrame` (`tests/cursor-protobuf-events.test.ts:66-71`),
`validEmptyFrame` (`tests/cursor-hardening.test.ts:412-414`).

1. EOF after >=1 frame with an open call, no terminal -> rejects with
   `CursorStreamTruncatedError` naming the open call id. **The F1 regression.**
2. EOF after a real `turnEnded` -> graceful, emits `done`.
3. EOF after the synthetic client-tool finalize -> graceful.
4. EOF during `expectedClose` with a surviving sibling -> graceful. (Its fixture
   necessarily emits an error, so it exercises the path, not the lone conjunct.)
5. EOF after >=1 frame with no open call -> unchanged graceful finish.
6. Mapper error + surviving open call + EOF -> exactly one adapter terminal,
   confirming the guard suppresses a duplicate on this branch.
7. End-to-end: the truncated turn surfaces as a failed/incomplete Responses turn
   rather than a `completed` one with a missing tool call. This is the test that
   speaks to the user-visible symptom; the rest are adapter-level.

## Done when

All seven pass, `bun run typecheck` clean, cursor suite green on `ssh lidge`,
pushed. Test 1 must be demonstrated red on the pre-fix tree.

