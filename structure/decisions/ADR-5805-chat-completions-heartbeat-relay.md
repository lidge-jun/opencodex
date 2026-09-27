# ADR-5805 — decision recorded under "Heartbeat and stall deadline"

- Contract owner: [transports/streaming-health.md](../transports/streaming-health.md#heartbeat-and-stall-deadline)

## Decision record

- Purpose and intent: Keep translated Chat Completions streams transport-alive while the Responses bridge
  is receiving typed heartbeats during long reasoning or held output.
- Existing behavior and constraints: The converter used a heartbeat only to ensure the initial assistant role;
  every later heartbeat produced no downstream byte. A keepalive must remain valid SSE, preserve
  backpressure and translator accounting, and must not look like model content or tool progress.
- Alternatives considered: Drop typed heartbeats; emit an empty `chat.completion.chunk`; emit an SSE
  comment; add a separate nonstandard Chat event type.
- Chosen approach: Emit one bounded `: opencodex heartbeat` SSE comment for each typed Responses
  heartbeat after ensuring the initial role chunk.
- Why this approach: SSE comments refresh transport-idle timers while every
  compliant event parser discards them. Empty or nonstandard data events can be miscounted as
  semantic output and would widen the Chat wire contract.
- Benefits, drawbacks, and impact: Long silent Chat translations now deliver regular transport bytes without
  changing content, tools, usage, terminal behavior, cancellation, or upstream stall detection. A
  client's separate semantic-progress watchdog may still expire, which is intentional because a
  keepalive proves connection liveness rather than model progress.
