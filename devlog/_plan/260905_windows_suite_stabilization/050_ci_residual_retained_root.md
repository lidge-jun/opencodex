# 050 — wp3: the CI residual — a three-child test under a 15 s budget

Implementation phase. Independent of `020`/`030` (disjoint write set). Found by
dispatching the pushed branch to GitHub Actions (run 33920624827, head
`7153f247a`): windows 1/4, 3/4, 4/4 green; 2/4 = 4627 pass / 1 fail.

## The failure

```
tests\codex-retained-root-serialization.test.ts:
killed 2 dangling processes
(fail) startup and CLI sync-cache cannot write models_cache while another process owns K [15536.76ms]
  ^ this test timed out after 15000ms.

# Unhandled error between tests
215 |     holder.release();
ENOENT: no such file or directory, open '...\ocx-retained-cache-3FtvI4\lock-release'
```

Not an assertion failure. Bun's per-test timeout fired at 15 s, then the
`finally` ran `holder.release()` against a sandbox `afterEach` had already
torn down — that ENOENT is a consequence of the timeout, not a second defect.

It does not reproduce on the self-hosted box: three full shard-2 runs there
passed this file every time. It is a hosted-runner-speed failure.

## What the test does inside 15 s

```
:176  holdCatalogLock   → Bun.spawn  child #1  (holds K, STAYS ALIVE; its marker waited up to 12 s)
:178  runChild          → Bun.spawn  child #2  (import src/server/index.ts, probe startServer) — unbounded await
:192  Bun.spawnSync     →            child #3  (bun run src/cli/index.ts sync-cache)         — unbounded
```

The holder boots first and remains alive while the two contenders run one after
the other, so the boot costs are additive even though the holder is concurrent.
Two of the three import the server or the CLI — the heaviest module graphs in
the repository. The file's own comment at `:99-102` records "a `bun --eval`
child on a loaded windows-latest shard takes 8-11 s just to boot and reach its
marker". Three boots cannot fit in 15 s; the budget was sized from local timing
(448 ms on macOS), the exact mistake `tests/helpers/test-budget.ts` names.

Sibling accounting, corrected by the audit: the file has six cases with
per-case budgets `15 / unspecified / 20 / 20 / 20 / 30` s. The unspecified one
(`:220`) inherits the lane-wide `--timeout 60000` from `ci.yml:655`. All
five siblings passed on the same runner at 7.1 / 10.5 / 14.0 / 4.1 / 8.2 s. The
15 s case is the only one under the line, and it is the one that failed.

## The second defect: dangling children and a teardown race

"killed 2 dangling processes" and the ENOENT are not noise. They are what a
per-test timeout does to this harness today:

- `runChild` (`:110-127`) awaits `child.exited` with no deadline, and the
  `Bun.spawnSync` at `:192` has none either. When Bun's outer timeout fires,
  both contenders can still be running — those are the two dangling processes.
- The `finally` at `:214-217` then calls `holder.release()`, which writes a
  file inside `sandbox.root` — but `afterEach` (`:163-170`) has already
  `removeTreeWithRetry`'d that root. Hence ENOENT.

A 45 s budget delays that failure; it does not remove it. The next slow runner
produces the same "killed N dangling processes" with a bigger number in the
timestamp. Both halves are fixed here, not just the budget.

### Ordering that removes the race

Cleanup has to be idempotent and owned by ONE place that both the test's
`finally` and `afterEach` can call:

1. release the holder (write `lock-release`, tolerate ENOENT)
2. kill every child spawned for this sandbox that is still running
3. `await` each child's `exited` — reap BEFORE the directory goes away
4. only then `removeTreeWithRetry(sandbox.root)`

`afterEach` becomes `async` and awaits step 3. That is the change that turns
"killed 2 dangling processes" into a clean exit under any budget.

## Why this is a budget, not a hang

`test-budget.ts` sets two conditions for raising a number:

1. **The wait is intrinsic to the assertion.** Yes: the assertion IS that a
   real startup process and a real CLI process both refuse to write
   `models_cache.json` while a third real process holds K. The processes are
   the proof; there is nothing to delete.
2. **The ablation still fails.** To be verified at B: remove
   `withCatalogWriteSerialization` from the sync-cache path and confirm the
   case goes red on `existsSync(cachePath)`. If it does not, the budget hides
   a vacuous test and the fix is different.

`SPAWN_BUDGET_MS` (45 s) is the repository's named budget for "real child
process: PowerShell, a CLI smoke test, an external binary" — this case is three
of those.

## MODIFY `tests/codex-retained-root-serialization.test.ts`

Three coordinated changes.

**(a) Track children on the sandbox, and make cleanup one idempotent function.**

```ts
 interface Sandbox {
   …
+  readonly children: Set<ReturnType<typeof Bun.spawn>>;
+  readonly releaseMarkers: Set<string>;
 }

+/** Idempotent: safe from a test's finally AND from afterEach, in either order. */
+async function teardownSandbox(sandbox: Sandbox): Promise<void> {
+  for (const marker of sandbox.releaseMarkers) {
+    try { writeFileSync(marker, "release"); } catch { /* root may already be gone */ }
+  }
+  for (const child of sandbox.children) {
+    if (child.exitCode === null) child.kill();
+  }
+  await Promise.all([...sandbox.children].map(child => child.exited));   // reap first
+  sandbox.children.clear();
+}
```

`holdCatalogLock` and `runChild` register every spawn in `sandbox.children`;
`holdCatalogLock` registers its release marker.

**(b) `afterEach` awaits reaping before deleting the tree.**

```ts
-afterEach(() => {
+afterEach(async () => {
   const identity = resolveEffectiveUserIdentity();
   for (const sandbox of sandboxes.splice(0)) {
+    await teardownSandbox(sandbox);
     const database = resolveCodexCatalogSerializationDatabasePath(identity, sandbox.codexHome);
     for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
     removeTreeWithRetry(sandbox.root);
   }
 });
```

**(c) The budget, with the CI run in the comment.**

```ts
+import { SPAWN_BUDGET_MS } from "./helpers/test-budget";
 …
-}, 15_000);
+// Three real Bun children (lock holder alive throughout; startup probe and CLI
+// sync-cache in series), two importing the server/CLI graphs at 8-11 s each on
+// windows-latest (:99). 15 s timed out on run 33920624827.
+}, SPAWN_BUDGET_MS);
```

The `Bun.spawnSync` at `:192` stays synchronous: it cannot be killed mid-flight,
but with (a)/(b) its worst case is now "slow", not "dangling + ENOENT". Converting
it to an async bounded spawn is a reasonable follow-up and is out of scope here
because it changes how the CLI's exit code is captured.

### Not changed, deliberately

- `waitForPath(ready, 12_000)` at `:159` stays: it is the helper's own
  diagnostic and sits inside the new budget as its comment requires.
- The sibling cases keep 20/20/30 s. They passed with margin; raising numbers
  that are not failing is the "making red go away" the helper warns against.

## Ablation, made constructible

The first draft said "bypass `withCatalogWriteSerialization`". The audit is
right that this cannot produce the red: `invalidateCodexModelsCacheWithPermit`
demands a live registered permit (`src/codex/catalog/sync.ts:1949`), so
removing the wrapper makes the write REFUSE, which is the same green.

The mutation that actually disarms K is one token in
`src/codex/catalog-write-serialization.ts:188`:

```ts
-    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
+    database.exec("PRAGMA busy_timeout = 0; BEGIN");           // DEFERRED: no write lock taken
```

With a deferred transaction the contender opens without contending, receives a
live permit, and writes `models_cache.json` while the holder still "owns" K.
The behavioural assertion `expect(existsSync(cachePath)).toBe(false)` at `:200`
must go red — not the source-text assertions at `:204-213`, which would stay
green under this mutation and are exactly why they are insufficient as the
gate.

## Acceptance

1. Ablation at B, on macOS: the one-token mutation above makes the case fail on
   `existsSync(cachePath)`. Reverted before commit; the revert is verified by
   `git diff --stat` showing only the test file.
2. macOS: the file passes; `afterEach` reaps before deleting (no ENOENT even if
   a case is forced to time out by temporarily setting its budget to 1 ms).
3. CI: re-dispatch on the stacked head; windows 2/4 SUCCESS, this case's
   recorded duration under `SPAWN_BUDGET_MS` with margin, and no "killed N
   dangling processes" line in the job log.

## Stack position

Third commit on `codex/260905-windows-suite-stabilization`, after the two
harness fixes. Independent of them, ordered by discovery.
