/**
 * Regression: a blocked cleanup Worker must not stall /healthz or an active
 * streaming response on the proxy event loop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { drainAndShutdown } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import { stopStorageCleanupScheduler } from "../src/storage/policy-scheduler";
import { drainStorageWorkers } from "../src/storage/worker-lifecycle";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function seedArchived(codexHome: string): void {
  mkdirSync(join(codexHome, "archived_sessions"));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), "o".repeat(100));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), "n".repeat(200));
  utimesSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), new Date("2026-06-01"), new Date("2026-06-01"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  db.exec(`INSERT INTO threads VALUES
    ('told','archived_sessions/rollout-old.jsonl',1),
    ('tnew','archived_sessions/rollout-new.jsonl',1)
  `);
  db.close();
}

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  // Join leftover Workers before allocating homes / mutating OPENCODEX_HOME.
  stopStorageCleanupScheduler();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  isolatedCodexHome = installIsolatedCodexHome("ocx-policy-job-responsive-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-policy-job-responsive-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  stopStorageCleanupScheduler();
});

afterEach(async () => {
  stopStorageCleanupScheduler();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  setStorageCleanupPolicyJobTestHooks(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("storage cleanup policy job responsiveness", () => {
  test("blocked worker keeps /healthz and streaming response responsive", async () => {
    const blockMs = 1200;
    setStorageCleanupPolicyJobTestHooks({ blockMs, enableTestStream: true });
    seedArchived(isolatedCodexHome!.path);

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

      const runStarted = Date.now();
      const runRes = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
        method: "POST",
      });
      const runBody = await runRes.json() as { started?: boolean; job?: { status: string; startedAt: number } };
      expect(runRes.status).toBe(200);
      expect(runBody.started).toBe(true);
      expect(runBody.job?.status).toBe("running");
      // POST itself must return well before the worker block finishes.
      expect(Date.now() - runStarted).toBeLessThan(blockMs / 2);

      const streamPromise = (async () => {
        const res = await fetch(new URL("/api/storage/cleanup-policy/test-stream", server.url));
        expect(res.ok).toBe(true);
        return await res.text();
      })();

      const healthSamples: number[] = [];
      for (let i = 0; i < 6; i++) {
        const t0 = Date.now();
        const health = await fetch(new URL("/healthz", server.url));
        expect(health.status).toBe(200);
        healthSamples.push(Date.now() - t0);
        await Bun.sleep(40);
      }

      const streamText = await streamPromise;
      expect(streamText.split("\n").filter(Boolean).length).toBe(8);

      // Every health probe during the blocked worker window should stay snappy.
      // Relative to blockMs: a main-thread block would push samples toward blockMs itself.
      const maxHealthMs = Math.floor(blockMs / 3); // 400ms at blockMs=1200
      for (const sample of healthSamples) {
        expect(sample).toBeLessThan(maxHealthMs);
      }

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const got = await fetch(new URL("/api/storage/cleanup-policy", server.url));
        const body = await got.json() as { job: { status: string; startedAt?: number } };
        if (body.job.status === "idle" && body.job.startedAt === runBody.job?.startedAt) break;
        await Bun.sleep(50);
      }
    } finally {
      await drainAndShutdown(server, 5_000);
      await resetStorageCleanupPolicyJobForTestsAsync();
    }
  }, { timeout: 30_000 });
});
