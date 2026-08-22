# 120 — Small hardening pair: OAuth poll fail-fast (T07) + H2 pool shutdown

Two independent, low-risk fixes small enough to share one cycle; neither
depends on 110.

## 120a — OAuth poll fail-fast on terminal statuses (T07)

### Current state (verified 525568652)

`src/oauth/cursor.ts:108-149` `pollCursorAuth`: 404 = pending, 200 = done,
EVERY other status throws into the generic catch and retries until
3 consecutive errors. A denied/expired login (400/401/403/410) costs three
extra round-trips and surfaces as "Too many consecutive errors" instead of
the real reason. senpi oauth/cursor.ts L165-178 (PR #905) fails immediately
on 400/401/403/410.

### Diff shape

- `src/oauth/cursor.ts`: inside the status dispatch, add
  `if ([400, 401, 403, 410].includes(response.status)) throw new CursorAuthTerminalError(...)`
  where the error carries the status and is NOT retried by the catch block
  (rethrow when `err instanceof CursorAuthTerminalError`).
- Keep 5xx/network on the existing 3-strike retry path (OpenCodex keeps its
  refresh retry / JWT accountId handling — 090 T07 note).
- Tests: extend `tests/cursor-oauth.test.ts` — 401 fails on FIRST attempt
  with status in message; 500 still retries 3x; 404→200 still succeeds.

## 120b — cursorH2Pool shutdown registration

### Current state

`cursorH2Pool.shutdown()` (`src/adapters/cursor/h2-pool.ts:41`) has no
caller. The core-owned seam exists: `src/lib/optional-shutdown-hooks.ts:32`
registry, invoked by `src/server/lifecycle.ts:454`. Lab registers teardown
at activation (orchestrator.ts:109). The seam's hook contract must be
checked: if it is sync-only, register `() => { void cursorH2Pool.shutdown(); }`
or extend the seam if it already awaits promises (verify before coding).

### Diff shape

- Registration at the point the pool first activates — lazily inside
  `h2-pool.ts` on first `request()` (keeps core free of adapter imports,
  matching the optional-subsystem doctrine) via
  `registerOptionalShutdownHook("cursor-h2-pool", ...)`.
- Also correct the pool doc comment: it claims "GetUsableModels / Run
  requests" reuse, but the Run path dials its own session
  (live-transport.ts:928); comment must say discovery-only until Run-path
  integration is a separate, deliberate cycle (deferred — see 190).
- Tests: `tests/cursor-h2-pool.test.ts` (or extend existing) — after
  registration, invoking the registered hook closes sessions (pool.size 0)
  and is idempotent.
