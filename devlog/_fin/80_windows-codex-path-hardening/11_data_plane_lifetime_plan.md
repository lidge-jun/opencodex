# 80.11 — Data-Plane Lifetime Hardening Plan

## Problem

Windows users report frequent interruption while using the proxy. A likely class is not process death but long-lived response transport being closed:

- `/v1/responses` SSE can have quiet gaps while upstream models reason or tools run.
- Codex WebSocket mode can also sit idle between frames.
- `src/server.ts` currently sets Bun `idleTimeout: 255` globally and does not explicitly disable per-request timeout for long-lived response turns.
- WebSocket idle policy is not explicit in the current server config.

macOS may appear stable because the observed workload/runtime combination does not hit the same Bun/Windows timer or stream behavior.

## Patch intent

Make long-lived Codex data-plane connections explicit, not incidental.

### Scope

- `src/server.ts`
- `tests/server-auth.test.ts` or a new focused server lifetime test file
- potentially `src/ws-bridge.ts` if WebSocket keepalive/heartbeat needs centralization

### Design options to inspect before editing

1. Bun per-request timeout escape hatch
   - For `/v1/responses` POST requests, call the equivalent of `server.timeout(req, 0)` before upstream waits or stream relay.
   - This may require changing the fetch handler from shorthand async fetch to a form that can access the server instance, or wrapping the server reference safely.

2. WebSocket idle policy
   - Set explicit `websocket.idleTimeout` or equivalent supported Bun option.
   - Decide whether to disable idle entirely or use a conservative high value.
   - If disabling is risky, add protocol-level heartbeat/keepalive for quiet turns.

3. Existing heartbeat behavior
   - There are already SSE heartbeat tests in passthrough/bridge code.
   - Confirm whether those heartbeats happen before the Bun idle timeout and whether they cover all response paths.

## Tests

Add tests that would fail before the patch:

1. Static/server-config test
   - Assert WebSocket idle policy is explicitly configured.
   - Assert long-lived `/v1/responses` path invokes the timeout override helper.

2. Slow SSE integration test
   - Use a deliberately delayed upstream SSE chunk longer than a small test timeout.
   - Expected: client still receives the later chunk and terminal event.
   - Keep the test deterministic and fast by injecting small timeout values if the server supports that.

3. Regression guard
   - Existing tests must still pass:
     - `tests/ws-endpoint.test.ts`
     - `tests/passthrough-abort.test.ts`
     - `tests/bridge-lifecycle.test.ts`
     - `tests/server-auth.test.ts`

## Acceptance criteria

- Long-lived `/v1/responses` requests are not subject to accidental Bun idle close.
- WebSocket idle behavior is explicit and documented in code.
- Tests prove the intended policy at least statically, and preferably with a slow-stream integration test.
- No change to provider adapter semantics.
