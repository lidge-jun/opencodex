/**
 * Bun test preload — the FIRST line of defense for the developer's real OpenCodex home.
 *
 * `bun run test` already sandboxes HOME/OPENCODEX_HOME/CODEX_HOME through
 * `scripts/test.ts`. The incident this file prevents happened under a bare
 * `bun test <file>` — the command anyone reaches for while iterating on one test —
 * which gets no wrapper and therefore had no isolation at all. A preload runs for
 * EVERY invocation, so the protection no longer depends on remembering the wrapper.
 * (devlog `_plan/260730_codex_rs_upstream_v2_live_handoff/070`.)
 *
 * Import order below is load-bearing: importing the guard captures the real home at
 * module load, and that must happen BEFORE this file replaces HOME.
 */
import { isTestHomeGuardArmed, protectedHomeForTests } from "../src/lib/test-home-guard";
import { createIsolatedTestEnvironment } from "../scripts/test";
import {
  acquireTestRunLock,
  resolveBareTestRunIdentity,
  resolveInheritedTestRunLock,
  TEST_RUN_ID_ENV,
} from "../scripts/test-run-lock";
import { rmSync } from "node:fs";

// `scripts/test.ts` owns the lock for wrapped runs. A bare `bun test` has no wrapper,
// so a single-process runner uses its own PID while true parallel workers rendezvous
// on their short-lived controller PID. The first worker acquires the lock and siblings
// join it. The bare-run lock is deliberately left for the next invocation to reclaim
// after every registered worker exits — releasing it from an early-finishing worker
// would let another suite overlap the remaining workers.
const wrappedRunId = process.env[TEST_RUN_ID_ENV]?.trim();
const bareIdentity = resolveBareTestRunIdentity({
  pid: process.pid,
  ppid: process.ppid,
  workerId: process.env.BUN_TEST_WORKER_ID,
});
const runId = wrappedRunId || bareIdentity.runId;
const inheritedLock = resolveInheritedTestRunLock({
  wrappedRunId,
  env: process.env,
});
process.env[TEST_RUN_ID_ENV] = runId;
await acquireTestRunLock({
  runId,
  ownerPid: bareIdentity.ownerPid,
  lockPath: inheritedLock?.lockPath,
  validatedRuntimePath: inheritedLock !== undefined,
  joinExistingOwnerToken: inheritedLock?.ownerToken,
  onWait: owner => console.warn(
    `[test] bare Bun worker ${process.pid} is waiting for test run${owner ? ` pid ${owner.pid}` : ""} to release the user lock.`,
  ),
});

// Under `bun run test` the wrapper already handed us a sandbox (and OCX_REAL_HOME so the
// guard could still see the true home). Isolating again is harmless and deliberate: the
// alternative — inferring "already isolated" from path shapes — would trust exactly the
// user-controlled environment state this file exists to distrust.
const isolated = createIsolatedTestEnvironment();
for (const [key, value] of Object.entries(isolated.env)) {
  if (value !== undefined) process.env[key] = value;
}

// Arm the guard only after the sandbox is in place, so nothing observes a half-applied
// state. The guard's protected path was already captured at import time above.
process.env.OCX_TEST_HOME_GUARD = "1";
// Lets a test assert one preload per process rather than assuming Bun's scheduling.
process.env.OCX_TEST_PRELOAD_PID = String(process.pid);

if (!isTestHomeGuardArmed() || !protectedHomeForTests()) {
  throw new Error("test home guard failed to arm; refusing to run tests unprotected");
}

// Clean up only the root this preload created. The `bun run test` wrapper owns its own.
process.on("exit", () => {
  try { rmSync(isolated.root, { recursive: true, force: true }); } catch { /* best effort at exit */ }
});
