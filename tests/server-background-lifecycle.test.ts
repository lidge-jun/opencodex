/**
 * Process-wide background work belongs to the set of live servers, not to the
 * most recently started listener. These tests exercise real listeners because
 * bind rollback and out-of-order stop are the ownership boundaries that failed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { getActiveMemoryWatchdog } from "../src/server/memory-watchdog";
import {
  getStorageCleanupPolicyJobState,
  requestStorageCleanupPolicyRun,
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import {
  normalizeStorageCleanupPolicy,
  writeStorageCleanupPolicyToConfig,
} from "../src/storage/policy";
import { stopStorageCleanupScheduler } from "../src/storage/policy-scheduler";
import {
  drainStorageWorkers,
  liveStorageWorkerCount,
} from "../src/storage/worker-lifecycle";
import type { OcxConfig } from "../src/types";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { managementFetch } from "./helpers/management-auth";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

type StartedServer = ReturnType<typeof startServer>;
type IntervalTimer = ReturnType<typeof setInterval>;
type TimeoutTimer = ReturnType<typeof setTimeout>;
type LoopKind = "memory-watchdog" | "state-store-sweeper" | "storage-policy-scheduler";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousHome = process.env.OPENCODEX_HOME;
let testDir = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers = new Set<StartedServer>();

function baseConfig(storageCleanupPolicy?: OcxConfig["storageCleanupPolicy"]): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    ...(storageCleanupPolicy ? { storageCleanupPolicy } : {}),
  } as OcxConfig;
}

function trackedStart(port = 0): StartedServer {
  const server = startServer(port);
  servers.add(server);
  return server;
}

async function stopTracked(server: StartedServer): Promise<void> {
  await server.stop(true);
  servers.delete(server);
}

function loopKindFromStack(stack: string): LoopKind | null {
  if (stack.includes("memory-watchdog.ts")) return "memory-watchdog";
  if (stack.includes("state-store-sweeper.ts")) return "state-store-sweeper";
  if (stack.includes("policy-scheduler.ts")) return "storage-policy-scheduler";
  return null;
}

function installBackgroundTimerProbe(): {
  active(kind: LoopKind): number;
  startupTimersStarted(): number;
  startupTimersCleared(): number;
  restore(): void;
} {
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const intervalKinds = new Map<IntervalTimer, LoopKind>();
  const clearedIntervals = new Set<IntervalTimer>();
  const startupTimers = new Set<TimeoutTimer>();
  const clearedTimeouts = new Set<TimeoutTimer>();

  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: ((...args: Parameters<typeof setInterval>) => {
      const timer = nativeSetInterval(...args);
      const kind = loopKindFromStack(new Error().stack ?? "");
      if (kind) intervalKinds.set(timer, kind);
      return timer;
    }) as typeof setInterval,
    writable: true,
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    value: ((timer: IntervalTimer) => {
      clearedIntervals.add(timer);
      nativeClearInterval(timer);
    }) as typeof clearInterval,
    writable: true,
  });
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      const policyStartup = (new Error().stack ?? "").includes("policy-scheduler.ts");
      // Hold the zero-delay startup callback so an out-of-order stop can prove
      // whether it cancelled shared work. The final stop still clears it.
      const timer = nativeSetTimeout(callback, policyStartup ? 60_000 : delay, ...args);
      if (policyStartup) startupTimers.add(timer);
      return timer;
    }) as typeof setTimeout,
    writable: true,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: ((timer: TimeoutTimer) => {
      clearedTimeouts.add(timer);
      nativeClearTimeout(timer);
    }) as typeof clearTimeout,
    writable: true,
  });

  return {
    active(kind) {
      return [...intervalKinds].filter(([timer, timerKind]) => (
        timerKind === kind && !clearedIntervals.has(timer)
      )).length;
    },
    startupTimersStarted() {
      return startupTimers.size;
    },
    startupTimersCleared() {
      return [...startupTimers].filter(timer => clearedTimeouts.has(timer)).length;
    },
    restore() {
      for (const timer of intervalKinds.keys()) nativeClearInterval(timer);
      for (const timer of startupTimers) nativeClearTimeout(timer);
      Object.defineProperty(globalThis, "setInterval", {
        configurable: true,
        value: nativeSetInterval,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearInterval", {
        configurable: true,
        value: nativeClearInterval,
        writable: true,
      });
      Object.defineProperty(globalThis, "setTimeout", {
        configurable: true,
        value: nativeSetTimeout,
        writable: true,
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        configurable: true,
        value: nativeClearTimeout,
        writable: true,
      });
    },
  };
}

function expectSharedLoopsActive(probe: ReturnType<typeof installBackgroundTimerProbe>): void {
  expect(getActiveMemoryWatchdog()).not.toBeNull();
  expect(probe.active("memory-watchdog")).toBe(1);
  expect(probe.active("state-store-sweeper")).toBe(1);
  expect(probe.active("storage-policy-scheduler")).toBe(1);
}

async function expectLivePolicySink(server: StartedServer): Promise<void> {
  const policy = normalizeStorageCleanupPolicy({
    enabled: true,
    trigger: { archivedBytesOver: 123 },
    target: { removeOldestPercent: 10 },
    schedule: "manual",
    mode: "quarantine",
  });
  writeStorageCleanupPolicyToConfig(policy);
  const response = await managementFetch(new URL("/api/storage/cleanup-policy", server.url));
  expect(response.status).toBe(200);
  expect((await response.json() as { trigger: { archivedBytesOver: number } }).trigger.archivedBytesOver)
    .toBe(123);
}

async function expectLivePolicyJobSink(server: StartedServer): Promise<void> {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-background-sink-");
  const policy = normalizeStorageCleanupPolicy({
    enabled: true,
    trigger: { archivedBytesOver: 456 },
    target: { removeOldestPercent: 10 },
    schedule: "manual",
    mode: "quarantine",
  });
  // saveConfig deliberately bypasses the direct policy sink. The in-process
  // job completion must be what refreshes the surviving server's live config.
  saveConfig(baseConfig(policy));
  setStorageCleanupPolicyJobTestHooks({ runInProcess: true });
  expect(requestStorageCleanupPolicyRun({
    reason: "manual",
    codexHome: isolatedCodexHome.path,
  }).accepted).toBe(true);
  const deadline = Date.now() + 5_000;
  while (getStorageCleanupPolicyJobState().status !== "idle" && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(getStorageCleanupPolicyJobState().status).toBe("idle");
  const response = await managementFetch(new URL("/api/storage/cleanup-policy", server.url));
  expect(response.status).toBe(200);
  expect((await response.json() as { trigger: { archivedBytesOver: number } }).trigger.archivedBytesOver)
    .toBe(456);
}

function seedArchived(codexHome: string): void {
  mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
  const archived = join(codexHome, "archived_sessions", "rollout-old.jsonl");
  writeFileSync(archived, "old-session");
  utimesSync(archived, new Date("2026-01-01"), new Date("2026-01-01"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)");
  db.exec("INSERT INTO threads VALUES ('old', 'archived_sessions/rollout-old.jsonl', 1)");
  db.close();
}

async function waitForLiveStorageWorker(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveStorageWorkerCount() > 0) return;
    await Bun.sleep(5);
  }
  throw new Error("startup policy never spawned a storage Worker");
}

beforeEach(async () => {
  stopStorageCleanupScheduler();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  testDir = mkdtempSync(join(tmpdir(), "ocx-server-background-lifecycle-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_API_AUTH_TOKEN = "server-background-test-token";
});

afterEach(async () => {
  for (const server of [...servers]) {
    try { await server.stop(true); } catch { /* assertion failure cleanup */ }
    servers.delete(server);
  }
  stopStorageCleanupScheduler();
  await resetStorageCleanupPolicyJobForTestsAsync();
  await drainStorageWorkers();
  setStorageCleanupPolicyJobTestHooks(null);
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("server background lifecycle", () => {
  test("stopping the newer server preserves the older server's process-wide work", async () => {
    saveConfig(baseConfig());
    const probe = installBackgroundTimerProbe();
    try {
      const older = trackedStart();
      const newer = trackedStart();
      expect(probe.startupTimersStarted()).toBe(1);

      await stopTracked(newer);

      expect((await fetch(new URL("/healthz", older.url))).status).toBe(200);
      expectSharedLoopsActive(probe);
      expect(probe.startupTimersCleared()).toBe(0);
      await expectLivePolicySink(older);
      await expectLivePolicyJobSink(older);

      await stopTracked(older);
      expect(getActiveMemoryWatchdog()).toBeNull();
      expect(probe.active("memory-watchdog")).toBe(0);
      expect(probe.active("state-store-sweeper")).toBe(0);
      expect(probe.active("storage-policy-scheduler")).toBe(0);
      expect(probe.startupTimersCleared()).toBe(1);
    } finally {
      probe.restore();
    }
    // Two real servers, a policy job driven to idle, and both shutdowns: that whole
    // sequence is the assertion that one server's stop leaves the other's
    // process-wide work alone, and it measured 5.4s against Bun's 5s default.
  }, SERVER_BUDGET_MS);

  test("a newer bind failure preserves the older server's process-wide work", async () => {
    saveConfig(baseConfig());
    const probe = installBackgroundTimerProbe();
    try {
      const older = trackedStart();
      expect(() => startServer(older.port)).toThrow();

      expect((await fetch(new URL("/healthz", older.url))).status).toBe(200);
      expectSharedLoopsActive(probe);
      expect(probe.startupTimersCleared()).toBe(0);
      await expectLivePolicySink(older);
      await expectLivePolicyJobSink(older);

      await stopTracked(older);
      expect(getActiveMemoryWatchdog()).toBeNull();
      expect(probe.active("memory-watchdog")).toBe(0);
      expect(probe.active("state-store-sweeper")).toBe(0);
      expect(probe.active("storage-policy-scheduler")).toBe(0);
      expect(probe.startupTimersCleared()).toBe(1);
    } finally {
      probe.restore();
    }
  });

  test("last-server stop aborts and drains a startup policy Worker", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ocx-server-background-worker-");
    seedArchived(isolatedCodexHome.path);
    setStorageCleanupPolicyJobTestHooks({ blockMs: 5_000 });
    saveConfig(baseConfig(normalizeStorageCleanupPolicy({
      enabled: true,
      trigger: { archivedBytesOver: 0 },
      target: { removeOldestPercent: 50 },
      schedule: "startup",
      mode: "quarantine",
    })));

    const server = trackedStart();
    await waitForLiveStorageWorker();
    expect(liveStorageWorkerCount()).toBe(1);

    await stopTracked(server);

    expect(liveStorageWorkerCount()).toBe(0);
    expect(getStorageCleanupPolicyJobState()).toMatchObject({
      status: "idle",
      lastError: "aborted",
    });
  }, { timeout: 30_000 });
});
