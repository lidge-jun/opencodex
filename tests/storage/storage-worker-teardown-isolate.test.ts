/**
 * Isolate teardown regression for the storage Bun Workers.
 *
 * Bun's `bun test --isolate` reclaims the file realm at the boundary. A storage
 * Bun Worker that is still exiting then trips
 * `panic: Internal assertion failure` with `workers_spawned(N)
 * workers_terminated(N-1)` and kills the whole run (first seen on Windows:
 * run 30613324981, Bun 1.3.14).
 *
 * These four cases spent months quarantined off Linux and macOS because Bun
 * 1.3.14 had a second failure mode our teardown could not close from
 * JavaScript: a mid-file segfault at 0xFFFFFFFFFFFFFFF8 with a *balanced*
 * `workers_spawned === workers_terminated` count (exit 133 on macOS Silicon,
 * run 30691129351; exit 132 on ubuntu GHA, run 30700011812). The balanced count
 * is what ruled out an unjoined worker of ours: Bun destroyed the VM while
 * native work that had left the thread was still outstanding.
 *
 * Bun 1.4.0 — the version this repository pins (package.json `dependencies.bun`,
 * consumed by .github/actions/setup-project-bun) — rewrote that lifetime model:
 * worker threads are parent-owned and joined before the parent VM disappears,
 * native resources including bun:sqlite are torn down before JSC is destroyed,
 * and a termination gate stops native callbacks entering a stopping worker
 * (oven-sh/bun#37075, #38299). oven-sh/bun#38519 is the matching reproduction:
 * it crashed 3/3 on 1.3.14 and survived 3 × 400 terminate cycles on 1.4.0. The
 * skip is therefore gone rather than re-scoped, and the churn count is one
 * number on every platform again — the shrunken per-platform caps existed only
 * to dodge the 1.3.14 crash, and a one-cycle "repeated spawn/reset" case does
 * not test what its name claims.
 *
 * These cases hammer the exact failure window: fire-and-forget terminate must
 * still be joinable by drain, and repeated spawn → reset cycles must leave the
 * registry empty before the next isolate boundary. The OS-join settle in
 * `worker-lifecycle` stays: Bun's `close` event is not a thread-exit proof.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  requestStorageCleanupPolicyRun,
  resetStorageCleanupPolicyJobForTests,
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../../src/storage/policy-job";
import {
  drainStorageWorkers,
  liveStorageWorkerCount,
  terminateStorageWorker,
} from "../../src/storage/worker-lifecycle";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

let isolatedCodexHome: IsolatedCodexHome | null = null;
let testDir = "";
let previousHome: string | undefined;

/**
 * Spawn/reset iterations for the heavy churn case.
 *
 * Eight is the count that originally reproduced `workers_spawned(9)
 * workers_terminated(8)` on Windows, so it is the number that proves the
 * registry drains between cycles. It is no longer platform-scaled: the smaller
 * Linux and macOS caps were Bun 1.3.14 crash avoidance, not a cost decision.
 */
const WORKER_CHURN_CYCLES = 8;

function seedArchived(codexHome: string): void {
  mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
  writeFileSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), "o".repeat(100));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  db.exec(`INSERT INTO threads VALUES ('told','archived_sessions/rollout-old.jsonl',1)`);
  db.close();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-worker-teardown-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-worker-teardown-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(async () => {
  await resetStorageCleanupPolicyJobForTestsAsync();
  setStorageCleanupPolicyJobTestHooks(null);
  await drainStorageWorkers();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
});

afterAll(async () => {
  await drainStorageWorkers();
});

// Worker spawn on a loaded windows-latest shard; bound follows the platform floor.
async function waitForLiveWorker(timeoutMs = INTERNAL_DEADLINE_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveStorageWorkerCount() > 0) return;
    await Bun.sleep(5);
  }
  throw new Error("no storage worker was ever spawned; this test would prove nothing");
}

test("drain joins a fire-and-forget terminate before the isolate boundary", async () => {
  // Reproduces the old race: sync reset void-terminates (and used to deregister
  // immediately), then drain returned on an empty set while the thread exited.
  setStorageCleanupPolicyJobTestHooks({ blockMs: 800 });
  seedArchived(isolatedCodexHome!.path);
  const started = requestStorageCleanupPolicyRun({
    reason: "manual",
    codexHome: isolatedCodexHome!.path,
  });
  expect(started.accepted).toBe(true);
  await waitForLiveWorker();

  resetStorageCleanupPolicyJobForTests();
  expect(liveStorageWorkerCount()).toBeGreaterThan(0);
  await drainStorageWorkers();
  expect(liveStorageWorkerCount()).toBe(0);
}, { timeout: 30_000 });

test("repeated spawn/reset cycles leave no live workers", async () => {
  const cycles = WORKER_CHURN_CYCLES;
  for (let i = 0; i < cycles; i++) {
    // Fresh CODEX_HOME each cycle so a prior worker's SQLite handle cannot
    // leave the seed DB locked/EBUSY on Windows after terminate.
    isolatedCodexHome?.restore();
    isolatedCodexHome = installIsolatedCodexHome(`ocx-worker-teardown-cycle-${i}-`);
    setStorageCleanupPolicyJobTestHooks({ blockMs: 200 });
    seedArchived(isolatedCodexHome.path);
    const started = requestStorageCleanupPolicyRun({
      reason: "manual",
      codexHome: isolatedCodexHome.path,
    });
    expect(started.accepted).toBe(true);
    await waitForLiveWorker();
    await resetStorageCleanupPolicyJobForTestsAsync();
    await drainStorageWorkers();
    expect(liveStorageWorkerCount()).toBe(0);
  }
}, { timeout: 60_000 });

test("async beforeEach-style join between cycles leaves no live workers", async () => {
  // Mirrors storage-mutation-race: each case must await join before the next
  // spawn. A sync beforeEach reset used to fire-and-forget terminate and leave
  // workers_spawned(N) workers_terminated(N-1) for the next isolate reclaim.
  const cycles = 6;
  for (let i = 0; i < cycles; i++) {
    await resetStorageCleanupPolicyJobForTestsAsync();
    await drainStorageWorkers();
    expect(liveStorageWorkerCount()).toBe(0);

    isolatedCodexHome?.restore();
    isolatedCodexHome = installIsolatedCodexHome(`ocx-worker-teardown-beforeeach-${i}-`);
    setStorageCleanupPolicyJobTestHooks({ blockMs: 250 });
    seedArchived(isolatedCodexHome.path);
    const started = requestStorageCleanupPolicyRun({
      reason: "manual",
      codexHome: isolatedCodexHome.path,
    });
    expect(started.accepted).toBe(true);
    await waitForLiveWorker();
    await resetStorageCleanupPolicyJobForTestsAsync();
    await drainStorageWorkers();
    expect(liveStorageWorkerCount()).toBe(0);
  }
}, { timeout: 60_000 });

test("terminateStorageWorker is joinable and idempotent across callers", async () => {
  setStorageCleanupPolicyJobTestHooks({ blockMs: 500 });
  seedArchived(isolatedCodexHome!.path);
  const started = requestStorageCleanupPolicyRun({
    reason: "manual",
    codexHome: isolatedCodexHome!.path,
  });
  expect(started.accepted).toBe(true);
  await waitForLiveWorker();

  // Peek the live set via count, then race two drains after a sync reset.
  resetStorageCleanupPolicyJobForTests();
  const first = drainStorageWorkers();
  const second = drainStorageWorkers();
  await Promise.all([first, second]);
  expect(liveStorageWorkerCount()).toBe(0);

  // A second terminate on an already-reclaimed worker must not throw.
  await terminateStorageWorker({ terminate() {}, addEventListener() {} } as unknown as Worker);
}, { timeout: 30_000 });
