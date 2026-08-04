/**
 * One Worker-spawning case per file so `bun test --isolate` reclaims the realm
 * between storage Worker uses on Windows (Bun 1.3.14 join race).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  fetch,
  installPolicyApiHarness,
  seedArchived,
  startServer,
  stopPolicyServer,
  uninstallPolicyApiHarness,
  waitForJobIdle,
  type PolicyApiHarness,
  resetStorageCleanupPolicyJobForTestsAsync,
} from "./helpers/storage-policy-api";

let harness: PolicyApiHarness;

beforeEach(async () => {
  harness = await installPolicyApiHarness("ocx-api-storage-policy-run");
});

afterEach(async () => {
  await uninstallPolicyApiHarness(harness);
});

test("POST run starts job promptly; skipped/success land on GET", async () => {
  seedArchived(harness.isolatedCodexHome.path);
  const server = startServer(0);
  try {
    const skipped = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(skipped.status).toBe(200);
    const skipStart = await skipped.json();
    expect(skipStart.started).toBe(true);
    expect(skipStart.job.status).toBe("running");
    const skipDone = await waitForJobIdle(server.url, skipStart.job.startedAt);
    expect(skipDone.job.lastOutcome?.skipped).toBe("disabled");

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

    const ran = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
      method: "POST",
    });
    expect(ran.status).toBe(200);
    const ranStart = await ran.json();
    expect(ranStart.ok).toBe(true);
    expect(ranStart.started).toBe(true);
    expect(ranStart.job.status).toBe("running");
    expect(ranStart.removed).toBeUndefined();

    const ranDone = await waitForJobIdle(server.url, ranStart.job.startedAt);
    expect(ranDone.job.lastOutcome?.ok).toBe(true);
    expect(ranDone.job.lastOutcome?.removed).toBe(1);
    expect(ranDone.job.lastOutcome?.freedBytes).toBe(100);
    expect(ranDone.lastRun?.removed).toBe(1);
    expect(JSON.stringify(ranDone)).not.toContain(harness.isolatedCodexHome.path.replaceAll("\\", "\\\\"));
  } finally {
    await stopPolicyServer(server);
    await resetStorageCleanupPolicyJobForTestsAsync();
  }
}, { timeout: 30_000 });
