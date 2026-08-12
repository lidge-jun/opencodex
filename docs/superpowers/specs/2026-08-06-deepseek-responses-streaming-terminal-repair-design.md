# DeepSeek Responses Streaming Terminal Repair Design

## Goal

Restore progressive Responses streaming for the built-in `deepseek-v4-flash`
route while keeping Codex turns bounded and terminal-complete when an upstream
stream finishes its output items but omits or indefinitely delays the protocol
terminal event.

The fix must remove the current slow-JSON failure mode without weakening
failure honesty: only a fully closed, structurally valid output graph may be
promoted to a synthetic `response.completed` event.

## Context and evidence

The built-in DeepSeek registry currently declares
`modelResponsesUpstreamStreaming["deepseek-v4-flash"] = false`. Final route
normalization therefore changes `stream:true` to `stream:false` before sending
the request to `POST https://api.deepseek.com/responses`. For an HTTP client
that requested streaming, opencodex waits for the complete JSON response and
only then reframes it as SSE.

That compatibility policy was introduced for a historical DeepSeek stream that
could deliver output without closing on a Responses terminal event. It now has
two observable costs:

1. Codex receives no progressive deltas.
2. Non-streaming JSON is guarded by a 30-second body inactivity deadline. Long
   context or high-reasoning turns can cross that boundary and fail with
   `upstream JSON response stalled before completing` even while the upstream
   is still generating a legitimate response.

A live, minimal capture against the official DeepSeek endpoint on 2026-08-06
showed that the current `deepseek-v4-flash` stream emits the complete native
Responses lifecycle:

1. `response.created`
2. reasoning item and reasoning deltas
3. `response.output_item.done` for reasoning
4. function-call argument deltas and `response.function_call_arguments.done`
5. `response.output_item.done` for the function call
6. `response.completed`

The captured function-call turn completed in roughly eight seconds. This
supports restoring upstream streaming while retaining a provider-scoped repair
for regressions in terminal delivery.

## Scope

### In scope

- The official built-in DeepSeek provider when the resolved model is
  `deepseek-v4-flash` and the resolved wire is `openai-responses`.
- HTTP/SSE and Codex WebSocket clients.
- Native reasoning, message, and function-call output items.
- Existing client-facing item-id repair, continuation-state recording, usage
  inspection, cancellation, and failed-tail behavior.
- A five-second post-completion grace window for a missing terminal event.

### Out of scope

- Changing Chat Completions behavior for DeepSeek, Claude Code, or other
  OpenAI-compatible clients.
- Changing the global 30-second bounded-JSON inactivity limit.
- Removing the transport-neutral bounded-JSON capability; other providers may
  still need it.
- Treating silence, partial output, malformed tool calls, or unknown output item
  types as success.
- Retrying a committed upstream generation.
- Adding a user-facing configuration option in this change.

## Options considered

### Remove the non-streaming override only

This restores progressive output with the smallest diff, but a future terminal
regression would again leave Codex waiting after otherwise complete output.

### Repair terminal events in the shared relay for every provider

This covers more gateways but changes global Responses semantics. A heuristic
safe for DeepSeek may be incorrect for another provider, so the blast radius is
not justified.

### Provider-scoped streaming terminal repair

This is the selected design. DeepSeek returns to native streaming, while a
registry-only model capability opts its stream into a narrowly defined repair
state machine. Other providers and custom DeepSeek-compatible endpoints remain
unchanged unless they match the built-in registry transport and model.

## Architecture

### Registry policy

Replace DeepSeek's forced non-streaming entry with a registry-only terminal
repair policy for `deepseek-v4-flash`. The policy carries the five-second grace
duration and is resolved only when `providerMatchesRegistryTransport()` accepts
the built-in provider transport.

The policy is intentionally not persisted into user configuration. It is a
compatibility fact about the official endpoint, analogous to the existing
registry-only wire and streaming hints.

### Terminal repair stream

Add a focused module under `src/server/` that wraps a native Responses SSE body.
It has one responsibility: relay complete SSE blocks while tracking whether a
safe synthetic terminal can be emitted.

The wrapper runs before the body is split for client delivery and background
inspection. Consequently, both branches observe the same real or synthetic
terminal. Existing item-id repair, lifecycle snapshot repair, request logging,
continuation recording, HTTP/SSE delivery, and WebSocket reframing remain
downstream and keep their current ownership.

The wrapper must use existing SSE framing helpers and the per-turn translator
budget. It may retain only the response-created metadata and completed output
items required to construct a terminal response. Retained state is released on
every terminal, EOF, cancellation, error, and disposal path.

### Data flow

```text
DeepSeek Responses SSE
  -> provider-scoped terminal repair
  -> existing payload/block rewrites (item ids, image calls, snapshots)
  -> existing failed-tail and terminal-boundary relay
  -> Codex HTTP/SSE or WebSocket client

The repaired stream is also inspected for:
  -> request outcome and usage metadata
  -> completed-response continuation state
```

## Completion state machine

### Tracked state

- The most recent valid `response.created.response` object.
- The highest valid numeric `sequence_number` seen.
- Every valid `response.output_item.added`, keyed by `output_index`.
- Every valid `response.output_item.done`, keyed by `output_index`.
- Whether a real `response.completed`, `response.failed`, or
  `response.incomplete` event has arrived.
- Whether a real `data: [DONE]` event has arrived.
- One generation token for the active grace timer, preventing a stale timer
  from committing after later activity.

### Candidate-complete predicate

A stream is eligible for synthetic success only when all conditions hold:

1. No real Responses terminal has been observed.
2. A valid `response.created` event with an object-valued response snapshot
   has been observed.
3. At least one `response.output_item.done` has been observed.
4. Every added output index has exactly one corresponding done item.
5. No done item exists for an index whose lifecycle is contradictory or
   tainted by malformed duplicate events.
6. Every retained item has `status: "completed"`.
7. Item types are limited to `reasoning`, `message`, and `function_call`.
8. A function call has a non-empty `name`, non-empty `call_id`, string
   `arguments`, and arguments that parse as JSON.
9. A message contains only completed output content carried by its done item.
10. The retained state remains inside the existing per-turn translator budget.

Any malformed, contradictory, oversized, or unsupported item permanently
taints synthetic success for that stream. A later real upstream terminal stays
authoritative and is still relayed.

### Grace behavior

When the candidate-complete predicate first becomes true, arm a five-second
timer. Any subsequent non-terminal SSE event invalidates that timer generation,
updates the state, and re-evaluates the predicate. If the stream remains a
complete candidate for the entire grace window, emit one synthetic
`response.completed` event and close the repaired source.

The synthetic response is based on the created response metadata, with:

- `status: "completed"`
- `completed_at` set from the injected clock
- `output` set to completed items ordered by `output_index`
- `usage` left unchanged when known and otherwise absent or null
- `sequence_number` set to the next valid sequence number

After emitting the terminal, cancel the upstream reader. The existing
terminal-boundary relay appends exactly one `[DONE]` sentinel when necessary.

### EOF and `[DONE]`

- If EOF or `[DONE]` arrives with a complete candidate and no real terminal,
  emit the synthetic completed terminal immediately before closing.
- If EOF or `[DONE]` arrives without a complete candidate, emit
  `response.incomplete`, never `response.completed`.
- A mid-stream read error remains owned by the existing failed-tail relay and
  becomes `response.failed`.

### Terminal races

A real terminal event always wins over the grace timer. Terminal commitment is
guarded by a single boolean transition, and both the timer callback and stream
reader re-check it immediately before enqueueing. Late events after terminal
commitment are dropped, and the upstream reader is cancelled.

## Error and cancellation behavior

- A client cancellation follows the existing client-gone and bounded drain
  behavior. It never triggers synthetic success.
- A server shutdown abort suppresses synthetic terminal generation.
- A translator-budget overflow fails through the existing typed failure path;
  retained repair state is released.
- A malformed SSE block is relayed according to existing passthrough behavior
  but taints synthetic success when it affects lifecycle state.
- A real upstream `response.failed` or `response.incomplete` is byte-preserved
  apart from already configured downstream rewrites.
- The repair never resends a request after output has been committed.

## Integration details

The implementation is expected to touch these responsibility boundaries:

- `src/providers/registry.ts`: registry-only DeepSeek terminal-repair policy;
  remove the official model's forced bounded-JSON streaming override.
- `src/server/responses-terminal-repair.ts`: bounded state machine and stream
  wrapper.
- `src/server/responses/core.ts`: resolve the provider policy and wrap the SSE
  body before transport-specific relay branches.
- `tests/responses-terminal-repair.test.ts`: unit state-machine coverage.
- `tests/deepseek-inbound-wire.test.ts`: end-to-end wire, progressive delivery,
  repair composition, and WebSocket/HTTP activation.
- Existing relay and item-id tests only where an explicit integration contract
  needs to be pinned.
- `structure/04_transports-and-sidecars.md`: replace the bounded-JSON-only
  DeepSeek description with the streaming plus provider-scoped repair policy.

No unrelated refactor of `core.ts`, the shared relays, or provider configuration
is part of this change.

## Test design

### Unit activation

1. A healthy captured-shape stream containing reasoning, a function call, and a
   real `response.completed` is relayed without a synthetic terminal.
2. A complete reasoning plus function-call sequence that goes silent produces
   one synthetic `response.completed` after the injected five-second deadline.
3. A new item during the grace window invalidates the old timer and restarts the
   deadline only after the new item completes.
4. A clean EOF and a `[DONE]` event synthesize success immediately only for a
   complete candidate.
5. Open items, invalid function arguments, unknown item types, contradictory
   indices, malformed lifecycle frames, and budget overflow never synthesize
   success.
6. Real completed, failed, and incomplete terminals beat the timer and remain
   singular.
7. Client cancellation, upstream reset, and shutdown abort preserve their
   existing accounting and terminal behavior.
8. Fragmented UTF-8 and SSE block boundaries produce the same state as a
   single-chunk stream.

Tests use an injected clock/timer seam rather than wall-clock sleeps.

### Integration activation

1. A Codex Responses request sends `stream:true` to the official DeepSeek
   `/responses` endpoint.
2. The first reasoning or output delta is observable before the upstream emits
   its terminal event.
3. A terminal-less, complete function-call fixture closes within the injected
   grace deadline and preserves `call_id`, `name`, and `arguments`.
4. HTTP/SSE and WebSocket clients receive equivalent item and terminal
   lifecycles.
5. UUID message and reasoning ids remain normalized consistently in added,
   delta, done, and synthetic terminal payloads.
6. Chat and Anthropic inbound requests continue to use
   `/chat/completions` with no terminal repair activation.

### Verification gates

- Focused terminal-repair, DeepSeek wire, relay, WebSocket, item-id, reasoning
  replay, and continuation-state tests.
- `bun run typecheck`
- `bun run test`
- `bun run privacy:scan`
- `bun run prepush`
- One minimal live official-DeepSeek streaming smoke test, with no private
  prompt content and no credential output.

## Rollout and compatibility

The change is provider- and model-scoped. Official DeepSeek Responses clients
gain progressive streaming; Chat and Anthropic clients are unchanged. Custom
providers that happen to use the name `deepseek` but do not match the registry
transport do not inherit the repair.

The bounded-JSON machinery remains available as a rollback path. If live or CI
evidence reveals an unsafe terminal synthesis condition, the registry can
restore `modelResponsesUpstreamStreaming: false` without changing shared relay
behavior.

## Acceptance criteria

- Official `deepseek-v4-flash` Responses requests remain `stream:true`
  upstream.
- Codex receives progressive reasoning, text, and function-call deltas.
- Normal live streams preserve the upstream terminal without duplication.
- A fully complete terminal-less output graph closes after five seconds with
  exactly one synthetic `response.completed` and one `[DONE]`.
- Partial, malformed, tainted, or unsupported output never becomes synthetic
  success.
- Function calls remain executable and continuation state retains completed
  reasoning and output items.
- HTTP/SSE and WebSocket behavior agree.
- Existing providers and DeepSeek Chat Completions behavior remain unchanged.
- Focused and full repository verification gates pass.
