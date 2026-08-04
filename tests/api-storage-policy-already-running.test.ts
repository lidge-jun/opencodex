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
} from "./helpers/storage-policy-api";

let harness: PolicyApiHarness;

beforeEach(async () => {
  harness = await installPolicyApiHarness("ocx-api-storage-policy-busy");
});

afterEach(async () => {
  await uninstallPolicyApiHarness(harness);
});

test("POST run rejects when a job is already running", async () => {
  setStorageCleanupPolicyJobTestHooks({ blockMs: 800 });
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

    const first = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.started).toBe(true);

    const second = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error).toBe("already_running");
    expect(secondBody.started).toBe(false);

    await waitForJobIdle(server.url, firstBody.job.startedAt);
  } finally {
    await stopPolicyServer(server);
    await resetStorageCleanupPolicyJobForTestsAsync();
  }
}, { timeout: 30_000 });
