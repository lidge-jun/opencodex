# 042 — Ticket #29: streaming Responses relay + frame parity

Unit: `260905_go_sidecar_takeover`
Date: 2026-09-06
Ticket: [#29](https://github.com/waxiangzi/opencodex/issues/29)

## Scope

The Go data-plane relay now directly serves a narrow `stream: true`,
`openai-responses` subset. It incrementally frames upstream SSE, mirrors the
unconditional Responses field backfill, observes the first Responses terminal,
and preserves exact client bytes against the TypeScript tee-path oracle. Any
request outside this subset remains on the authenticated parent bridge.

## Byte protocol

The state machine retains incomplete transport bytes until it sees one of all
four legal blank-line delimiters: LF/LF, LF/CRLF, CRLF/LF, or CRLF/CRLF.
Complete blocks retain their original delimiter. A rewrite extracts and joins
`data:` lines, parses JSON only when valid, and replaces the first data line
only when the field backfill changed the event. CRLF blocks retain CRLF. An
unterminated EOF block is rewritten and synthetically delimited using its
newline style.

`response.completed`, `response.failed`, and `response.incomplete` form the
client boundary. Frames after the first terminal are dropped. A pre-terminal
`data: [DONE]` is held until a terminal arrives; a terminal without an actual
DONE receives the conventional LF DONE frame. Clean EOF without a terminal
receives the adapter-EOF incomplete event plus DONE. Upstream read errors flush
the partial frame and append the static TypeScript failed-tail fallback because
Go and Bun transport error strings differ.

The committed six-row oracle corpus exercises sparse object repair, truncated
and incomplete tails, malformed joined data containing DONE, CRLF delimiters,
and terminal incomplete. The Go tests run each row whole and byte-by-byte, and
also prove terminal ordering, post-terminal dropping, premature-DONE holding,
and the frame-size limit.

## Admission

Stream admission resolves the existing narrow route first and rejects provider
configuration that arms a client-visible transformation:

- material `responsesItemIdRepair` (the empty object is inert),
- `responsesSnapshotRepair: true`,
- `statelessResponses: true`, or
- a case-insensitive match of the plan model in `preserveReasoningContentModels`.

These checks apply only to streams. Non-stream behavior remains ticket #27's
whole-body relay. A successful `2xx text/event-stream` is incrementally
rewritten and flushed; non-SSE and non-2xx stream responses retain the previous
verbatim transport behavior.

## JSON encoding

`jsonwire` now uses ECMAScript own-property ordering when a repaired event is
re-serialized: canonical array-index keys from `0` through `4294967294` sort
numerically first, then all other keys retain document order. This pins the
sparse oracle's `"1"` key behavior.

## Residuals

- Cyber-policy `error` terminal classification is still TypeScript-owned.
- Malformed-output-index synthetic ids use the same process-global fallback
  ordinal namespace as the TypeScript rewrite.
- Admission inspects saved Go-visible provider configuration, not every routed
  merge nuance.
- The oracle is the TypeScript tee transport path; eager transport ordering is
  not separately reproduced.
- Frame growth is bounded at 4 MiB; exact overflow recovery is intentionally
  outside this narrow relay claim.
- The pre-existing undeclared-tool guard remains allowed only in the narrow
  configuration where no declared-tool mismatch is involved.
