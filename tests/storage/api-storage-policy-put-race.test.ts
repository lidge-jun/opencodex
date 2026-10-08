/**
 * One Worker-spawning case per file so `bun test --isolate` reclaims the realm
 * between storage Worker uses on Windows (Bun 1.3.14 join race).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  fetch,
  installPolicyApiHarness,
  seedArchived,
  setStorageCleanupPolicyJobTestHooks,
  startServer,
  stopPolicyServer,
  uninstallPolicyApiHarness,
  waitForJobIdle,
  type PolicyApiHarness,
  resetStorageCleanupPolicyJobForTestsAsync,
} from "../helpers/storage-policy-api";

let harness: PolicyApiHarness;

beforeEach(async () => {
  harness = await installPolicyApiHarness("ocx-api-storage-policy-put-race");
});

afterEach(async () => {
  if (harness) await uninstallPolicyApiHarness(harness);
});

test("blocked worker completion preserves concurrent policy PUT edits", async () => {
  const loadGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  setStorageCleanupPolicyJobTestHooks({ workerLoadGate: loadGate });
  seedArchived(harness.isolatedCodexHome.path);
  const server = startServer(0);
  try {
    await fetch(new URL("/api/storage/cleanup-policy", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        trigger: { archivedBytesOver: 50 },
        target: { removeOldestPercent: 50 },
        schedule: "manual",
        mode: "quarantine",
      }),
    });

    const run = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(run.status).toBe(200);
    const runStart = await run.json() as { started?: boolean; job?: { status: string; startedAt: number } };
    expect(runStart.started).toBe(true);
    expect(runStart.job?.status).toBe("running");

    // Running means accepted, not that the Worker has read the enabled policy.
    // Wait for that exact point and hold completion until the PUT has committed.
    const loadDeadline = Date.now() + 10_000;
    while (Atomics.load(loadGate, 0) !== 1 && Date.now() < loadDeadline) await Bun.sleep(20);
    expect(Atomics.load(loadGate, 0)).toBe(1);

    const put = await fetch(new URL("/api/storage/cleanup-policy", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        trigger: { archivedBytesOver: 1234 },
        target: { reduceToBytes: 42 },
        schedule: "daily",
        mode: "permanent",
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as { ok?: boolean; policy?: { enabled?: boolean } };
    expect(putBody.ok).toBe(true);
    expect(putBody.policy?.enabled).toBe(false);
    expect(Atomics.load(loadGate, 0)).toBe(1);
    Atomics.store(loadGate, 0, 2);
    Atomics.notify(loadGate, 0);

    const done = await waitForJobIdle(server.url, runStart.job!.startedAt);
    expect(done.job.lastOutcome?.ok).toBe(true);
    expect(done.job.lastOutcome?.skipped).toBeUndefined();
    expect(done.job.lastOutcome?.removed).toBe(1);
    expect(done.enabled).toBe(false);
    expect(done.lastRun?.removed).toBe(1);

    const final = await fetch(new URL("/api/storage/cleanup-policy", server.url));
    const body = await final.json() as {
      enabled: boolean;
      trigger: { archivedBytesOver: number };
      target: { reduceToBytes?: number; removeOldestPercent?: number };
      schedule: string;
      mode: string;
      lastRun?: { removed: number; freedBytes: number; at: number };
      nextRun?: number;
    };
    expect(body.enabled).toBe(false);
    expect(body.trigger.archivedBytesOver).toBe(1234);
    expect(body.target).toEqual({ reduceToBytes: 42 });
    expect(body.schedule).toBe("daily");
    expect(body.mode).toBe("permanent");
    expect(body.lastRun?.removed).toBe(1);
    expect(body.lastRun?.freedBytes).toBe(100);
    expect(typeof body.lastRun?.at).toBe("number");
    expect(typeof body.nextRun).toBe("number");
  } finally {
    Atomics.store(loadGate, 0, 2);
    Atomics.notify(loadGate, 0);
    await stopPolicyServer(server);
    await resetStorageCleanupPolicyJobForTestsAsync();
  }
}, { timeout: 30_000 });
