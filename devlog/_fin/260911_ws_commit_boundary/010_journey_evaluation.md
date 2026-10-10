# Journey evaluation — how the framing changed

## What was done before this unit

1. Lane dispatch round: seven file-disjoint lanes from `6d3ad12e3`, each a worktree and a
   Codex thread, merged serially on final-head green CI (#4217 … #4248). One of those lanes landed
   the #4191 failure-stage counters in `codex-ws-wire.ts`: request bytes, sent, frames, control
   frames, relayed events, first-frame and elapsed durations. The counters are content-free by
   construction and only classify; they were never a fallback signal.
2. Structure question from the owner: `codex -> http -> opencodex -> ws -> openai` — is the
   asymmetry itself the bug? Source reading said no: WS is chosen only for streaming POSTs on a
   bounded-relay Bun, the create frame is measured before dialling, and the one reversible point is
   the send. First framing: the reversible window is too narrow and judged by size alone; widen the
   HTTP path below the ceiling and scale the prelude budget by frame size.
3. Semantic review by anthropic/claude-fable-5-1. Three corrections were accepted after source
   confirmation:
   - The no-resend-after-send rule is not a defect. RFC 9110 §9.2.2 forbids an intermediary from
     automatically repeating a non-idempotent request; the user agent owns that decision. Offering
     "allow fallback after send" as an option was the wrong question.
   - The broken contract is the status code. `commitResponse` builds `new Response(stream,
     { status: 200 })` before any upstream frame, and `failStream` commits that 200 on the failure
     path (`if (sent) commitResponse()`) precisely so the pre-stream wrapper cannot resend. The proxy
     therefore converts "no response" into "a response that failed", removes the status the client
     would use for its own retry policy, and neuters the client's first-byte timeout with chunked
     headers. Direct-to-vendor Codex survives the same at-most-once lane through its own retry; the
     proxy is stricter than the party whose money is at stake and pays for it with a hard failure.
   - The 90 s prelude is the wrong kind of quantity: it folds "dead" and "slow" into one number.
     Dead is a liveness question with a native answer (ping/pong); slow already has an owner (the
     client deadline). A fixed proxy deadline in series always inherits the tighter bound.

## What the evaluation keeps and drops

Kept: every existing oracle (no HTTP fallback after send, one `response.create` per exchange,
refused-create 4xx projection, correlation before conversion, bounded queue). Kept: the 90 s
number, but demoted from "time to first response event" to "unanswered silence with no pong",
which is unreachable on a socket whose peer answers pings.

Dropped: post-send HTTP fallback (never acceptable), size-scaled prelude budgets (treats the
symptom), resume-by-id after 1006 (Codex sends `stream: true` without `background: true`; the
vendor resume endpoint requires a background response, so there is nothing to resume for this
client; recorded as a follow-up for callers that do opt in).

## What this unit does not claim

It does not claim the Codex backend answers WebSocket pings; the exchange feature-detects
`ws.ping` and degrades to the previous 90 s behaviour when no pong ever arrives. It does not run
any local suite. Whether the honest 504 improves the #4191 user's experience is a live question
that only a field report can answer; what this unit guarantees is that the proxy stops hiding the
signal that user's client needs.

