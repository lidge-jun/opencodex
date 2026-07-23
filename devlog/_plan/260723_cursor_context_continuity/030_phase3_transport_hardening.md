# Phase 3 — transport hardening: session errors, idempotent cleanup, discovery retry

Owns RC3 (000_plan.md). Three bounded changes; the committed-turn no-replay
guard (`transport-retry.ts`) is explicitly OUT of scope.

Audit r1 corrections folded in: (5) there is NO existing single-shot terminal
guard — this phase introduces one; (6) discovery retry scope narrowed to
pre-response transport failures with a total-deadline cap; (7) test seams are
decided here, not at build time; (8) real discovery caller is
`src/codex/catalog.ts:1538` (reached synchronously from `/v1/models`
`src/server/index.ts:251` and `/api/models` `src/server/management-api.ts:799`),
not `discovery.ts`.

## 3-pre. Single-shot terminal guard (audit r1 blocker 5, r2 blocker 4 — foundation for 3a/3b)

`open()` currently has NO settled guard: `failAndClear` calls `fail` directly
(`live-transport.ts:621`), stream `end` calls `finish` independently (`:707`),
and the runTurn generator merely reads whichever of `failure`/`done` lands
first. Adding a session error listener without a guard risks double-terminal
mutation (end + late session error, timeout + session error).

### MODIFY `src/adapters/cursor/live-transport.ts` — extracted, unit-testable settler

Audit r2 blocker 4: tests cannot reach `open()`'s private `fail`/`finish`
callbacks (created inside `run()` at `:475`, passed at `:583`) through the
public transport API, so the settler is EXTRACTED and exported from this file:

```ts
/** Single-shot terminal settlement for one Cursor turn: whichever of fail/finish
 * wins first owns the terminal; later calls only run clearTimer-safe no-ops. */
export function createTerminalSettler(hooks: {
  fail: (error: Error) => void;
  finish: () => void;
  clearTimer: () => void;
}): { settleFail: (error: Error) => void; settleFinish: () => void; settled: () => boolean } {
  let settled = false;
  return {
    settleFail(error) {
      if (settled) return;
      settled = true;
      hooks.clearTimer();
      hooks.fail(error);
    },
    settleFinish() {
      if (settled) return;
      settled = true;
      hooks.clearTimer();
      hooks.finish();
    },
    settled: () => settled,
  };
}
```

`open()` instantiates it once per turn:
`const settler = createTerminalSettler({ fail, finish, clearTimer: () => this.clearFirstFrameTimer() });`
EVERY terminal path in `open()` routes through it: `failAndClear`'s
final `fail(error)` → `settleFail(error)`; its expectedClose `finish()` →
`settleFinish()`; first-frame timeout `fail(...)` → `settleFail(...)`; stream
`end` handler's `finish()` (`:707` region) → `settleFinish()`; the new session
error handler (3a) → `failAndClear`. Diagnostics (`debugProviderDiagnostic`)
stay outside the guard so late events still log.

Similarly the destroy fallback (3b) is extracted as an exported helper so its
behavior is unit-testable with fakes:

```ts
/** Arm the post-close destroy fallback for a timed-out turn. Returns the timer. */
export function armTimeoutDestroyFallback(
  stream: { destroyed: boolean; destroy: () => void },
  session: { destroyed: boolean; destroy: () => void },
  graceMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    try { if (!stream.destroyed) stream.destroy(); } catch { /* gone */ }
    try { if (!session.destroyed) session.destroy(); } catch { /* gone */ }
  }, graceMs);
  timer.unref?.();
  return timer;
}
```

## 3a. Session-level error listener (live turn transport)

### MODIFY `src/adapters/cursor/live-transport.ts`

Register after `failAndClear` is declared (`:621+`; registration order vs.
first turn bytes is irrelevant — the whole function body runs synchronously):

```ts
    this.session.on("error", err => {
      const realErr = err instanceof Error ? err : new Error(String(err));
      debugProviderDiagnostic("cursor", "session-error", {
        code: String((realErr as { code?: unknown }).code ?? ""),
        message: redactCursorForLog(realErr.message),
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      failAndClear(realErr);
    });
```

Idempotence comes from 3-pre's `settleFail`/`settleFinish` — a session error
after stream end (or alongside a stream error) logs but cannot emit a second
terminal callback.

## 3b. Forceful idempotent first-frame-timeout cleanup

### MODIFY `src/adapters/cursor/live-transport.ts` (first-frame timer, `:639-646`)

Named constant + injectable grace (audit r1 blocker 7):

```ts
const CURSOR_TIMEOUT_DESTROY_GRACE_MS = 1_000;
```

`CursorTransportFactoryInput` (`src/adapters/cursor/transport.ts:16`) gains
optional `timeoutDestroyGraceMs?: number` (plumbed like the existing
`firstFrameTimeoutMs`), so tests can shrink the grace deterministically.

Before:
```ts
      try { stream.close(); } catch { /* already closing */ }
      try { session.close(); } catch { /* already closing */ }
```
After:
```ts
      try { stream.close(); } catch { /* already closing */ }
      try { session.close(); } catch { /* already closing */ }
      // close() waits for in-flight frames; a dead socket can ignore it. Destroy
      // shortly after so a stalled TLS session cannot linger past the timeout.
      armTimeoutDestroyFallback(stream, session, this.input.timeoutDestroyGraceMs ?? CURSOR_TIMEOUT_DESTROY_GRACE_MS);
```

The timeout's `fail(...)` becomes `settleFail(...)` (3-pre), so a session error
fired by the destroy cannot double-report.

## 3c. Bounded discovery retry with a fresh session

### MODIFY `src/adapters/cursor/live-models.ts`

Audit r1 blocker 6: completed non-2xx responses are currently classified
`"http"` too (`live-models.ts:88-92`), so "retry every http" would retry
deterministic 404/503 bodies and contradict pre-response-only intent. Split the
category first:

```ts
export type CursorUsableModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "auth" | "http" | "transport" | "timeout" | "decode" | "empty"; detail?: string };
```

- `transport` = session error, request setup failure, request stream error,
  connection setup failure (pre-response).
- `http` = a COMPLETED response with non-2xx status (deterministic; not retried).
- Callers only branch on `ok`/log `error` as text (`src/codex/catalog.ts:1538`
  region — verify at B; the union widening is backward-compatible for logging).

```ts
const RETRYABLE_DISCOVERY_ERRORS = new Set(["timeout", "transport"]);
const DISCOVERY_RETRY_TIMEOUT_MS = 3_000; // second attempt is capped: total worst case ~11.3s

export async function fetchCursorUsableModels(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  const first = await fetchCursorUsableModelsOnce(opts);
  if (first.ok || !RETRYABLE_DISCOVERY_ERRORS.has(first.error)) return first;
  // One bounded retry with a brand-new HTTP/2 session: transient dial/TLS/timeout
  // failures are common on wake; auth/decode/empty/completed-http are deterministic.
  await new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 250)));
  return fetchCursorUsableModelsOnce({ ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 8000, DISCOVERY_RETRY_TIMEOUT_MS) });
}
```

`fetchCursorUsableModelsOnce` = current function body renamed (each call already
creates its own `http2.connect` session — no pooling added).

Latency budget (explicit acceptance): worst case = 8000 (first) + ~500 jitter +
3000 (capped retry) ≈ 11.5s on a cache-miss `/v1/models` / `/api/models` poll.

### MODIFY `src/codex/catalog.ts` — failure cooldown (audit r2 blocker 5)

The Cursor branch (`catalog.ts:1536` region) bypasses the existing failure
cooldown: on discovery failure it returns stale/static WITHOUT calling
`markModelsFetchFailure` (machinery: `src/codex/model-cache.ts:22`), so during
an outage EVERY poll would pay the ~11.5s worst case. Add the same
`markModelsFetchFailure(...)` call the generic provider path uses on Cursor
discovery failure, so repeated polls inside the cooldown window skip discovery
entirely. Activation scenario: test drives two consecutive catalog refreshes
with a failing discovery stub and asserts the second does NOT invoke discovery
(cooldown hit).

## Accept criteria + activation scenarios (C-ACTIVATION-GROUNDING-01)

1. Settler unit tests (direct, via exported `createTerminalSettler`): fail-then-fail,
   fail-then-finish, finish-then-fail, finish-then-finish → exactly one hook fires;
   `clearTimer` called exactly once.
2. Destroy-fallback unit tests (exported `armTimeoutDestroyFallback` + fake
   stream/session objects + short grace): destroy called on both when
   `destroyed=false`; skipped when already destroyed.
3. Integration smoke (real local h2 server): session-level GOAWAY/destroy →
   turn ends with exactly one thrown transport error (observed via the public
   `runTurn` async-generator contract, not private callbacks).
4. Discovery: first attempt `timeout`/`transport` → second attempt runs with a
   NEW session and its success is returned (server observed 2 requests); first
   attempt `auth` (401) or completed 404 (`http`) → NO retry (1 request).
5. Catalog cooldown: second refresh during cooldown does not invoke discovery.

## Tests

Seam decision (audit r1 blocker 7, r2 blocker 4):

- 3-pre unit + 3b unit: `tests/cursor-hardening.test.ts` imports the exported
  `createTerminalSettler` / `armTimeoutDestroyFallback` helpers directly with
  fakes (deterministic; no private-callback counting).
- 3a integration smoke: same file's real local `http2.createServer()` (`:16-21`)
  with a session-destroying behavior, asserting the public `runTurn` surface
  yields exactly one terminal error.
- 3c in `tests/cursor-hardening.test.ts` against the same local server:
  first hit times out (server stalls), second responds 200 with a valid
  protobuf body → assert `{ok:true}` and server saw 2 requests; 401 case →
  1 request. `tests/cursor-live-transport.test.ts` is NOT extended (it has no
  http2 seam — MCP-manager-only injection, `:30`).
- Cooldown test: wherever catalog refresh tests live (rg at B for the existing
  cursor catalog test file, e.g. `tests/`-level catalog suites) with a failing
  discovery stub.

## Verification

```
bun run typecheck
bun test tests/cursor-hardening.test.ts tests/cursor-live-transport.test.ts
bun run test   # full suite before D
```
