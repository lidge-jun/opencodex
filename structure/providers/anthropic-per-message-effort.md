# Anthropic per-message effort

An experimental, default-off provider option keeps Anthropic's prompt cache across a mid-conversation
reasoning effort change (#6895). Anthropic invalidates every cached message block when a request
changes the top-level `output_config.effort`; its per-message effort beta
(`mid-conversation-output-config-2026-07-01`) instead takes an effort-only system message,
`{role: "system", content: [], output_config: {effort}}`, that applies from the next user turn and
leaves the cached prefix intact.

## Switch and scope

`providers.<name>.perMessageEffort: true` (`src/types/provider.ts`, validated in
`src/config/schema/leaf-validators.ts`, carried over a dashboard save by
`src/server/management/provider-overwrite-carry.ts`) turns it on. Unset or `false` leaves every
request byte-for-byte unchanged and touches no state. With it on, only a streamed Codex Responses
turn on the `anthropic` adapter, API-key authentication, destination `api.anthropic.com`, and a
model matching Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5 or Mythos 5.1 is ever considered. OAuth
accounts, gateways, Claude Messages and Chat Completions ingress, `previous_response_id`, the Advisor
guard, routed compaction and memory-model phases stay off. A turn that a hosted web-search, image or
video sidecar loop owns is served on its first model call: `src/server/responses/sidecar-execution.ts`
shares one turn record across the loop's spread copies before the first build and settles it from
the loop's completion, and an iteration after the first abandons the decision, so a turn that runs a
hosted tool ends the history.
Fable models stay off until their wire ids are checked against the Mythos rule, and any effort
change on Mythos is off because its thinking budget follows effort.

## Decision owner

`src/responses/effort-history.ts` owns the state machine: rkb32's contract on #6895, rules 0-9 in
order, with the bounds in its constants (64 entries, 512 KB, one-hour entry expiry, ten-minute
pending expiry, 128 KB committed output, 64 change points). Entries hold HMAC digests and pinned
values under a per-process key, never transcript text; entries and pending slots keep digests of
the chat lineage, the model and destination, and the emitted `thinking` field, never the raw values.
A pending slot's bytes count toward the 512 KB total when it is admitted: the least recently used
histories are evicted until it fits, and an admission that cannot fit beside the other pending
slots is "off" with `bounds-refused` and evicts nothing, not even for the entry-count limit.
A conversation's history is keyed by scope
(cohort from `src/codex/lineage.ts`, provider, destination, adapter, model, a digest of the API
key, auth mode) and the Codex thread or prompt cache key, then by a chained digest of every raw
input item plus the output items the turn returned; the digest treats a `null` field as absent,
because Codex echoes a reasoning item with `content: null` that the proxy never sent. A request matches only when its echoed history
equals a committed prefix exactly; anything else is "off", and an off request that reaches a stored
parent deletes it first, so a chat that goes off stays off.

A history starts only on a first turn that has no assistant, tool, compaction or configuration
items (user and developer items only; a Codex first turn carries its environment context as a second
user message) and whose own Codex turn metadata reports `history_initialization` `"new"` (the
spelling Codex 0.167 sends; `"New"` is accepted too). `src/server/responses/request-prepare.ts`
reads that once into `_codexNewHistory`, which the encrypted agent-task recovery re-parse carries
over: the `x-codex-turn-metadata` header over HTTP, and over
WebSocket only the frame's own `client_metadata` copy, because the upgrade header describes the turn
that opened the socket. A compaction summary, a resume or a restart never starts one. Every compared request value is the one
the serializer emitted: the `thinking` field, `max_tokens`, and a frame digest of every other body
field except `messages`, `stream` and `output_config.effort`. A differing output limit is off in
either direction; no cap is raised to make a turn eligible.

## Wire seam

`src/adapters/anthropic/per-message-effort.ts` maps one build onto the state machine and is called
once from `src/adapters/anthropic.ts` after prompt caching is applied. On a send decision it sets
`output_config.effort` to the first turn's effort, inserts every recorded change point at its
stored `messages` index (highest first, so earlier indices do not move); the indices must name
user messages, rise strictly, and stay before this turn's user message, except this turn's own change point, which sits at it; then it merges the beta into
`anthropic-beta`. A change point's index is the wire message that starts with that turn's user
text, found in the trailing user-role run of the serialized body; a user message merged behind
other content or opening with an image has none, and the turn goes off. The parsed request carries
the turn in `_perMessageEffort` (`src/types/request.ts`); spread copies share it, so any second
build of the same turn (retry, recovery rebuild, failover) abandons the decision and sends today's
body.

`src/server/responses/adapter-delivery.ts` settles the turn from the bridge's completion: a
`completed` response from the `anthropic` adapter commits its `output` items, with the response
usage's `cached_tokens` as the cache read and that read plus `cache_write_tokens` as P; a matched
turn whose cache read is below the parent's P, any other status, a rebuilt turn, or another
adapter deletes the slot. `src/server/responses/adapter-dispatch.ts` deletes the slot on an
upstream error status; the documented 400 "requires a model that supports per-turn effort" also
marks that model and destination unsupported for an hour. Nothing here resends. A hosted sidecar loop that fails does
not reject its turn; the pending slot stays until its ten-minute expiry, and a retry of the same
turn finds it and goes off.

The proxy's own message injections, such as the multi-agent guidance that
`src/server/responses/collaboration.ts` adds at `max` and `ultra` effort, are unchanged and are not
part of the history digest, which covers the client's raw input. When one moves the wire prefix, the
turn reads less cache than its parent wrote, so it does not commit and the history goes off.

## Tests

`tests/responses/responses-effort-history-state.test.ts` and `tests/responses/responses-effort-history-fixtures.test.ts`
carry rkb32's state-machine tests and real-serializer fixtures.
`tests/adapters/anthropic/anthropic-per-message-effort.test.ts` covers the seam through the real
adapter and bridge, and `tests/responses/responses-anthropic-per-message-effort.test.ts` drives two
turns through `handleResponses`.

