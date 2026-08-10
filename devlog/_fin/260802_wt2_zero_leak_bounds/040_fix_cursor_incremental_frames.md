# 040 — Fix #844: Cursor Connect incremental remainder + partial-EOF failure

Depends on: 001 root-cause delta. Header-time validation, 32/16 MiB caps, and 1,024-frame flow control already landed; this closes the concat-first growth and the silent partial-EOF discard.

## P re-verification note (2026-08-02, wp4 cycle — implementation-level design)

Current machinery (live-transport.ts:827-960, framing.ts:129-200):

- `pending: Uint8Array` accumulates via `concatBytes(pending, bytes)` per chunk (whole-backlog copy each time — O(n²) on a large incomplete frame).
- Master counter `transportBufferedBytes` tracks PAYLOAD bytes only (`connectBufferedPayloadBytes`), charged `cursor_transport`, cap 32 MiB (`CURSOR_TRANSPORT_MAX_BUFFERED_BYTES`), drives pause/resume with `CURSOR_MAX_PENDING_FRAMES` slots.
- `decodeAvailableConnectFrames(pending, 16 MiB, availableSlots, reservePayloadCopy)` returns `{frames, remainder}` — frames are `slice` COPIES (accounted per-frame), remainder is a fresh copy too (accounted via `remainderReservation`).
- `frameWork` is a self-extending promise chain; `.finally` releases each frame's payload and re-drains.
- EOF ("end"): zero-frame unexpected EOF fails; with frames → `settleFinish()` immediately — frameWork NOT awaited, pending remainder NOT classified.

Design (implements the raw-backlog + parser-cursor requirement):

1. Replace `pending` with `{ buf, start, end }` (cursor + capacity growth): append copies ONLY the new chunk (grow capacity ≤ cap, compact consumed prefix when `start` crosses a threshold); per-chunk cost O(chunk) amortized.
2. Raw cap INCLUDING headers: `end - start + chunk.byteLength > CURSOR_TRANSPORT_MAX_BUFFERED_BYTES` → typed overflow (`cursor_transport`). This closes the tiny-frame/header-flood gap (payload-only accounting missed headers). `transportBufferedBytes` semantics shift from payload-bytes to raw-used-bytes — a STRICTER counter; flow-control thresholds unchanged.
3. Drain without remainder copies: add a framing.ts export `consumeConnectFrames(input, start, maxPayloadBytes, availableSlots, reservePayloadCopy)` returning `{ frames, nextOffset }` (same inspect loop + per-frame reservations, NO remainder allocation); advance `start`. Frames stay slice copies with their existing reservation lifecycle.
4. EOF: settle via drain-to-quiescence — `do { prev = frameWork; await prev; } while (prev !== frameWork)` — then classify: `end - start > 0` leftover → fail typed `frame_incomplete` (unless `expectedClose`); else `settleFinish()`. Zero-frame unexpected-EOF behavior preserved.
5. `connectBufferedPayloadBytes(Across)` usages in the data handler are replaced by raw-used accounting; keep both helpers where the decoder still needs payload math.

Test hooks: existing cursor-framing/cursor-hardening suites drive transports with scripted chunks; new fixtures per scenarios 1-9. The saturation test asserts `transportBufferedBytes` never exceeds the raw cap and lease counters (`translatorBudget.snapshot()` via an injected budget, if the transport accepts one — check `LiveCursorTransport` constructor for the budget seam before writing tests).

## File map

- MODIFY `src/adapters/cursor/live-transport.ts`
  - Pending-chunk handling (~:894, `concatBytes()` :906-918): replace concatenate-first with a bounded raw-backlog + parser-cursor state machine (audit round 1 correction — "at most one incomplete frame" is WRONG when one delivered chunk contains additional complete frames while all 1,024 slots are occupied: those bytes cannot be returned to the HTTP/2 stream). The raw backlog stays bounded by the existing 32 MiB transport budget and header validation at 5 bytes; the cursor consumes complete frames WITHOUT re-concatenating the whole backlog per chunk; slot admission, reservation rollback, and pause/resume are preserved exactly.
  - EOF handling (~:949): settlement must first DEFER through queued async `frameWork` (currently settles without awaiting it — audit round 1); once work drains, a leftover incomplete remainder fails the turn with typed `frame_incomplete` — today complete-frames-plus-trailing-partial settles successfully and silently discards. Expected client-tool cancellation must NOT produce this error.
  - Terminal paths: explicitly release any remaining pending-payload lease on every settle path.
- MODIFY `src/adapters/cursor/framing.ts` (only if the streaming decode helper belongs there — wrap/extend :129, accepting the existing max-payload + reservation callbacks; keep `decodeConnectFrame` semantics for existing callers).
- MODIFY `tests/cursor-framing.test.ts` + `tests/cursor-hardening.test.ts`: new regressions (below).

Scope OUT: raising the 16 MiB effective inbound cap (recorded decision in 001 — PR #844's flat 32 MiB breaks the copy-overlap budget), outbound uint32 framing (`framing.ts:59` stays), header-byte accounting (frame-count flow control defends tiny-frame floods; documented).

## Acceptance + activation scenarios

1. Chunked delivery of one frame split across many small chunks: raw backlog high-water stays bounded (backlog ≤ 32 MiB transport budget; no whole-backlog re-concat per chunk — assert allocation/copy counts or high-water mark); decoded frames and final byte accounting identical to the old path. Activation: chunk-size sweep test (1,3,7,64 KiB chunkings).
2. Complete frame + trailing partial frame + EOF (after frameWork drains): turn fails typed `frame_incomplete`; the completed frame was still delivered. Activation: hardening test driving exactly this sequence (red on pre-fix tree — today it settles clean).
3. EOF with only partial header (<5 bytes): same typed failure. Activation: variant of #2.
4. Expected cancellation with pending remainder: no `frame_incomplete`. Activation: cancellation fixture.
5. Oversized declared length is still rejected at header arrival (existing behavior preserved through the refactor). Activation: existing :124 tests stay green.
6. 1,024-frame flood + rollback behavior unchanged. Activation: existing :155 tests stay green.
7. Slot saturation + multi-frame chunk + trailing partial EOF (audit round 1 scenario): all 1,024 slots occupied when a chunk carries further complete frames plus a partial; backpressure holds, no bytes lost, EOF classifies the partial typed after work drains, and the pending-payload lease is released on every terminal path. Activation: saturation fixture asserting lease counters return to zero.
8. Red-green: #2, #3 and #7 red on the pre-fix tree.

## Regression risks (watch in C)

- EOF must wait for already-admitted async frame work before declaring incompleteness.
- Compressed/end-stream flags and frame order preserved.
- HTTP/2 pause/resume (frame-slot backpressure) must keep working with incremental decode.
