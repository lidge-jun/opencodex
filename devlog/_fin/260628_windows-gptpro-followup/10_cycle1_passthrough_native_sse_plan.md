# Cycle 1 - P0 passthrough SSE native client body

## Problem
GPT Pro found that the passthrough SSE response still goes through async-pull `ReadableStream` wrappers: `relaySseWithHeartbeat(...)` on the client-facing branch and `responseWithDeferredRequestLog(...)` via `trackSseForRequestLog(...)` after `handleResponses()` returns. That undermines the Bun Windows native relay workaround.

## Plan

### MODIFY src/server.ts
1. Introduce a module-level `WeakSet<Response>` marker for responses whose client-facing body must not be wrapped for request logging.
2. Add helpers:
   - `markNativePassthroughSseResponse(response: Response): Response`
   - `isNativePassthroughSseResponse(response: Response): boolean`
3. In the passthrough SSE branch of `handleResponses()`:
   - keep `upstreamResponse.body.tee()`;
   - return `nativeBody` directly as the Response body;
   - keep terminal/quota inspection on `inspectBody` only;
   - register/unregister active turn around the side-channel inspection lifecycle;
   - mark the returned Response with the native passthrough marker.
4. Update `responseWithDeferredRequestLog(...)`:
   - if the response is marked native passthrough SSE, do not call `trackSseForRequestLog(...)`;
   - if `handleResponses()` registered a terminal outcome recorder, defer request log finalization to that recorder path;
   - otherwise add a non-wrapping final log with the original HTTP status and `closeReason: "non_stream"` equivalent to avoid leaving no log for uninspected native SSE.

### MODIFY tests/passthrough-abort.test.ts
Add a static regression test against `src/server.ts` that verifies the passthrough SSE branch segment:
- does not call `relaySseWithHeartbeat(`;
- returns `new Response(marked/native body...)` with `nativeBody` directly;
- `responseWithDeferredRequestLog` contains a marker bypass before `trackSseForRequestLog`.

## Acceptance criteria
- Client-facing OpenAI/ChatGPT passthrough SSE body no longer goes through async-pull relay wrapper.
- Side-channel terminal inspection still records pool failure terminal outcomes.
- Existing passthrough client cancel behavior remains green or is consciously adjusted with equivalent abort behavior.
- Request logging tests remain green.

## Verification
- `bun test tests/passthrough-abort.test.ts tests/server-auth.test.ts tests/request-log.test.ts`
- `bun x tsc --noEmit`

## Commit
- `fix(windows): keep passthrough sse body native`
