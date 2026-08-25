# 040 — wp5: #2473, oversized Responses turns must never open a WS socket

Phase: wp5. Depends on: wp1. PR: #2473, head `5a3d32c8d`, author `olddonkey`.

## Defect

A `response.create` larger than the backend's 16 MiB frame ceiling is sent over
an already-open WebSocket, the backend closes with `1009`, and the client
retries the same oversized frame. The thread never recovers, and because the
socket was already open there is no SSE path left to fall back to.

## The change (verified by reading the call order)

`src/server/responses/ws-upstream.ts:31-46` — NEW constants: 16 MiB ceiling,
64 KiB margin.

`src/server/responses/ws-upstream.ts:121-158` — NEW UTF-8-aware admission:

```ts
return Buffer.byteLength(frameText, "utf8") >= limitBytes;
```

`src/server/responses/ws-upstream.ts:174-214` — MODIFY. The order is the whole
fix, and it is correct:

1. `:176` parse body
2. `:180` build the **actual** outbound frame
3. `:189` evaluate the limit
4. `:190` return SSE if oversized
5. `:214` `new WebSocket(...)` — only reached when not oversized

`src/server/responses/fetch-helpers.ts:66-86` — MODIFY: `httpFetch` applies
`withUpstreamHttpVersion` before delegating, so the SSE fallback keeps the
provider's pinned HTTP version.

## Where the reviewer said NEEDS-FIX, and the decision

The reviewer's blocker was that close code `1009` stays a plain `Error`
(`ws-upstream.ts:345-363`), so the relay maps it to the generic
`upstream_reset` (`src/server/relay.ts:85-99`) and the request log drops the
terminal code (`src/server/request-log.ts:816-839`).

That reading is correct, but the remedy it implies — a new typed error class
threaded through `relay.ts` and `request-log.ts` — expands a 3-file transport
fix into the error taxonomy and logging pipeline. **Decision: the typed-1009
criterion is split out of this phase.** What must be true here is the
recoverability property: an oversized turn opens no socket and reaches SSE.
Diagnostic typing is a follow-up issue, filed at close, and the acceptance
criterion in the goalplan is amended accordingly rather than silently dropped.

This is a scope decision, and it is recorded because it contradicts a reviewer
verdict. The reviewer's other blocker — adjacent-byte coverage — **is** in
scope and cheap.

## Required test additions

`tests/ws-upstream.test.ts` — MODIFY:

1. `routes an exact limit-minus-one frame over WS` — serialize the real outbound
   frame to exactly `CODEX_WS_CREATE_FRAME_LIMIT_BYTES - 1`; assert one socket,
   one send, zero SSE calls.
2. `routes an exact limit frame over SSE without dialing WS` — assert one SSE
   call, `FakeWebSocket.instances` length 0, zero sends.

The PR already asserts `fallbackCalls === 1` and zero socket instances for a
grossly oversized frame (`tests/ws-upstream.test.ts:710-715`); these two pin
the boundary itself, which is where an off-by-one would actually live.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Oversized frame constructs zero `WebSocket` instances | `bun test tests/ws-upstream.test.ts` |
| 2 | Just-under-limit uses WS; at-limit uses SSE | same (new adjacent-byte tests) |
| 3 | SSE fallback preserves `upstreamHttpVersion` | same, protocol assertion |
| 4 | A turn cannot execute twice across both transports | same, `fallbackCalls === 1` |
| 5 | Typed-1009 follow-up issue filed | issue URL recorded in this doc at close |
| 6 | Merged | merge SHA + ancestry |

## Scope boundary

IN: `ws-upstream.ts`, `fetch-helpers.ts`, `tests/ws-upstream.test.ts`.
OUT: `src/server/relay.ts`, `src/server/request-log.ts`, and the error taxonomy.

