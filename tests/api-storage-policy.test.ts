/**
 * Non-Worker storage cleanup-policy API cases (GET/PUT).
 * Worker-spawning cases live in one-test-per-file suites beside this one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetch,
  installPolicyApiHarness,
  startServer,
  stopPolicyServer,
  uninstallPolicyApiHarness,
  type PolicyApiHarness,
  resetStorageCleanupPolicyJobForTestsAsync,
} from "./helpers/storage-policy-api";

let harness: PolicyApiHarness;

beforeEach(async () => {
  harness = await installPolicyApiHarness("ocx-api-storage-policy");
});

afterEach(async () => {
  await uninstallPolicyApiHarness(harness);
});

describe("storage cleanup policy API", () => {
  test("GET returns default-off policy without enabling", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup-policy", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
      expect(body.mode).toBe("quarantine");
      expect(body.schedule).toBe("manual");
      expect(body.trigger.archivedBytesOver).toBeGreaterThan(0);
      expect(body.job.status).toBe("idle");
    } finally {
      await stopPolicyServer(server);
      await resetStorageCleanupPolicyJobForTestsAsync();
    }
  });

  test("PUT persists policy and never enables when enabled omitted", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup-policy", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trigger: { archivedBytesOver: 1024 },
          target: { removeOldestPercent: 40 },
          schedule: "daily",
          mode: "quarantine",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.policy.enabled).toBe(false);
      expect(body.policy.trigger.archivedBytesOver).toBe(1024);
      expect(body.policy.target.removeOldestPercent).toBe(40);
      expect(body.policy.schedule).toBe("daily");

      const get = await fetch(new URL("/api/storage/cleanup-policy", server.url));
      const again = await get.json();
      expect(again.enabled).toBe(false);
      expect(again.trigger.archivedBytesOver).toBe(1024);
    } finally {
      await stopPolicyServer(server);
      await resetStorageCleanupPolicyJobForTestsAsync();
    }
  });

  test("PUT rejects invalid target", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup-policy", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          target: { reduceToBytes: 1, removeOldestPercent: 10 },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("target");
    } finally {
      await stopPolicyServer(server);
      await resetStorageCleanupPolicyJobForTestsAsync();
    }
  });
});
