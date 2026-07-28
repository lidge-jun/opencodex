import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  resetArchivedCleanupJobForTests,
  setArchivedCleanupJobTestHooks,
} from "../src/storage/cleanup-job";
import {
  resetStorageCleanupPolicyJobForTests,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import { stopStorageCleanupScheduler } from "../src/storage/policy-scheduler";

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

async function waitForJobIdle(
  serverUrl: URL,
  startedAt: number,
  timeoutMs = 15_000,
): Promise<{
  enabled: boolean;
  lastRun?: { removed: number };
  job: {
    status: string;
    lastOutcome?: {
      ok?: boolean;
      skipped?: string;
      removed?: number;
      freedBytes?: number;
      error?: string;
      deferred?: string;
    };
  };
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(new URL("/api/storage/cleanup-policy", serverUrl));
    const body = await res.json() as {
      enabled: boolean;
      lastRun?: { removed: number };
      job: {
        status: string;
        startedAt?: number;
        finishedAt?: number;
        lastOutcome?: {
          ok?: boolean;
          skipped?: string;
          removed?: number;
          freedBytes?: number;
          error?: string;
          deferred?: string;
        };
      };
    };
    if (
      body.job.status === "idle"
      && body.job.lastOutcome
      && (body.job.startedAt === startedAt || (body.job.finishedAt ?? 0) >= startedAt)
    ) {
      return body;
    }
    await Bun.sleep(50);
  }
  throw new Error("policy job did not become idle in time");
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-storage-policy-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-storage-policy-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  stopStorageCleanupScheduler();
  resetStorageCleanupPolicyJobForTests();
  resetArchivedCleanupJobForTests();
});

afterEach(() => {
  stopStorageCleanupScheduler();
  resetStorageCleanupPolicyJobForTests();
  setStorageCleanupPolicyJobTestHooks(null);
  resetArchivedCleanupJobForTests();
  setArchivedCleanupJobTestHooks(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
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
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
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
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
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
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
    }
  });

  test("POST run starts job promptly; skipped/success land on GET", async () => {
    seedArchived(isolatedCodexHome!.path);
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
      // Must not block on full cleanup — response should not embed removed counts.
      expect(ranStart.removed).toBeUndefined();

      const ranDone = await waitForJobIdle(server.url, ranStart.job.startedAt);
      expect(ranDone.job.lastOutcome?.ok).toBe(true);
      expect(ranDone.job.lastOutcome?.removed).toBe(1);
      expect(ranDone.job.lastOutcome?.freedBytes).toBe(100);
      expect(ranDone.lastRun?.removed).toBe(1);
      expect(JSON.stringify(ranDone)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));
    } finally {
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
    }
  }, { timeout: 30_000 });

  test("POST run rejects when a job is already running", async () => {
    setStorageCleanupPolicyJobTestHooks({ blockMs: 800 });
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
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
    }
  }, { timeout: 30_000 });

  test("blocked worker completion preserves concurrent policy PUT edits", async () => {
    // Long hold so a slow Windows CI worker spawn can load the enabled snapshot
    // before the concurrent PUT lands inside holdAfterLoadMs.
    const blockMs = 1_500;
    setStorageCleanupPolicyJobTestHooks({ blockMs });
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

      const run = await fetch(new URL("/api/storage/cleanup-policy/run", server.url), {
        method: "POST",
      });
      expect(run.status).toBe(200);
      const runStart = await run.json() as { started?: boolean; job?: { status: string; startedAt: number } };
      expect(runStart.started).toBe(true);
      expect(runStart.job?.status).toBe("running");

      // Status flips to running before the worker loads policy — wait for that marker,
      // then allow spawn+load margin before editing during the hold window.
      const editDeadline = Date.now() + 5_000;
      let sawRunning = false;
      while (Date.now() < editDeadline) {
        const peek = await fetch(new URL("/api/storage/cleanup-policy", server.url));
        const peekBody = await peek.json() as { job?: { status?: string } };
        if (peekBody.job?.status === "running") {
          sawRunning = true;
          break;
        }
        await Bun.sleep(20);
      }
      expect(sawRunning).toBe(true);
      await Bun.sleep(800);

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
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
    }
  }, { timeout: 30_000 });

  test("storage_mutation_busy clears inflight so a later policy run can start", async () => {
    setArchivedCleanupJobTestHooks({ blockMs: 600 });
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
      await server.stop(true);
      stopStorageCleanupScheduler();
      resetStorageCleanupPolicyJobForTests();
    }
  }, { timeout: 30_000 });
});
