# ADR-3389 — decision recorded under "Ambiguous connection-reset replay boundary"

- Contract owner: [transports/responses.md](../transports/responses.md#ambiguous-connection-reset-replay-boundary)

## Decision record

- Intent: Recover one native HTTP Responses turn when a pooled socket resets after headers but before protocol output, without replaying a turn that may already have emitted a tool call.
- Prior constraint: `devlog/_fin/260703_sse-midstream-reset-tail/00_plan.md` prohibited mid-stream resend because downstream byte counts cannot prove that the origin committed nothing.
- Alternatives considered: Keep every post-header reset terminal; resend when the downstream reader consumed zero bytes; inspect and buffer the protocol preamble during downstream body consumption before deciding.
- Decision: Permit one same-request HTTP replacement only when deferred SSE inspection parsed `response.created`, observed no output, tool, unknown or terminal event, and then received a reset-shaped read error.
- Rationale: Bun may discard buffered chunks on reset, making zero consumed bytes timing-dependent. The body preflight drains until a protocol commit boundary and provides stronger positive evidence while preserving progressive response headers and the original failure for every ambiguous shape.
- Consequences: Native Responses can recover this narrow failure using existing send accounting and credential admission. Resets before `response.created`, after any committing event, on a replacement stream, over WebSocket, and on native Chat remain non-replayable.
