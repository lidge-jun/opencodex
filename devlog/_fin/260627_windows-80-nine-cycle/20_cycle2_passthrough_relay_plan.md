# 260627 Cycle 2 — Passthrough Relay Wrapper Guard Plan

## Purpose

Remove the extra `trackStreamLifetime(...)` wrapper from native ChatGPT/OpenAI Responses passthrough SSE. The current code comments intend native/low-overhead relay for Windows, but the passthrough branch still wraps the native tee branch with `trackStreamLifetime`, which is another async-pull stream.

## Planned Diff

### MODIFY `src/server.ts`

Extend `relaySseWithHeartbeat(...)` with an optional lifecycle argument:

```ts
options?: { onStart?: () => void; onDone?: () => void }
```

Call `options?.onStart?.()` from `start()` and call `options?.onDone?.()` from the existing cleanup path exactly once.

Change the passthrough SSE branch from:

```ts
const trackedNative = trackStreamLifetime(nativeBody, turnAc);
return new Response(trackedNative, ...)
```

to:

```ts
registerTurn(turnAc);
const nativeRelay = relaySseWithHeartbeat(nativeBody, upstream, 15_000, terminalRecorder, {
  onDone: () => unregisterTurn(turnAc),
});
return new Response(nativeRelay, ...)
```

The final shape may use `onStart` instead of pre-registering if cleaner, but it must avoid `trackStreamLifetime(nativeBody, ...)` in the passthrough SSE branch.

### MODIFY `tests/passthrough-abort.test.ts`

Add a test that `relaySseWithHeartbeat` lifecycle callbacks:

- call `onStart` once when read begins;
- call `onDone` once on normal EOF;
- call `onDone` once on cancel;
- still abort upstream on cancel.

### MODIFY `tests/shutdown-drain.test.ts` if needed

Only if active turn tracking requires a direct regression test for passthrough relay integration.

## Verification

```bash
bun test tests/passthrough-abort.test.ts tests/shutdown-drain.test.ts tests/server-auth.test.ts
bun x tsc --noEmit
```

## Acceptance Criteria

- `trackStreamLifetime(nativeBody, ...)` is no longer used in the passthrough SSE branch.
- Passthrough SSE still aborts upstream on client cancel.
- Active turn tracking can still drain/cancel long passthrough SSE requests.
- Focused tests and typecheck pass.
