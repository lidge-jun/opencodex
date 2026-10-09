# 020 — #6777: combo management fixture stays local and serial

## Defect

`tests/routing/combo-management-api.test.ts` builds providers `a/b/c` with
synthetic `https://*.example/v1` URLs and live discovery on. The rename route
awaits `syncClaudeAgentDefsBestEffort` → `fetchAllModels` → provider discovery →
`providerOutboundGet` → DNS lookup, which is not bounded by the request's abort
signal. When DNS is slow the case passes Bun's 5 s timeout; Bun then starts the next
case while the first callback is still running, so the first reads the second's
fixture and its `finally` restores the environment under the second (the reported
`new-public`/`stable-public` mismatch and `ENOENT config.json`).

Hosted CI resolves DNS fast and uses `--timeout 60000`, which hides it.

The route's await is correct and stays: the test asserts that agent definitions are
migrated before the response returns.

## Change — MODIFY `tests/routing/combo-management-api.test.ts` only

1. `baseConfig`: add `liveModels: false` to providers `a`, `b`, `c` (static
   catalog path in `src/codex/catalog/provider-models.ts:239`).
2. Serialize the fixture helper and drain it, with a bound, before shared state is
   cleared. A drain that exceeds the bound poisons the helper: later owners reject
   immediately instead of queueing behind a callback that may still resume and rewrite
   the environment.

```diff
-async function withTempHome<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
+// Bun starts the next case while a timed-out one is still running. Chaining owners
+// keeps one case's environment from being installed or restored under another's.
+let tempHomeSettled: Promise<void> = Promise.resolve();
+let tempHomeStuck = false;
+let tempHomeDrainMs = 50_000; // lowered only by the poison regression
+const STUCK = "an earlier withTempHome owner never settled; refusing to share its environment";
+function withTempHome<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
+  if (tempHomeStuck) return Promise.reject(new Error(STUCK));
+  // Rechecked when the queued owner starts: one queued before poisoning must not run
+  // after a stalled predecessor finally settles.
+  const operation = tempHomeSettled.then(() => {
+    if (tempHomeStuck) throw new Error(STUCK);
+    return runWithTempHome(run);
+  });
+  tempHomeSettled = operation.then(() => {}, () => {});
+  return operation;
+}
+
+async function drainTempHome(): Promise<void> {
+  // Once poisoned, every later drain fails at once instead of waiting out the bound again.
+  if (tempHomeStuck) throw new Error(STUCK);
+  let timer: ReturnType<typeof setTimeout> | undefined;
+  const drained = await Promise.race([
+    tempHomeSettled.then(() => true),
+    new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), tempHomeDrainMs); }),
+  ]);
+  clearTimeout(timer);
+  if (!drained) {
+    tempHomeStuck = true;
+    throw new Error("withTempHome owner still running after the drain bound");
+  }
+}
+
+async function runWithTempHome<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
```

```diff
-afterEach(() => {
+afterEach(async () => {
+  await drainTempHome();
   clearComboSelectionState();
   clearComboTargetCooldowns();
-});
+}, 60_000);
```

3. Regression in the rename case without re-indenting it: install
   `spyOn(outbound, "providerOutboundGet").mockRejectedValue(...)` at the top of the
   case, register its restore in an `afterEach` cleanup list, and assert
   `expect(discovery).not.toHaveBeenCalled()` after `withTempHome` resolves. On dev
   the spy records the a/b/c discovery calls.
4. Serialization regression at file end: two overlapping `withTempHome` owners;
   the first holds a gate and asserts its own `OPENCODEX_HOME` after the second was
   requested. On dev the second owner rewrites the environment under the first.
   The gate is released in `finally` so a failing assertion cannot strand the queue.
5. Poison regression: with a lowered drain bound, an owner that never settles makes
   `drainTempHome()` throw; afterwards (a) a second drain rejects immediately, (b) a new
   `withTempHome` rejects immediately, and (c) an owner queued before poisoning rejects
   without running its callback when the stalled owner is released. Gate release,
   settlement of every owner, and restoration of the bound, the poison flag and the queue
   head all happen in `finally`, so a failed assertion cannot leave the file poisoned.
   The test-only reset is a small `resetTempHomeQueueForTest()` function in the test file.

## Verify

```sh
FH=$(mktemp -d); env -u HTTPS_PROXY -u NODE_EXTRA_CA_CERTS HOME="$FH" USERPROFILE="$FH" CLAUDE_CONFIG_DIR="$FH/.claude" \
  bun test tests/routing/combo-management-api.test.ts
```


## Implementation record

Implemented as written in PR #6833 (branch `codex/n3-combo-rename-fixture`, commit `0fa7ee87df`),
test-only, in `tests/routing/combo-management-api.test.ts` (1,913 lines, under the ratchet cap, so
no sibling file was needed). Before the change the three regressions fail (rename: 3 discovery
calls; serialization: the first owner observes the second's `OPENCODEX_HOME`; poison: the drain
resolves). After: 41/41 in the file under a fresh startup home; independent review also ran it with
CI's `--isolate --timeout 60000` flags (77/77 across four files) and confirmed the timeout probe
drains the owner before the next case.

