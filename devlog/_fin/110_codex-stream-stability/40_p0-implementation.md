# 110.40 — P0 Implementation: Stream Lifecycle Fixes

Implements the P0 items from `30_patch-direction.md`. P1a (heartbeat) and P2 are deferred
with rationale below. Scope kept to changes verifiable without a live Codex session.

## What shipped

### P0a — RC1: guaranteed terminal `response.completed` (`src/bridge.ts`)

Commit `1528114`. `bridgeToResponsesSSE` now tracks a `terminated` flag set on the
`done`/`error`/`catch` terminals. If the adapter generator returns **without** a terminal
event (e.g. `anthropic.ts` reaching EOF after `message_stop`, `:274-276`), the bridge closes
any open items and synthesizes a `response.completed` before `emitDone()`/`close()`. This
removes the path to the Codex parser's `"stream closed before response.completed"` →
`ApiError::Stream` (`responses.rs:457-460`).

Enforced at the **bridge** (not per-adapter) because the invariant is "the bridge always
emits exactly one terminal Responses event," independent of any adapter's quirks
(`10_root-cause-analysis.md` §2). All bridge callers inherit it, including
`web-search/loop.ts:186`.

### P0b — RC2: no-throw emit + upstream abort on disconnect (`src/bridge.ts`, `src/server.ts`)

Commits `1528114` (bridge) + `e2ae0b8` (server).

- `emit`/`emitDone` are now wrapped: a `closed` flag short-circuits and a `try/catch` swallows
  enqueue-after-teardown, killing the double-throw that previously fired inside `start()` when
  the client vanished mid-stream.
- The bridge `ReadableStream` gained a `cancel()` that sets `closed` and calls an `onCancel`
  hook.
- `handleResponses` (`server.ts`) creates an `AbortController`, passes `signal` to the routed
  upstream `fetch`, and passes `() => upstream.abort()` as the bridge's `onCancel`. A client
  disconnect now aborts the upstream instead of leaking the connection / draining tokens.

### P0c — RC2 (passthrough path): abort the upstream on client disconnect

Commit `955f3dd`. The passthrough branch now passes `signal` to the upstream fetch and relays
the body through `relayWithAbort` (`src/server.ts`), whose `cancel()` calls `upstream.abort()`.
A directly-relayed body does not propagate the consumer's cancel to a signalled fetch (verified
with a `Bun.serve` probe and `tests/passthrough-abort.test.ts`), so this closes the passthrough
half of RC2 with byte-verbatim fidelity preserved.

### RC3 — idle keep-alive (`src/bridge.ts`) [patch-direction §P1a]

Commit `61dcec2`. During upstream silence the bridge emits a real, parser-ignored
`response.heartbeat` (~2 s interval, fired only when no real event occurred since the last tick),
re-arming Codex's `timeout(idle_timeout, stream.next())` so a stalled routed provider never trips
"idle timeout waiting for SSE". Unknown event types are codex's documented forward-compat path
(`responses.rs:426-431`, `_ => Ok(None)`) with zero side-effects; the 2 s interval is under the 5 s
provider floor, so the user's exact `idle_timeout` is not required. Cleared on every terminal path,
close, and cancel. Native passthrough is unaffected. Unit-tested (`tests/bridge-lifecycle.test.ts`).

## RC status after P0

| ID | Cause | Status |
|----|-------|--------|
| RC1 | Missing terminal `response.completed` (bridge) | **Fixed** (`1528114`) + unit-tested |
| RC2 | Double-throw on disconnect | **Fixed** (`1528114`) |
| RC2 | Upstream not aborted on disconnect (both paths) | **Fixed** — bridge (`e2ae0b8`), passthrough `relayWithAbort` (`955f3dd`, Bun.serve-probe verified) |
| RC3 | No idle keep-alive (idle-timeout aborts) | **Fixed** (`61dcec2`) — parser-ignored `response.heartbeat` during silence, unit-tested |
| RC4 | Bridge error envelope | Fixed in 100.5 (`a0d4ec9`); `rate_limit_exceeded` note stands |
| RC5 | Passthrough header fidelity | Mitigated in 100.5; regression already covered by `tests/error-fidelity.test.ts` |

## Verification

- New `tests/bridge-lifecycle.test.ts` (4 tests): terminal guarantee for a no-`done` stream,
  single `response.completed` on normal `done` (no double terminal), `response.failed` with no
  synthetic completed on `error`, and `cancel()` firing the `onCancel`/abort hook.
- `bun test` → **30 pass / 0 fail** (was 26; +4). `bun x tsc --noEmit` clean.

## Deferred (and why)

- **P2** (rate-limit code mapping, dropped-frame logging) — opportunistic only; current behavior
  is acceptable. The streaming path is deliberately quiet (no `console.*` in any adapter/bridge),
  so dropped-frame logging needs a logging-convention decision and risks spam on benign non-JSON
  frames; rate_limit → `Retryable` is already correct. Not shipped.

(RC3 idle keep-alive was initially deferred here, then implemented in `61dcec2` after an
independent review retired the deferral rationale — see the RC3 subsection above and
`30_patch-direction.md` §P1a.)

## Remaining acceptance gate

The symptom is only fully reproducible with a live Codex CLI pointed at `ocx` using a routed
model over a multi-turn session that includes interrupts. Unit + regression tests prove the
mechanism-level fixes; the end-to-end confirmation (no `ApiError::Stream`, no leaked upstream
connections) is owed in the user's environment.
