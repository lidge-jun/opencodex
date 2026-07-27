/**
 * Regression: cleanup and restore must not mutate CODEX_HOME concurrently.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import {
  resetArchivedCleanupJobForTests,
  setArchivedCleanupJobTestHooks,
} from "../src/storage/cleanup-job";
import {
  resetRestoreTrashJobForTests,
  runRestoreTrashEntryJob,
  setRestoreTrashJobTestHooks,
} from "../src/storage/restore-job";
import {
  resetStorageMutationCoordinatorForTests,
  runPolicyStorageMutation,
} from "../src/storage/storage-mutation-coordinator";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

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

function seedArchivedPair(codexHome: string): void {
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

function threadCount(codexHome: string): number {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  const row = db.query("SELECT COUNT(*) AS c FROM threads").get() as { c: number };
  db.close();
  return row.c;
}

function trashStageCount(codexHome: string): number {
  const trashRoot = join(codexHome, ".trash");
  if (!existsSync(trashRoot)) return 0;
  return readdirSync(trashRoot).filter(name => !name.startsWith(".")).length;
}

async function previewDigest(serverUrl: string, percent: number): Promise<{ digest: string; count: number }> {
  const res = await fetch(new URL("/api/storage/cleanup/preview", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ percent }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { digest: body.digest, count: body.count };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-storage-mutation-race-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-storage-mutation-race-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  resetRestoreTrashJobForTests();
  resetArchivedCleanupJobForTests();
  resetStorageMutationCoordinatorForTests();
});

afterEach(() => {
  resetRestoreTrashJobForTests();
  resetArchivedCleanupJobForTests();
  resetStorageMutationCoordinatorForTests();
  setRestoreTrashJobTestHooks(null);
  setArchivedCleanupJobTestHooks(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("storage mutation coordinator", () => {
  test("runPolicyStorageMutation returns storage_mutation_busy when restore holds the slot", async () => {
    const home = isolatedCodexHome!.path;
    setRestoreTrashJobTestHooks({ blockMs: 400, runInProcess: true });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      const trashId = cleanup.trashDir as string;

      const restorePromise = runRestoreTrashEntryJob(trashId, { codexHome: home });
      await Bun.sleep(50);

      const policyAttempt = await runPolicyStorageMutation(home, async () => ({ ok: true as const }));
      expect(policyAttempt).toEqual({ ok: false, error: "storage_mutation_busy" });

      const restoreResult = await restorePromise;
      expect(restoreResult.ok).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("cleanup quarantine and permanent are rejected while restore holds slot after file moves", async () => {
    const home = isolatedCodexHome!.path;
    const holdMs = 2500;
    setRestoreTrashJobTestHooks({
      restoreTest: { holdAfterFileMovesMs: holdMs },
    });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      const trashId = cleanup.trashDir as string;
      const trashStage = join(home, trashId);
      expect(existsSync(trashStage)).toBe(true);

      const remainingPreview = await previewDigest(server.url, 50);
      expect(remainingPreview.count).toBe(1);

      const restorePromise = fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trashId }),
      });

      const restoredPath = join(home, "archived_sessions", "rollout-old.jsonl");
      const movedDeadline = Date.now() + 8000;
      while (!existsSync(restoredPath) && Date.now() < movedDeadline) {
        await Bun.sleep(20);
      }
      expect(existsSync(restoredPath)).toBe(true);
      expect(existsSync(join(trashStage, "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(trashStage, "restore-pending.json"))).toBe(true);

      const quarantineDuring = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: 50,
          mode: "quarantine",
          digest: remainingPreview.digest,
        }),
      });
      expect(quarantineDuring.status).toBe(409);
      expect((await quarantineDuring.json()).error).toBe("storage_mutation_busy");
      expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
      expect(trashStageCount(home)).toBe(1);

      const previewPermanent = await previewDigest(server.url, 100);
      const permanentDuring = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: 100,
          mode: "permanent",
          digest: previewPermanent.digest,
        }),
      });
      expect(permanentDuring.status).toBe(409);
      expect((await permanentDuring.json()).error).toBe("storage_mutation_busy");

      const restoreRes = await restorePromise;
      expect(restoreRes.status).toBe(200);
      const restored = await restoreRes.json();
      expect(restored.ok).toBe(true);
      expect(existsSync(restoredPath)).toBe(true);
      expect(threadCount(home)).toBe(2);
      expect(readFileSync(restoredPath, "utf8")).toBe("o".repeat(100));
    } finally {
      await server.stop(true);
    }
  }, { timeout: 45_000 });

  test("restore is rejected while cleanup holds the shared mutation slot", async () => {
    const home = isolatedCodexHome!.path;
    const blockMs = 1200;
    setArchivedCleanupJobTestHooks({ blockMs });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupPromise = fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });

      await Bun.sleep(80);

      const restoreAttempt = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ".trash/never" }),
      });
      expect(restoreAttempt.status).toBe(409);
      expect((await restoreAttempt.json()).error).toBe("storage_mutation_busy");
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
      expect(trashStageCount(home)).toBe(0);

      const cleanupRes = await cleanupPromise;
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      expect(cleanup.ok).toBe(true);
      expect(cleanup.trashDir).toMatch(/^\.trash\//);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
      expect(threadCount(home)).toBe(1);
    } finally {
      await server.stop(true);
    }
  }, { timeout: 30_000 });

  test("second restore while first is in flight returns storage_mutation_busy", async () => {
    const home = isolatedCodexHome!.path;
    setRestoreTrashJobTestHooks({ blockMs: 800, runInProcess: true });
    seedArchivedPair(home);

    const server = startServer(0);
    try {
      const preview = await previewDigest(server.url, 50);
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      const cleanup = await cleanupRes.json();
      const trashId = cleanup.trashDir as string;

      const first = fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trashId }),
      });
      await Bun.sleep(50);
      const second = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trashId }),
      });
      expect(second.status).toBe(409);
      expect((await second.json()).error).toBe("storage_mutation_busy");

      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  }, { timeout: 30_000 });
});
