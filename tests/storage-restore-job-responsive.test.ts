/**
 * Regression: a blocked restore Worker must not stall /healthz or an active
 * streaming response on the proxy event loop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { drainAndShutdown } from "../src/server/lifecycle";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { stopStorageCleanupScheduler } from "../src/storage/policy-scheduler";
import {
  resetRestoreTrashJobForTestsAsync,
  setRestoreTrashJobTestHooks,
} from "../src/storage/restore-job";
import { drainStorageWorkers } from "../src/storage/worker-lifecycle";

let testDir = "";
let previousHome: string | undefined;
let previousCleanupTestHooks: string | undefined;
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
  utimesSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  db.exec(`INSERT INTO threads VALUES ('told','archived_sessions/rollout-old.jsonl',1)`);
  db.close();
}

beforeEach(async () => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCleanupTestHooks = process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
  process.env.OPENCODEX_CLEANUP_TEST_HOOKS = "1";
  // Join leftover Workers before allocating homes / mutating OPENCODEX_HOME.
  stopStorageCleanupScheduler();
  await resetRestoreTrashJobForTestsAsync();
  await drainStorageWorkers();
  isolatedCodexHome = installIsolatedCodexHome("ocx-restore-job-responsive-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-restore-job-responsive-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  stopStorageCleanupScheduler();
});

afterEach(async () => {
  stopStorageCleanupScheduler();
  await resetRestoreTrashJobForTestsAsync();
  await drainStorageWorkers();
  setRestoreTrashJobTestHooks(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCleanupTestHooks === undefined) delete process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
  else process.env.OPENCODEX_CLEANUP_TEST_HOOKS = previousCleanupTestHooks;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("storage trash restore job responsiveness", () => {
  async function withTestStreamRoute(
    setup: () => void,
    assert: (serverUrl: string) => Promise<void>,
  ): Promise<void> {
    const previousHooksEnv = process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
    setup();
    const server = startServer(0);
    try {
      await assert(server.url.toString());
    } finally {
      try {
        await drainAndShutdown(server, 5_000);
      } finally {
        setRestoreTrashJobTestHooks(null);
        if (previousHooksEnv === undefined) delete process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
        else process.env.OPENCODEX_CLEANUP_TEST_HOOKS = previousHooksEnv;
      }
    }
  }

  test("test-stream route is absent without OPENCODEX_CLEANUP_TEST_HOOKS", async () => {
    await withTestStreamRoute(
      () => {
        delete process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
        setRestoreTrashJobTestHooks({ enableTestStream: true });
      },
      async (serverUrl) => {
        const res = await fetch(new URL("/api/storage/trash/restore/test-stream", serverUrl));
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type") ?? "").toContain("application/json");
        expect(await res.json()).toEqual({ error: "not_available" });
      },
    );
  });

  test("test-stream route returns JSON 404 when hooks are enabled but stream is null", async () => {
    await withTestStreamRoute(
      () => {
        process.env.OPENCODEX_CLEANUP_TEST_HOOKS = "1";
        // enableTestStream omitted → getRestoreTrashTestStreamResponse() returns null
        setRestoreTrashJobTestHooks({ blockMs: 0 });
      },
      async (serverUrl) => {
        const res = await fetch(new URL("/api/storage/trash/restore/test-stream", serverUrl));
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type") ?? "").toContain("application/json");
        expect(await res.json()).toEqual({ error: "not_available" });
      },
    );
  });

  test("test-stream route serves the enabled hook stream", async () => {
    await withTestStreamRoute(
      () => {
        process.env.OPENCODEX_CLEANUP_TEST_HOOKS = "1";
        setRestoreTrashJobTestHooks({ enableTestStream: true });
      },
      async (serverUrl) => {
        const res = await fetch(new URL("/api/storage/trash/restore/test-stream", serverUrl));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/plain");
        const body = await res.text();
        expect(body).toContain("chunk-0");
        expect(body).toContain("chunk-7");
      },
    );
  }, { timeout: 10_000 });

  test("blocked worker keeps /healthz and streaming response responsive", async () => {
    const blockMs = 1200;
    setRestoreTrashJobTestHooks({ blockMs, enableTestStream: true });
    seedArchived(isolatedCodexHome!.path);

    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100 }),
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json();
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100, mode: "quarantine", digest: preview.digest }),
      });
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      expect(cleanup.trashDir).toMatch(/^\.trash\//);

      const restoreStarted = Date.now();
      const restorePromise = fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: cleanup.trashDir }),
      });

      const streamPromise = (async () => {
        const res = await fetch(new URL("/api/storage/trash/restore/test-stream", server.url));
        expect(res.ok).toBe(true);
        return await res.text();
      })();

      const healthSamples: number[] = [];
      for (let i = 0; i < 6; i++) {
        const t0 = Date.now();
        const health = await fetch(new URL("/healthz", server.url));
        expect(health.status).toBe(200);
        const elapsed = Date.now() - t0;
        if (i > 0) healthSamples.push(elapsed);
        await Bun.sleep(40);
      }

      const streamText = await streamPromise;
      expect(streamText.split("\n").filter(Boolean).length).toBe(8);

      const maxHealthMs = Math.floor(blockMs / 3);
      for (const sample of healthSamples) {
        expect(sample).toBeLessThan(maxHealthMs);
      }

      const restoreRes = await restorePromise;
      expect(restoreRes.status).toBe(200);
      const restored = await restoreRes.json();
      expect(restored.ok).toBe(true);
      expect(Date.now() - restoreStarted).toBeGreaterThanOrEqual(blockMs - 100);
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    } finally {
      await drainAndShutdown(server, 5_000);
      await resetRestoreTrashJobForTestsAsync();
    }
  }, { timeout: 30_000 });
});
