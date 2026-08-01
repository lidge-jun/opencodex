/**
 * Windows-style isolate teardown regression.
 *
 * Bun's `bun test --isolate` reclaims the file realm at the boundary. A storage
 * Bun Worker that is still exiting then trips
 * `panic: Internal assertion failure` with `workers_spawned(N)
 * workers_terminated(N-1)` on Windows and kills the whole run.
 *
 * These cases hammer the exact failure window: fire-and-forget terminate must
 * still be joinable by drain, and repeated spawn → reset cycles must leave the
 * registry empty before the next isolate boundary.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let isolatedCodexHome: IsolatedCodexHome | null = null;
let testDir = "";
let previousHome: string | undefined;

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
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

async function waitForLiveWorker(timeoutMs = 10_000): Promise<void> {
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

test("repeated Windows-style spawn/reset cycles leave no live workers", async () => {
  // Heavy churn is the Windows isolate panic window. Keep a short loop on
  // Linux/macOS so Bun 1.3.14 under `--isolate` is not stressed into a
  // segfault after workers_spawned === workers_terminated (seen on ubuntu CI).
  const cycles = process.platform === "win32" ? 8 : 2;
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
