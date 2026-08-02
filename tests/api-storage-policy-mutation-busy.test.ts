/**
 * One Worker-spawning case per file so `bun test --isolate` reclaims the realm
 * between storage Worker uses on Windows (Bun 1.3.14 join race).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  fetch,
  installPolicyApiHarness,
  seedArchived,
  setArchivedCleanupJobTestHooks,
  startServer,
  stopPolicyServer,
  uninstallPolicyApiHarness,
  waitForJobIdle,
  type PolicyApiHarness,
  resetStorageCleanupPolicyJobForTestsAsync,
} from "./helpers/storage-policy-api";

let harness: PolicyApiHarness;

beforeEach(async () => {
  harness = await installPolicyApiHarness("ocx-api-storage-policy-mut-busy");
});

afterEach(async () => {
  await uninstallPolicyApiHarness(harness);
});

test("storage_mutation_busy clears inflight so a later policy run can start", async () => {
  setArchivedCleanupJobTestHooks({ blockMs: 600 });
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

    const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ percent: 50 }),
    });
    const preview = await previewRes.json() as { digest: string };
    const cleanupPromise = fetch(new URL("/api/storage/cleanup", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
    });
    await Bun.sleep(50);

    const blockedRun = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(blockedRun.status).toBe(200);
    const blockedStart = await blockedRun.json() as { job: { startedAt: number } };
    const blockedDone = await waitForJobIdle(server.url, blockedStart.job.startedAt);
    expect(blockedDone.job.lastOutcome?.ok).toBe(false);
    expect(blockedDone.job.lastOutcome?.error).toBe("storage_mutation_busy");

    await cleanupPromise;

    const retryRun = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(retryRun.status).toBe(200);
    const retryStart = await retryRun.json() as { started?: boolean; job: { startedAt: number } };
    expect(retryStart.started).toBe(true);
    const retryDone = await waitForJobIdle(server.url, retryStart.job.startedAt);
    expect(retryDone.job.lastOutcome?.ok).toBe(true);
    expect(retryDone.job.lastOutcome?.skipped).toBeUndefined();
    expect(retryDone.job.lastOutcome?.removed).toBe(1);
  } finally {
    await stopPolicyServer(server);
    await resetStorageCleanupPolicyJobForTestsAsync();
  }
}, { timeout: 30_000 });
