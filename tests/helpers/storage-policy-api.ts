/**
 * Shared fixtures for storage cleanup-policy API tests.
 * Worker-spawning cases live in one-test-per-file suites so `bun test --isolate`
 * reclaims the realm between Worker uses on Windows.
 */
import { managementFetch as fetch } from "./management-auth";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { drainAndShutdown } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./isolated-codex-home";
import {
  resetArchivedCleanupJobForTests,
  setArchivedCleanupJobTestHooks,
} from "../../src/storage/cleanup-job";
import {
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../../src/storage/policy-job";
import { stopStorageCleanupScheduler } from "../../src/storage/policy-scheduler";
import { drainStorageWorkers } from "../../src/storage/worker-lifecycle";
import { removeTreeWithRetry } from "./remove-tree";

export function baseConfig(): OcxConfig {
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

export function seedArchived(codexHome: string): void {
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

export async function waitForJobIdle(
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

export type PolicyApiHarness = {
  testDir: string;
  isolatedCodexHome: IsolatedCodexHome;
  previousHome: string | undefined;
};

export async function installPolicyApiHarness(prefix: string): Promise<PolicyApiHarness> {
  const previousHome = process.env.OPENCODEX_HOME;
  // Join leftover Workers before allocating homes / mutating OPENCODEX_HOME.
  // Sync reset used to fire-and-forget terminate and race the next spawn under
  // `bun test --isolate`; a rejected reset after env mutation would also leak.
  stopStorageCleanupScheduler();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  resetArchivedCleanupJobForTests();

  let isolatedCodexHome: IsolatedCodexHome | undefined;
  let testDir: string | undefined;
  try {
    isolatedCodexHome = installIsolatedCodexHome(`${prefix}-codex-`);
    testDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(baseConfig());
    stopStorageCleanupScheduler();
    return { testDir, isolatedCodexHome, previousHome };
  } catch (error) {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    if (testDir) removeTreeWithRetry(testDir);
    throw error;
  }
}

export async function uninstallPolicyApiHarness(h: PolicyApiHarness): Promise<void> {
  try {
    stopStorageCleanupScheduler();
    await resetStorageCleanupPolicyJobForTestsAsync();
    setStorageCleanupPolicyJobTestHooks(null);
    setArchivedCleanupJobTestHooks(null);
    await drainStorageWorkers();
    resetArchivedCleanupJobForTests();
  } finally {
    if (h.previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = h.previousHome;
    h.isolatedCodexHome.restore();
    if (h.testDir) removeTreeWithRetry(h.testDir);
  }
}

/** Prefer over Bun.serve.stop — joins Workers and clears the policy scheduler. */
export async function stopPolicyServer(server: ReturnType<typeof startServer>): Promise<void> {
  await drainAndShutdown(server, 5_000);
}

export {
  fetch,
  startServer,
  setStorageCleanupPolicyJobTestHooks,
  setArchivedCleanupJobTestHooks,
  stopStorageCleanupScheduler,
  resetStorageCleanupPolicyJobForTestsAsync,
};
