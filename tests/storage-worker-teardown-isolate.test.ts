/**
 * Windows-style isolate teardown regression.
 *
 * Bun's `bun test --isolate` reclaims the file realm at the boundary. A storage
 * Bun Worker that is still exiting then trips
 * `panic: Internal assertion failure` with `workers_spawned(N)
 * workers_terminated(N-1)` on Windows and kills the whole run.
 *
 * A second Bun 1.3.14 failure mode is a mid-file / post-suite segfault with a
 * *balanced* `workers_spawned === workers_terminated` count (exit 132/133).
 * Seen on macOS Silicon and ubuntu GHA even after the first green assertion in
 * this file. Churn caps and short settles were not enough. Keep isolate
 * everywhere; skip Worker-spawning hammers on non-Windows (platform-cap
 * meta-test still runs); win32 keeps the regression for the original panic.
 * OS-join settle stays in `worker-lifecycle` for win32/darwin.
 *
 * These cases hammer the exact failure window: fire-and-forget terminate must
 * still be joinable by drain, and repeated spawn → reset cycles must leave the
 * registry empty before the next isolate boundary.
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
} from "../src/storage/policy-job";
import {
  drainStorageWorkers,
  liveStorageWorkerCount,
  terminateStorageWorker,
} from "../src/storage/worker-lifecycle";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let isolatedCodexHome: IsolatedCodexHome | null = null;
let testDir = "";
let previousHome: string | undefined;

/**
 * Bun 1.3.14: Worker spawn in this file still segfaults the isolate process
 * after green assertions with balanced counts on darwin and linux GHA. Skip
 * hammers off Windows; win32 keeps full coverage for the original panic.
 */
const skipNonWindowsWorkerSpawn = process.platform !== "win32";

/** Spawn/reset iterations for the heavy churn case — platform-stressed carefully. */
function workerChurnCyclesForIsolate(): number {
  if (process.platform === "win32") return 8;
  // Non-Windows hammers are skipped; keep caps documented for the meta-test.
  // Two cycles still segfaulted Bun 1.3.14 on macOS Silicon under `--isolate`
  // after a green suite (balanced worker counts, exit 133). One cycle keeps a
  // real spawn/reset proof without the churn that trips the runtime.
  if (process.platform === "darwin") return 1;
  // Linux: short loop — eight cycles segfaulted with balanced counts on ubuntu CI.
  return 2;
}

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

async function waitForLiveWorker(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveStorageWorkerCount() > 0) return;
    await Bun.sleep(5);
  }
  throw new Error("no storage worker was ever spawned; this test would prove nothing");
}

test.skipIf(skipNonWindowsWorkerSpawn)("drain joins a fire-and-forget terminate before the isolate boundary", async () => {
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

test.skipIf(skipNonWindowsWorkerSpawn)("repeated Windows-style spawn/reset cycles leave no live workers", async () => {
  const cycles = workerChurnCyclesForIsolate();
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

test.skipIf(skipNonWindowsWorkerSpawn)("async beforeEach-style join between cycles leaves no live workers", async () => {
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

test("isolate worker churn stays platform-capped", () => {
  const cycles = workerChurnCyclesForIsolate();
  if (process.platform === "win32") expect(cycles).toBe(8);
  else if (process.platform === "darwin") expect(cycles).toBe(1);
  else expect(cycles).toBe(2);
});

test.skipIf(skipNonWindowsWorkerSpawn)("terminateStorageWorker is joinable and idempotent across callers", async () => {
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
