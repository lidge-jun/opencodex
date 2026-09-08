# 010 — Deterministic Windows shutdown-spill fixtures

Status: P amendment; documentation only. Future implementation is a separate C2 test-harness cycle after 050, before 080. C confirmed no ownership collision. Main owns the FSM, implementation, remote execution and insertion of this foundation beneath the runtime stack.

## Evidence and boundary

[Windows job 101339545421](https://github.com/lidge-jun/opencodex/actions/runs/33978547130/job/101339545421), head `4b34cbb8d3f308cd2b01e8d87784c65afb50a40f`, Bun 1.4.0: 3048 pass, 39 skip, 2 fail, 1 unhandled error. The two failures are in `tests/responses/responses-state.test.ts`:

- Stable-tail (1297): the 500 ms drain timer selected synchronous fallback; its unmocked ACL runner failed with EICACLS. The actual async-delay cause is unmeasured. Global ACL call 7 is also an unreliable publication marker: snapshot and directory hardening share this runner.
- Reserved budget (1438): only the ACL clock is synthetic. `spill-store.ts:232` charged real serialization/filesystem elapsed time and exhausted the deadline before temp-file hardening. The expensive operation is not identified.

Local evidence inputs: `.tmp/a-runtime-stack/ci-triage/report.md`, `sse-windows5.log:4038–4217`, and `prior-101262480176.log:3894–3897` in that same scratch directory. The earlier job passed the two cases; its overall run was not green. Unchanged source on the sampled dev is not an independently reproduced current-dev failure. Do not describe this as an SSE regression, a proven harmless transient, or a green Windows gate.

Future edit set: **only `tests/responses/responses-state.test.ts`**. No production, workflow, manifest, shared fixture or budget changes. Reuse `forceWindowsAclLane`, `isSpillAclTarget`, `ICACLS_OK`, existing clock/runner setters, and spill event recording. Keep existing deadline, fallback, exhaustion and watchdog tests. No sleeps for synchronization, timeout increases, skips or relaxed assertions.

Read-only owners inspected:

| Owner | Contract retained |
|---|---|
| `src/responses/state.ts:595` | Drain races the observed tail against a real timer; `Date.now` alone cannot freeze that timer. |
| `src/responses/state.ts:771` and `:813` | Separate fallback reserve, remaining-budget forwarding, and repeated observation until the publication tail is stable. |
| `src/responses/spill-store.ts:100`, `:153`, `:225` | Existing I/O events and injectable spill clock; each harden gets min(per-call cap, remaining whole-write budget). |
| `src/lib/windows-secret-acl.ts:360`, `:410`, `:589` | Async runner timer; injected ACL clock; grant/inheritance/remove calls consume one harden deadline. |
| `tests/responses/ws-upstream.test.ts:725` | Existing Bun `jest.useFakeTimers` / `advanceTimersByTime` / `useRealTimers` convention. |

## Hunk 1 — Stable-tail ordering, not elapsed disk time

At the test import, add `jest`. Retain 1000/500 budgets. Use fake timers **only within this test**, with `Date.now` fixed to a captured real epoch and ACL/spill clocks fixed consistently. Capture native `setImmediate` before enabling fake timers for an event-loop checkpoint; this drains runnable promise work without a sleep or timer advance. No new shared helper.

Replace the global `aclCalls === 1/7` runner with gates on the first two distinct spill temp paths at `/grant:r`:

```ts
const gatedTemps = new Set<string>();
setAsyncIcaclsRunnerForTests(async args => {
  const target = args[0] ?? "";
  if (!isSpillAclTarget(args) || !target.endsWith(".tmp") || args[1] !== "/grant:r") {
    return ICACLS_OK; // includes snapshot, directory and later ACL steps
  }
  if (!gatedTemps.has(target)) {
    gatedTemps.add(target);
    if (gatedTemps.size === 1) { firstEntered(); await firstGate; }
    if (gatedTemps.size === 2) { secondEntered(); await secondGate; }
  }
  return ICACLS_OK;
});
let syncSpillCalls = 0;
setIcaclsRunnerForTests(args => {
  if (isSpillAclTarget(args)) syncSpillCalls++;
  return ICACLS_OK;
});
```

Both principal resolvers remain synthetic through `forceWindowsAclLane`. Both ACL runners cover **every** target; filtering controls gating/counting, never whether a real subprocess is used. A fallback must fail the ordering oracle (`syncSpillCalls === 0`), rather than being hidden by the successful mock.

Replace the current orchestration and 25 ms sleep with this exact ordering:

1. Enter `try/finally` before the first enqueue/await. Enable fake timers and fixed epoch clock; install both clock setters. Enqueue first response and await its temp gate.
2. Start `flushResponseState`, immediately attach both settlement handlers, recording `flushed` and any error in a resolved outcome object. This avoids an unhandled rejection if an earlier assertion fails.
3. Enqueue second response **after** starting flush, then release first. Await second temp gate. Await a native `setImmediate` checkpoint, advance fake timers by 25 ms, then another native checkpoint. The drain timer stays below 500 ms; no real elapsed filesystem time can fire it.
4. Assert flush is still pending, exactly two distinct temp paths were gated, and no synchronous spill ACL calls occurred. Record `setSpillIoForTest({ record })` events and assert exactly one `stub-swap` so the first publication actually installed while the second is gated.
5. Release second, await the handled flush outcome and rethrow any captured error. Retain `{ residentCount: 0, spillStubCount: 2 }`; add pending `{ count: 0, bytes: 0 }`, two `stub-swap` events, and zero synchronous spill calls. Both stored response IDs must still expand to their distinct payloads.
6. `finally`: release **both** gates, await any started flush outcome and `flushPendingResponseSpillsForTests()` while mocks/clocks remain installed, then restore the Date spy and real timers in a nested `finally`. Existing `afterEach` restores setters. Never restore mocks while a gated async operation still owns work.

Use a discriminated outcome (`{ ok: true } | { ok: false; error: unknown }`) rather than an undefined-error sentinel. Keep cleanup valid when either startup await/assertion fails. Fake-timer compatibility and the native checkpoint are remote Windows acceptance items, not assumed proof. Do not solve a failed fixture by globally suppressing timers or adding a production seam.

## Hunk 2 — One logical fallback budget, actual drain timer

At 1438, preserve `totalMs = 500`, `fallbackReserveMs = 300` and the pending async spill gate. Add the missing spill clock; scope a Date spy to the flush so outer fallback accounting and nested ACL accounting advance together. Keep native timers in this test: the unchanged 200 ms drain timer must expire while the async gate remains held.

```diff
 let aclClock = 0;
 setNowForTests(() => aclClock);
+setResponseSpillNowForTests(() => aclClock);
```

Record `{ target, timeoutMs, spentBefore }` for **spill** synchronous ACL calls. Snapshot ACL calls return `ICACLS_OK` without charging the spill clock. For each spill call, record before incrementing `aclClock += 20`; preserve successful command results.

```ts
const epoch = Date.now();
const nowSpy = spyOn(Date, "now").mockImplementation(() => epoch + aclClock);
// Start only after the async spill gate announces entry.
try {
  await flushResponseState(); // native 200 ms drain timer selects sync fallback
} finally {
  release();
  try { await flushPendingResponseSpillsForTests(); }
  finally { nowSpy.mockRestore(); }
}
```

An enclosing `try/finally` must also cover enqueue and `await started`, releasing the gate on early failure. Preserve all three original assertions: at least six spill commands, maximum deadline <= 150, and `200 + aclClock <= 500`. Add:

- Every timeout is positive and <= `300 - spentBefore` (independent literal budget oracle).
- Within each target's grant/inheritance/remove sequence, each next timeout is exactly 20 ms smaller; do **not** assert global monotonicity across targets because a new harden has its own per-call cap.
- The async gate has not been released when synchronous spill work begins; fallback actually ran, pending count/bytes become zero, one spill stub remains, and replay contains the original payload.

The Date spy prevents unmeasured real disk latency from consuming this logical-budget fixture. It does not disable the native drain timer. Real-time termination coverage remains in the unchanged cap-expiry test (1339) and `shutdown fallback budget exhaustion is contained by a child watchdog` (1613), using `tests/helpers/responses-state-shutdown-budget-child.ts`. Do not claim this test measures OS elapsed latency.

## Windows red, control and proof

Main executes these later on real Windows with the repository-pinned Bun, in isolated remote checkouts. Nothing below authorizes local tests in this documentation task.

1. Preserve the failed root-head job/logs above. Run the original two tests on the pinned pre-fix baseline; record actual results, including a pass. Do not require random failure or accept retries as a fix.
2. In remote scratch only, force the old stable-tail drain to expire by holding the second gate until a recorded fallback entry. Use a counted synchronous sentinel that reports EICACLS instead of invoking native ACL tools. Confirm rejection and the fallback call; never infer the missing-mock path from elapsed time alone. This is a controlled mechanism probe, not proof that the same delay happened in CI.
3. In remote scratch only, use the existing spill `record("write")` event to advance a separate wall clock by 301 ms once synchronous fallback has begun. On the original reserved-budget fixture, spill uses that clock and fails before temp hardening; with the proposed shared logical spill clock, the same wall-clock perturbation cannot consume the ACL budget. Record entry and clock values. Keep this probe separate from production and from the committed passing fixture.
4. Prove oracle sensitivity with isolated remote mutations: (a) stop drain after its first observed tail, expecting the revised stable-tail pending/zero-fallback oracle to fail; (b) reset the ACL deadline for each command, expecting per-target 20 ms decrease assertions to fail. Separately advance the **injected spill clock** beyond 300 at the write event and require ETIMEDOUT, proving deadline enforcement remains active. Restore every mutation before green verification; retain diff and failing assertion for each probe.
5. Run the unchanged named cap-expiry and child-watchdog controls, then the whole focused file on the new exact head:

```sh
# Remote Windows only; these commands are a future verifier recipe.
bun test --isolate --timeout 60000 tests/responses/responses-state.test.ts
bun run typecheck
```

6. Dispatch the actual Windows full-suite workflow on that exact head, including `bun test --isolate --timeout 60000 tests --shard=5/6` and every other required shard. Inspect job execution, not aggregate success with skipped tests. Record head SHA, Bun version, commands, job URLs, counts and absence of unhandled errors. Run current-head Linux/macOS gates and required scans as well.

Implementation D means an independently reviewed prepared foundation draft with exact-head focused Windows evidence and remote typecheck; it is **not landing**. Main inserts the verified foundation beneath the stack, refreshes descendants bottom-up with original attribution intact, obtains required current-head gates, then admin-merges in dependency order. Verify each landed SHA is an ancestor of freshly fetched dev before closing a superseded PR or fully resolved issue. Partial issues retain their residual scope. See `080_landing.md`.

Documentation acceptance: this file names both failed fixtures, all clock/timer boundaries, complete runner/cleanup coverage, executable negative controls, one-file implementation scope and separate landing gates. No test execution or implementation success is claimed here.

## Remote execution fallback amendment

The existing direct Windows SSH endpoint is unavailable; the reachable auxiliary host is Linux without Windows interop. Use GitHub Actions for actual Windows proof. If the existing full-suite workflow cannot execute focused causal probes, a separate owner-only `codex/a-verify-windows` branch may hold a temporary verification workflow triggered only by pushes to that exact branch. This workflow is never included in a product PR or merged to dev. It uses `windows-latest`, read-only contents permission, pinned checkout with `persist-credentials: false`, the existing pinned-Bun setup, fixed repository test commands and the exact carried fixture commit. No secrets, untrusted command inputs, self-hosted runner access or release permissions. It may execute the narrowly specified scratch mutations with guaranteed source restoration and upload logs. Independent security audit of the concrete workflow is required before pushing it. Standard per-head full CI remains the final gate; the temporary verifier cannot mark those checks green.
