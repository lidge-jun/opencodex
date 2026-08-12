# Phase 3 — macOS bounded single-reader relay

## Decision

Enable the existing bounded eager relay for **Darwin and win32 only** when the
client does not require a payload rewrite.  `streamMode: "auto"` remains tee on
Bun 1.3.14; macOS can use the relay now only through the existing explicit
`streamMode: "eager-relay"` operator opt-in.  That is deliberate, and the precise
upstream status matters: Bun#32111 is **closed**, having been fixed by merged
PR #32120 (2026-06-21) — but that fix ships in **no stable release**, and the
bundled runtime is v1.3.14 (2026-05-13).  So the crash is fixed upstream and still
live for us, and it reproduces on Darwin arm64, not only win32.  A process crash
is worse than the measured memory growth, so `auto` stays on tee.  Once a released
Bun version is independently verified to contain #32120, setting
`MIN_FIXED_BUN_VERSION` makes `auto` select this path on both supported platforms —
that is the single trigger that retires this gate.

This does not claim to solve all macOS retention.  The isolated HTTP experiment
reduced peak `external` from 363–461 MiB to 10–22 MiB, while retained RSS still
measured 1.65–2.04 GiB without `tee()` (`000_plan.md:54-63`).  This phase removes
the proven tee amplifier; Phase 4 owns the allocator/HTTP residual.

## Verified starting point

- `src/server/responses/core.ts:1624-1628` computes `needsClientRewrite`, then
  permits `decideEagerRelay()` only through the `winNoClientRewrite` gate.  Thus
  Darwin cannot select eager relay today.
- `src/server/responses/core.ts:1654-1677` gives eager relay the same terminal,
  request-log, continuation-capture, and first-output hooks used by the tee
  inspector.  There is no inspection-only reason to retain tee.
- `src/server/responses/core.ts:1686` is the only `tee()` under `src/`.
- `src/server/responses/core.ts:1740-1751` applies image aliases and item-ID
  repair only on the tee client branch, then supplies the failed tail except for
  native win32 passthrough.  Eager cannot presently preserve either behavior.
- `src/server/relay-eager.ts:53` bounds the client queue at 8 MiB; its
  post-cancel drain is bounded at `:54-55` and exercised from `:131-138`.
- `src/server/relay-eager.ts:154-160` records an eager mid-stream failure but
  invokes `controller.error()` instead of emitting the client-visible terminal
  that `src/server/relay.ts:43-82` emits.
- `src/lib/bun-stream-caps.ts:1-14` documents why `MIN_FIXED_BUN_VERSION` is
  `null`: no released Bun is proven fixed, and a prerelease is never trusted.
  This applies to Darwin as well as Windows.
- Forward-auth creates an empty image alias map (`core.ts:1415-1417`).
  Item-ID repair is optional provider configuration (`src/config.ts:441-445`),
  and no built-in registry assignment was found.  The fallback therefore covers
  exceptional, configured traffic rather than the standard forward path.

## Shape and safety boundary

### Cancellation semantics: an intentional #44 correction, not parity

Audit blocker 3 surfaced a real behavioral divergence, and the resolution is to
ACCEPT it deliberately rather than paper over it.

Today the tee path cancels hard: `relay.ts:84-87` aborts `upstream` on client
cancel, which propagates through `core.ts:2573-2581` to `turnAc` and cancels the
inspection reader at `relay.ts:537-554`. A terminal that becomes observable just
after the client disconnects is therefore DROPPED and the turn logs as a cancel.

The eager path instead keeps reading inspection-only until a terminal, byte, or
time bound (`relay-eager.ts:130-138`), and reports cancel only when no terminal
was seen (`relay-eager.ts:161-168`).

The #44 comment at `core.ts:1691-1694` states the intended policy directly:

> A real terminal was parsed from the (teed) inspection stream — record it as the
> outcome even if the client has already disconnected: the turn genuinely reached
> that terminal, so it must log as completed/failed, not be dropped or downgraded
> to a cancel.

By that standard the eager behavior is MORE correct than the tee behavior it
replaces. We adopt it knowingly: eager mode will record terminals the tee path
drops. This is a deliberate, opt-in-scoped accounting change and must be called
that in the release note — not described as parity.

Required endpoint tests (all three; the third is the activation control):

1. **Eager, terminal after cancel.** Upstream sends one delta, waits for the
   client reader to cancel, then emits `response.completed`. Assert: the client
   cancelled; the terminal lands inside the drain window;
   `onNativePassthroughTerminal === ["completed"]`; `onNativePassthroughCancel`
   was NOT called; continuation state was recorded; active turn count is back to 0.
2. **Legacy tee characterization, same ordering.** Assert the opposite:
   `onNativePassthroughCancel` fires, and no post-cancel terminal or continuation
   is recorded. This pins the behavior we are knowingly changing.
3. **No-terminal control.** After cancellation, hold the upstream open past the
   drain byte/time bound. Assert: cancel is invoked exactly once, no synthetic
   terminal is emitted, the turn is unregistered, and upstream reads stop. This
   proves the drain bound itself fires rather than running unbounded.

`decideEagerRelayForPlatform` is the single policy owner.  It does not weaken
`decideEagerRelay`: the latter still treats `auto` as unsafe until an explicit,
released minimum is set, and treats a prerelease as unsafe even when its number
is high enough.  `eager-relay` remains a documented *force* mode, now for Darwin
as well as win32.  It must be set only by an operator who accepts the Bun#32111
risk and has a fast rollback path (`ocx system settings --stream-mode legacy-tee`).

Do not add a `macos-eager-relay` fourth mode.  It would duplicate the same
explicit-risk contract under another persisted spelling, fragment diagnostics,
and still cannot make Bun 1.3.14 safe.  Do not make Darwin eager by default:
that would turn a known crash risk into an unattended service default.

### `src/lib/bun-stream-caps.ts`

Keep `StreamMode` and `decideEagerRelay` intact.  Change the top doc comment
from “Windows SSE passthrough path” to “supported native SSE passthrough paths”,
and append this full new policy function after `decideEagerRelay`:

```ts
/**
 * Decide whether this platform is allowed to use the bounded JS producer.
 *
 * Both win32 and darwin need the same Bun#32111 guard: the crash reproduces on
 * Darwin arm64 too.  Other platforms retain their established tee shape until
 * they have their own measured rollout; this function intentionally does not
 * turn a capability predicate into a broad platform experiment.
 */
export function decideEagerRelayForPlatform(
  platform: string,
  mode: StreamMode,
  version: string = Bun.version,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): EagerRelayDecision | null {
  if (platform !== "win32" && platform !== "darwin") return null;
  return decideEagerRelay(mode, version, minFixed);
}
```

The function is intentionally string-typed: `process.platform` is the only
input and this avoids introducing a Node runtime API or a wider Node type
dependency into Bun-native runtime code.

### `src/server/responses/core.ts`

Change the import at `core.ts:136`:

```diff
-import { decideEagerRelay } from "../../lib/bun-stream-caps";
+import { decideEagerRelayForPlatform } from "../../lib/bun-stream-caps";
```

Replace the complete decision section at `core.ts:1613-1684` as follows (the
existing inspector callback body is retained byte-for-byte except for its
surrounding gate and comment):

```ts
    // The bounded eager producer replaces tee()+background inspection on the
    // two platforms covered by the Bun#32111 policy.  `auto` is deliberately
    // legacy until a released Bun has the async-pull cancellation fix; an
    // operator may select the existing explicit eager-relay risk override.
    if (isEventStream && upstreamResponse.body) {
      const repairConfig = route.provider.responsesItemIdRepair;
      const needsClientRewrite = imageGenCallAliases.size > 0 || hasResponsesItemIdRepair(repairConfig);
      const eagerDecision = !needsClientRewrite
        ? decideEagerRelayForPlatform(process.platform, config.streamMode ?? "auto")
        : null;
      if (eagerDecision?.useEagerRelay) {
        const turnAc = new AbortController();
        linkAbortSignal(upstream, turnAc.signal);
        registerTurn(turnAc);
        const reportNativeTerminal = recordTerminalOutcomes
          ? (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
            terminalRecorder?.(status, httpStatusOverride);
            if (status === "failed") {
              const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
                || logCtx.terminalHttpStatus === 429
                || logCtx.terminalHttpStatus === 402
                ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
                : undefined;
              if (quotaFailureMessage !== undefined) {
                recordSubagentQuotaFailureForThreadSpawn(
                  req.headers,
                  subagentQuotaFailureModel,
                  quotaFailureMessage,
                  config,
                  subagentFallbackAccountId,
                );
              }
            }
            options.onNativePassthroughTerminal?.(status);
          }
          : undefined;
        const inspector = createSseInspector({
          onTerminal: reportNativeTerminal,
          logCtx,
          onCompletedResponse: rememberPassthroughResponse,
          onFirstOutput: options.onFirstOutput,
        });
        const eagerBody = relaySseEagerBounded(upstreamResponse.body, turnAc, {
          inspectChunk: chunk => inspector.feed(chunk),
          finishInspection: () => inspector.finish(),
          sawTerminal: () => inspector.reported(),
          onSynthetic: kind => {
            if (!reportNativeTerminal) return;
            if (kind === "incomplete") {
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("incomplete");
            } else {
              logCtx.transportPhase = "mid_stream";
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("failed", 502);
            }
          },
          onClientCancel: () => options.onNativePassthroughCancel?.(),
          onDone: () => unregisterTurn(turnAc),
        });
        if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
        return markNativePassthroughSseResponse(new Response(eagerBody, {
          status: upstreamResponse.status,
          headers,
        }));
      }
```

The remainder of the current `if` body beginning with
`const [nativeBody, inspectBody] = upstreamResponse.body.tee();` stays in place.
It is the conservative fallback for payload rewriting and for all unsupported
platforms/modes.  Replace only the stale comments at `:1736-1751`: win32 is no
longer the sole native-handoff special case, but the tee fallback continues to
give win32 no-rewrite traffic a pure native body, while Darwin tee fallback keeps
the existing failed-tail wrapper.

### Payload rewrites: deliberately fall back to tee

Do **not** compose `relaySseWithPayloadRewrite` into eager relay in this phase.
The concrete selection is the `!needsClientRewrite` condition above.  When an
image alias or `responsesItemIdRepair` configuration is present, execution falls
through to the unchanged code at `core.ts:1740-1751`:

```ts
      const payloadRewrites = [
        createImageGenCallRestoreRewrite(imageGenCallAliases),
        hasResponsesItemIdRepair(repairConfig)
          ? createResponsesItemIdPayloadRewrite(repairConfig!)
          : undefined,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      const rewrittenBody = payloadRewrites.length > 0
        ? relaySseWithPayloadRewrite(nativeBody, composeSsePayloadRewrites(...payloadRewrites))
        : nativeBody;
```

This is not a feature compromise: it preserves byte/order/error behavior that
already has direct image/item-ID tests.  Composition was rejected because the
rewriter needs SSE-frame buffering and currently sits after `tee`; moving it
inside eager relay would require a new dual-output transform so the inspector
continues to see the raw upstream while the client sees repaired payloads.
Passing the rewritten stream to the existing eager reader would silently change
what continuation/request-log inspection stores.  That is a separate, testable
future unit, not a safe prerequisite for the dominant no-rewrite route.

### `src/server/relay-eager.ts`: preserve failed-tail semantics

The eager path owns the client stream, so it must emit the same terminal frame
as `relaySseWithFailedTail` rather than adding that wrapper after eager (a second
JS reader would defeat the single-reader invariant).  Replace the full
`relaySseEagerBounded` function at `relay-eager.ts:63-199` with this body.  The
only semantic delta is `emitFailedTail` in the non-abort, non-cancel read-error
case; normal completion, cancellation, bounded drain, inspection, and teardown
are unchanged.

```ts
export function relaySseEagerBounded(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  hooks: EagerRelayHooks,
  opts?: EagerRelayOptions,
): ReadableStream<Uint8Array> {
  const maxQueueBytes = opts?.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
  const drainMs = opts?.postCancelDrainMs ?? DEFAULT_DRAIN_MS;
  const drainBytes = opts?.postCancelDrainBytes ?? DEFAULT_DRAIN_BYTES;
  const now = opts?.now ?? Date.now;
  const reader = body.getReader();
  const encoder = new TextEncoder();
  let queuedBytes = 0;
  let cancelled = false;
  let wake: (() => void) | null = null;
  const wakeUp = () => { const w = wake; wake = null; w?.(); };
  const paused = () => new Promise<void>(resolve => { wake = resolve; });
  upstream.signal.addEventListener("abort", wakeUp, { once: true });

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let doneFired = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const fireDone = () => {
    if (doneFired) return;
    doneFired = true;
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    try { hooks.onDone(); } catch { /* lifecycle callbacks must not break teardown */ }
  };
  const armDrainTimer = () => {
    if (drainTimer) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      upstream.abort(new Error("post-cancel drain window expired"));
    }, drainMs);
    (drainTimer as { unref?: () => void }).unref?.();
  };
  const emitFailedTail = (err: unknown) => {
    const failure = {
      type: "upstream_error",
      code: "upstream_reset",
      message: `Upstream stream terminated unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    };
    const payload = JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: failure, last_error: failure },
    });
    try {
      // Match relaySseWithFailedTail: terminate a partial SSE block before the terminal.
      controllerRef?.enqueue(encoder.encode(`\n\nevent: response.failed\ndata: ${payload}\n\ndata: [DONE]\n\n`));
    } catch { /* client already torn down */ }
  };

  const producer = async () => {
    let syntheticKind: "incomplete" | "failed" | null = null;
    const aborted: Promise<"aborted"> = new Promise(resolve => {
      if (upstream.signal.aborted) resolve("aborted");
      else upstream.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    try {
      for (;;) {
        const result = await Promise.race([reader.read(), aborted]);
        if (result === "aborted") break;
        const { done: upstreamDone, value } = result;
        if (upstreamDone) {
          hooks.finishInspection();
          if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) syntheticKind = "incomplete";
          break;
        }
        hooks.inspectChunk(value);
        if (cancelled) {
          drainedBytes += value.byteLength;
          if (hooks.sawTerminal() || drainedBytes >= drainBytes || now() >= drainDeadline) break;
          continue;
        }
        queuedBytes += value.byteLength;
        try {
          controllerRef?.enqueue(value);
        } catch {
          cancelled = true;
          drainDeadline = now() + drainMs;
          armDrainTimer();
          continue;
        }
        while (queuedBytes > maxQueueBytes && !cancelled && !upstream.signal.aborted) await paused();
      }
    } catch (err) {
      if (!hooks.sawTerminal() && !cancelled && !upstream.signal.aborted) {
        syntheticKind = "failed";
        emitFailedTail(err);
      }
    } finally {
      if (syntheticKind) hooks.onSynthetic(syntheticKind);
      if (cancelled && !hooks.sawTerminal()) hooks.onClientCancel();
      if (cancelled || upstream.signal.aborted) {
        upstream.abort();
        reader.cancel().catch(() => {});
      }
      if (!cancelled) {
        try { controllerRef?.close(); } catch { /* already closed/errored */ }
      }
      fireDone();
    }
  };

  let drainedBytes = 0;
  let drainDeadline = Number.POSITIVE_INFINITY;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      void producer();
    },
    pull() {
      queuedBytes = 0;
      wakeUp();
    },
    cancel() {
      cancelled = true;
      drainDeadline = now() + drainMs;
      armDrainTimer();
      wakeUp();
    },
  });
}
```

`relaySseWithFailedTail` must **not** wrap an active eager body on macOS.  It
would only receive a second stream reader and would race/corrupt the queue
ownership.  The inline tail has the same `response.failed`, `last_error`,
partial-block delimiter, `[DONE]`, and close semantics as `relay.ts:66-81`.
This is necessary, not optional: consumers deliberately distinguish an SSE
`response.failed` from transport failure (`tests/chat-completions-endpoint.test.ts:607-640`),
and terminal singleness requires one terminal plus one DONE
(`tests/bridge-terminal-singleness.test.ts:28-40`).  `controller.error()` is
therefore not acceptable for macOS clients.

## Diagnostics and config/CLI surface

No new config values are required.  `src/config.ts:699` continues to accept
exactly `auto`, `legacy-tee`, and `eager-relay`; its invalid-persisted-value
degrade-to-auto behavior and warning (`:993-1003`) remain unchanged.  The CLI
usage at `src/cli/system-command.ts:14-22` also remains exactly the same.  This
preserves the important persisted-config rationale: a service cannot rely on a
shell environment to select stream shape (`src/types.ts:577-584`).

Update only the stale wording in `src/types.ts:577-582` to say “Windows and
macOS SSE passthrough” and that `eager-relay` accepts the #32111 risk on Bun
1.3.14.  Update the status exposure so Darwin operators can see the decision:

```diff
--- a/src/server/management/system-routes.ts
+++ b/src/server/management/system-routes.ts
@@
-      eagerRelay: process.platform === "win32" ? decideEagerRelay(streamMode) : null,
+      eagerRelay: decideEagerRelayForPlatform(process.platform, streamMode),
```

Change its import at `src/server/management/system-routes.ts:22` to
`decideEagerRelayForPlatform`.  The `null` value still identifies intentionally
unrolled-out platforms; Darwin reports `auto-known-bad` on Bun 1.3.14, which is
the operator-visible warning not to infer that changing a boolean is safe.

## Regression tests

1. Extend `tests/bun-stream-caps.test.ts` with direct policy cases:
   - Darwin + `auto` + `1.3.14`/`null` returns `auto-known-bad` and does not
     select eager.
   - Darwin + `eager-relay` + `1.3.14`/`null` returns `config-eager` and selects
     eager, proving explicit operator consent is the only pre-fix activation.
   - Darwin + `auto` + `1.4.0`/`1.4.0` selects eager; Darwin prerelease does not.
   - linux returns `null` for every mode.  Existing coverage already protects
     parser, prerelease, forced-mode, and legacy-pin behavior
     (`tests/bun-stream-caps.test.ts:1-100`).
2. Change `tests/relay-eager.test.ts:327-344` from expecting a rejected reader to
   reading all bytes.  Assert exactly one `event: response.failed`, its payload
   contains `code: "upstream_reset"` and the original error text, exactly one
   `data: [DONE]`, `rec.synthetics === ["failed"]`, and `rec.dones === 1`.
   Keep the shutdown test immediately below: abort-driven teardown must emit no
   tail and no synthetic failed terminal.
3. Add the **activation test** to the existing `runStreamingSpawn` helper in
   `tests/subagent-fallback-handle-responses.test.ts:867-908`.  Parameterize its
   current platform override with `"darwin"`; run `streamMode: "eager-relay"`
   against a completed SSE response.  Instrument the fake upstream body’s
   instance `tee` method to increment a counter before delegating.  Assert the
   client gets the completed response, terminal hooks run once, and the counter
   is **zero**.  This exercises `handleResponses` through real routing,
   `core.ts` selection, and `relaySseEagerBounded`; it is not a unit assertion
   about a boolean.  Add its matched Darwin `legacy-tee` control asserting the
   same response but `teeCalls === 1`.
4. In the same integration test, make the upstream send a delta then error under
   Darwin eager opt-in.  Assert the actual HTTP response text contains the
   synthetic `response.failed` and exactly one `[DONE]`; this closes the gap
   between the relay unit and the endpoint contract.
5. Keep `tests/passthrough-abort.test.ts:33-65`, but update its source-contract
   assertions to look for `decideEagerRelayForPlatform(process.platform,` and
   the `!needsClientRewrite` fallback, rather than `win32`.  It remains a guard
   against accidental reintroduction of an eager heartbeat/lifetime wrapper,
   not the activation proof.
6. Extend `tests/settings-stream-mode.test.ts` only if its Windows-only test
   description is updated; no schema or persisted-value expectation changes.

Run, after implementation:

```bash
bun test tests/bun-stream-caps.test.ts tests/relay-eager.test.ts tests/passthrough-abort.test.ts tests/subagent-fallback-handle-responses.test.ts
bun run typecheck
bun run test
```

## Harness acceptance criteria

Phase 1’s macOS harness must run the same provider/request mix with
`streamMode: legacy-tee` and explicit `streamMode: eager-relay`, record the
decision from `/api/system/memory`, and prove all of the following:

- Eager activation is observable on Darwin (`eagerRelay.useEagerRelay === true`,
  `reason === "config-eager"`) and the activation test’s no-tee invariant holds.
- Responses without rewrites preserve terminal status, continuation capture,
  request log outcomes, first-output timing, and client cancellation behavior.
- A reset after at least one event yields one `response.failed` and one `[DONE]`,
  not a reader/network error.
- Image alias and item-ID repair fixtures remain on tee and preserve current
  client-visible rewritten payloads.
- Under the Phase 1 four-client slow-reader workload, peak `external` materially
  drops toward the isolated 10–22 MiB single-reader range rather than the
  363–461 MiB tee range.  Report actual distributions; do not set a fake exact
  threshold before the harness establishes variance.
- RSS may remain in the 1.65–2.04 GiB residual band after GC.  A lower peak is
  welcome but is not a Phase 3 pass/fail criterion, because the experiment
  already proved it is independent of tee.
- A cancellation stress run must not crash the process.  On Bun 1.3.14 this is
  a gated, operator-acknowledged experiment, not evidence that #32111 is fixed.

## Non-goals and rollback

Non-goals: changing provider adapters or auth; enabling eager by default on
Bun 1.3.14; adding a new config mode; composing payload rewrites into eager;
adopting a Bun canary; claiming allocator retention is fixed; and changing the
existing restart escape hatch.

If any Darwin eager cancellation run crashes, hangs, or loses terminal/rewrite
parity, immediately set persisted `streamMode` to `legacy-tee` with
`ocx system settings --stream-mode legacy-tee`, verify `/api/system/memory`
reports `config-legacy`, retain the failing harness artifacts in scratch space,
and do not widen `auto`.  Revert the four implementation files as one change if
the forced mode itself is unsafe.  Only a released Bun with a reproduced
fix/verification may advance `MIN_FIXED_BUN_VERSION` and enable `auto`.
