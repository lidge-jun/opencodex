# Phase 2: repair the Windows iteration timeout

## Failure evidence

- Cross-platform CI run: `29039366674`
- Exact HEAD: `69d8ec7c5df54200cc5c08eb980982f217a60a75`
- Failed job: `windows-latest` (`86192390158`)
- Five sibling jobs passed.
- The Windows test log reached `tests/web-search.test.ts:210`, entered `loop per-iteration timeout surfaces 504 instead of hanging`, and emitted no further test output until GitHub cancelled the job at its 8-minute limit.
- The same focused test completes on macOS in about 103ms with Bun `1.3.14`.

## Hypotheses and falsifiers

- H1: Bun on Windows does not reliably wake the pending adapter promise when the loop composes `AbortSignal.any([parent, AbortSignal.timeout(...)])`, or the timeout aborts before the mock subscribes and the mock misses the one-shot event. Falsifier: an adapter that handles both an already-aborted signal and a later abort would return 504 near 100ms on Windows. The repaired regression explicitly covers both subscription states.
- H2: `runWithWebSearch` fails to pass the composed signal into `adapter.fetchResponse`. Falsifier: source tracing shows `fetchOnce` passes `abortSignal: iterationSignal`, and the test adapter subscribes directly to that option. H2 is rejected by `src/web-search/loop.ts:255` and `tests/web-search.test.ts:214`.
- H3: a prior test leaves `globalThis.fetch` or shared state corrupted. Falsifier: `afterEach` restores the original fetch, and the hanging adapter does not call global fetch. H3 is rejected by `tests/web-search.test.ts:104` and the adapter implementation at `tests/web-search.test.ts:212`.

Leading cause: the runtime-specific composite timeout boundary, with late subscription kept as a competing mechanism until the hardened Windows regression passes. The repository already avoids the composite primitive for sidecar and vision calls by using `signalWithTimeout`, a `setTimeout`-backed controller with parent propagation and explicit cleanup.

## Reuse decision

Reuse `src/lib/abort.ts:signalWithTimeout`, already used by `src/web-search/executor.ts` and `src/vision/describe.ts`. Do not add another helper, dependency, retry, sleep, or test-only production branch.

## Diff-level implementation

MODIFY `src/web-search/loop.ts`:

```diff
-import { cancelBodyOnAbort } from "../lib/abort";
+import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
```

Replace the per-iteration `AbortSignal.any` construction with one linked timeout handle:

```diff
-const iterationSignal = deps.connectTimeoutMs
-  ? AbortSignal.any([signal, AbortSignal.timeout(deps.connectTimeoutMs)])
-  : signal;
+const iterationTimeout = deps.connectTimeoutMs
+  ? signalWithTimeout(deps.connectTimeoutMs, signal)
+  : null;
+const iterationSignal = iterationTimeout?.signal ?? signal;
```

Wrap the fetch/429/parse body of `runIterationEvents` in `try/finally` and call `iterationTimeout?.cleanup()` in the `finally` block. This preserves one deadline across all 429 retries and removes the timer and parent listener on every success/error/generator close path.

Replace the manual inner iterator relay in `produce()`:

```diff
-const it = runIterationEvents(forceAnswer);
-let r = await it.next();
-while (!r.done) {
-  yield r.value;
-  r = await it.next();
-}
-split = r.value;
+split = yield* runIterationEvents(forceAnswer);
```

Delegated `yield*` propagates outer generator closure to the inner iterator, so its `finally` executes even when the SSE consumer closes while a 429 heartbeat is being relayed.

MODIFY `tests/web-search.test.ts`:

- Harden the hanging adapter: reject immediately when `abortSignal.aborted` is already true; otherwise subscribe once. This removes the late-subscription ambiguity from the Windows activation probe.
- Add a delayed-first-429 then hanging-rotated-adapter test with one short `connectTimeoutMs`; assert the total iteration returns 504 instead of granting a fresh timeout after rotation.
- Add a parent-abort test that waits until the hanging adapter receives its signal, aborts the supplied parent controller, and asserts the iteration settles promptly with the signal aborted.
- Keep the existing 504/message assertions. Normal suite completion plus delegated `yield*` and the helper's direct cleanup implementation cover the close path without adding a test-only timeout factory to production code.

## Activation and verification

1. Trigger: run the hardened test whose mock adapter settles only when its passed abort signal is already aborted or later fires.
2. Observe: `runWithWebSearch` returns HTTP 504 and the test completes near its 100ms deadline.
3. Trigger the rotated-adapter and parent-abort cases; observe one deadline across retries and immediate parent propagation.
4. Verify locally:

   ```bash
   bun test tests/web-search.test.ts -t "loop per-iteration timeout"
   bun test tests/web-search.test.ts
   bun run typecheck
   bun test tests
   ```

5. Verify in GitHub Actions: the Windows `Test` step advances beyond `tests/web-search.test.ts`, all six CI jobs succeed, and the exact-HEAD Service lifecycle workflow succeeds.

## Done criteria

- The timeout helper is reused with deterministic cleanup.
- The outer generator delegates with `yield*`, so inner cleanup participates in consumer closure.
- Timeout, 429-rotation, and parent-abort activation tests pass.
- The focused activation test, affected file, typecheck, and full local suite pass.
- A fresh exact-HEAD Cross-platform CI run, including Windows, concludes `success`.
