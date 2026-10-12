# 020 — the four stages as one contract

The stages are separate pull requests but a single runtime object graph: one
downstream WebSocket turn owns one control channel, that channel owns one
physical upstream socket, and every later control frame is emitted through the
closure that opened it. The five clauses below are what that graph has to
guarantee for the stack to be safe to enable. Each verdict is a source read at
the heads listed in `000_plan.md`.

## C1 — the selected account and the original physical socket are preserved

**Holds by construction.**

`codexWsUpstreamFetch` computes a pool-reuse identity only when no control
channel is present (`const identity = control ? null : codexWsReuseIdentity(...)`),
so an owned connection is never taken from, and never returned to, the idle
socket pool. Control frames are sent through the `ws` captured by
`codexWsExchange`, which is the same physical connection that carried the
original create. A `response.create` continuation is not re-routed: the exchange
rebuilds it from the original `frameText` and overlays only `input` and
`previous_response_id`, so a caller-supplied `previous_response_id` never reaches
the REST sanitizer or the account selector. The per-send guard receives
`new Headers(headers)` — a copy — so it can reserve quota and refuse a send but
cannot swap the credential underneath an open socket.

Both channels also pin the request's non-envelope settings as SHA-256 digests at
construction and reject any continuation whose settings differ. After
`4670525d48` (on #4861, not on #4864) the injection channel also rejects a
continuation that omits a pinned key.

Residual: preservation is the point, so the credential chosen at create time is
the credential the whole chain uses, for as long as the chain lives. See C4 for
how long that can be, and 030 for why that makes #4850 an activation
precondition.

## C2 — an unsupported route does not detour to another account or to HTTP

**Holds, with one seam worth an explicit branch.**

Four independent gates have to agree before a channel is constructed or used:
`nativeResponseControlMode` requires the matching flag to be exactly `true`;
`nativeResponseControlEligible` requires canonical ChatGPT forwarding, or — for
injection only — an `openai-responses` provider pinned to exactly
`https://api.openai.com/v1` with `upstreamWebsocket: true` and a non-forward auth
mode; `preparePassthroughExchange` additionally requires `inboundTransport ===
"websocket"`, no Combo attempt, and no plaintext-v2 agent-message tool rewriting;
`codexWsUpstreamFetch` re-checks `prepared.canonical` (or the exact public API
URL) and, for injection, re-parses the outgoing frame to confirm
`multi_agent.enabled`. A route that fails any of them gets `undefined`, and a
later `response.steer` or `response.inject` is answered with an explicit
`steering_not_supported` / `injection_not_supported` error frame rather than
being discarded or retried elsewhere.

The seam is in `codex-ws-exchange`. `nativeSteering.attach()` is called inside the
same `try` block as `ws.send(frameText)`, and that block's `catch` treats a
pre-activity failure as "the frame never left" and resolves `sseFallback(url,
init)`. For steering that is reachable but harmless, because `attach` only
refuses when the channel is already bound. For injection it is reachable and
consequential: `NativeInjectionChannel.attach` throws permanently once
`everAttached` is set, so a second physical WebSocket attempt for the same turn —
the transient-retry wrapper passes the same channel to every dispatch site —
converts a multi-agent turn into an ordinary HTTP turn while the client still
holds a channel that can never attach. No credential moves and no success is
invented; the client learns only when its first `response.inject` is refused.
An attach failure should be distinguishable from a send failure rather than
sharing the fallback path. Raised on #4858.

## C3 — a steering or injection failure is never presented as success

**Holds.**

Every settle path reports uncertainty instead of inventing an outcome.
`NativeSteeringChannel.expire()` settles once, disposes the replay journal and
calls `onFailure`, which fails the client stream; the message states that
delivery is unknown and that tools and steering input must not be replayed.
`NativeInjectionChannel.fail()` does the same and never falls back to HTTP,
re-sends or re-runs a tool. An acknowledgement must match the sole in-flight
submission by response ID and strictly increasing sequence number, and a
`response.inject.failed` must carry a fingerprint of exactly the submitted
results, so a rejection cannot be attributed to a different batch. Only a
`response_already_completed` rejection is marked recoverable, keyed by a digest
of the saved result rather than a second copy of it. A response terminal does not
finish the owner while submitted results are unacknowledged.

In the replay journals, only a validated `response.created` successor commits
queued input, and only `response.completed` reaches shared continuation state —
a steered or failed parent's output is used solely as a successor's prefix.

One suppression exists and is correct: `createNativeSteeringLogObserver` does not
record a parent's `response.incomplete` with `incomplete_details.reason ===
"steered"` as an upstream failure. That affects the request log only; the frame
itself is still relayed to the client unchanged.

## C4 — cancellation and confirmation waits terminate finitely

**Holds per stage after #4864 — but the chain has no aggregate bound.**

After #4864 every wait is an absolute deadline rather than a re-armable window:
90 s per unacknowledged steer, 90 s for an automatic successor after a parent
terminal, 90 s for a sent continuation, 30 minutes for a server-requested
required-input wait, and `stallTimeoutSec` (default 300 s) of idle while a
response is streaming. The injection channel uses the same 90 s acknowledgement
bound, explicitly non-extendable by unrelated stream activity, plus the same
30-minute saved-result wait. `assertTimely()` closes the race where a late frame
arrives after a deadline passed but before its timer fired.

What is not bounded is their composition. A chain may run up to 128 responses on
one owned connection, and each response may legitimately consume its own idle and
required-input waits, so a single downstream turn can hold one physical socket
and one pinned credential for far longer than any ordinary turn — on the order of
tens of hours in the worst case, without any individual deadline being violated.
Nothing in the stack caps the lifetime of the owned connection itself. That is an
operational number the activation decision needs, not a correctness defect.
Raised on #4864.

Client disconnect and supersession are handled: a new `response.create` clears
`ws.data.nativeSteering` before admission and calls the previous turn's
`cancel()`, and the exchange's `cleanup()` runs `detachSteering`, which drops the
timers, the retained prefix and every queued submission.

## C5 — the default-off boundary the original PR proposed is intact

**Holds.**

`codexNativeSteering` and `codexNativeInjection` are optional booleans in the
config schema, absent by default, and the mode selector requires `=== true`.
Neither channel can be constructed outside the inbound WebSocket create path,
which itself requires the already-opt-in `websockets: true`. Injection requires a
third, client-supplied gate: the create frame must carry
`multi_agent.enabled: true`. No model name, catalog entry or capability flag
turns any of this on, and rollback is unsetting the flag and restarting.

## Summary

| Clause | Verdict | Follow-up |
|---|---|---|
| C1 account and socket identity | Holds | — |
| C2 no unsupported-route detour | Holds, one seam | Comment on #4858 |
| C3 no failure reported as success | Holds | — |
| C4 finite waits | Holds per stage, chain unbounded | Comment on #4864 |
| C5 default-off boundary | Holds | — |
