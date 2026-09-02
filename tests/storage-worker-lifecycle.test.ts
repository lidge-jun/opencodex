/**
 * The storage workers must be GONE, not merely asked to stop, by the time a
 * test file's realm is torn down.
 *
 * `bun test --isolate` reclaims the realm at the file boundary. A Bun Worker
 * still exiting at that instant trips an internal assertion on Windows and
 * kills the entire run — no `(fail)` line, just
 * `panic(...): Internal assertion failure` with `workers_spawned(N)
 * workers_terminated(N-1)` in the header. That crashed `dev` and three PRs at
 * the `api-storage-policy` → `api-storage` boundary, the only place policy
 * workers are spawned.
 *
 * These assertions are the invariant the fix rests on: after a run settles, and
 * after a reset, nothing is left tracked.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  requestStorageCleanupPolicyRun,
  getStorageCleanupPolicyJobState,
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import {
  drainStorageWorkers,
  liveStorageWorkerCount,
  registerStorageWorker,
  terminateStorageWorker,
  tryReserveStorageWorker,
  withStorageWorkerSpawnGate,
} from "../src/storage/worker-lifecycle";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
  isolatedCodexHome = installIsolatedCodexHome("ocx-worker-lifecycle-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-worker-lifecycle-"));
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

async function waitForIdle(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getStorageCleanupPolicyJobState().status === "idle") return;
    await Bun.sleep(25);
  }
  throw new Error("policy job did not settle");
}

/** Guards against a vacuous pass: assert we really did spawn a worker. */
async function waitForLiveWorker(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveStorageWorkerCount() > 0) return;
    await Bun.sleep(5);
  }
  throw new Error("no storage worker was ever spawned; this test would prove nothing");
}

test("a settled policy worker leaves nothing alive behind it", async () => {
  seedArchived(isolatedCodexHome!.path);
  const started = requestStorageCleanupPolicyRun({
    reason: "manual",
    codexHome: isolatedCodexHome!.path,
  });

  expect(started.accepted).toBe(true);

  await waitForLiveWorker();
  await waitForIdle();
  // The run reached a terminal state, so its worker thread must already be
  // reclaimed — not merely sent a terminate() that has yet to land.
  expect(liveStorageWorkerCount()).toBe(0);
}, { timeout: 30_000 });

test("storage worker reservation 17 rejects before enqueue while the first 16 spawn serially and drain", async () => {
  const reservations = Array.from({ length: 16 }, () => tryReserveStorageWorker());
  expect(reservations.every(Boolean)).toBe(true);
  expect(tryReserveStorageWorker()).toBeNull();
  let active = 0;
  let peak = 0;
  await Promise.all(reservations.map((reservation, index) => withStorageWorkerSpawnGate(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(index === 0 ? 2 : 0);
    active -= 1;
    reservation?.release();
  })));
  expect(peak).toBe(1);
});

test("reset drains a worker that is still blocked mid-run", async () => {
  // A worker held inside its run is exactly the state that outlived the file
  // boundary in CI, so tear it down while it is still busy.
  setStorageCleanupPolicyJobTestHooks({ blockMs: 1_500 });
  seedArchived(isolatedCodexHome!.path);
  const started = requestStorageCleanupPolicyRun({
    reason: "manual",
    codexHome: isolatedCodexHome!.path,
  });
  expect(started.accepted).toBe(true);

  await waitForLiveWorker();
  await resetStorageCleanupPolicyJobForTestsAsync();
  expect(liveStorageWorkerCount()).toBe(0);
}, { timeout: 30_000 });

test("close that wins before OS-join settle does not throw a late timeout", async () => {
  // On win32/darwin the settle sleep (250ms) outlasts a short timeoutMs. If the
  // timer stays armed across that gap, close can win and still throw.
  const closeListeners: Array<() => void> = [];
  const worker = {
    terminate() {},
    addEventListener(type: string, fn: () => void) {
      if (type === "close") closeListeners.push(fn);
    },
  } as unknown as Worker;
  registerStorageWorker(worker);
  expect(liveStorageWorkerCount()).toBe(1);
  expect(closeListeners.length).toBe(1);
  const done = terminateStorageWorker(worker, 80);
  for (const fn of closeListeners) fn();
  await expect(done).resolves.toBeUndefined();
  expect(liveStorageWorkerCount()).toBe(0);
}, { timeout: 10_000 });
