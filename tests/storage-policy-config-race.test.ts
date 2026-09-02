import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  setPersistedConfigMutationBeforeCommitForTests,
} from "../src/config";
import { computeNextRun, runStorageCleanupPolicy } from "../src/storage/policy";
import {
  getStorageCleanupPolicyJobState,
  requestStorageCleanupPolicyRun,
  resetStorageCleanupPolicyJobForTestsAsync,
  setStorageCleanupPolicyJobTestHooks,
} from "../src/storage/policy-job";
import type { OcxConfig, StorageCleanupPolicy } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let configHome = "";
let previousHome: string | undefined;

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
    apiKeys: [{ id: "revoked", name: "Revoked", key: "ocx_revoked", createdAt: "2026-01-01" }],
  } as OcxConfig;
}

beforeEach(async () => {
  await resetStorageCleanupPolicyJobForTestsAsync();
  setStorageCleanupPolicyJobTestHooks(null);
  previousHome = process.env.OPENCODEX_HOME;
  configHome = mkdtempSync(join(tmpdir(), "ocx-storage-policy-config-race-"));
  process.env.OPENCODEX_HOME = configHome;
  setPersistedConfigMutationBeforeCommitForTests(null);
  saveConfig(baseConfig());
});

afterEach(async () => {
  await resetStorageCleanupPolicyJobForTestsAsync();
  setStorageCleanupPolicyJobTestHooks(null);
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (configHome) removeTreeWithRetry(configHome);
  configHome = "";
});

test("run metadata commit rebases concurrent policy and unrelated config writes", () => {
  const now = 1_800_000_000_000;
  const initialPolicy: StorageCleanupPolicy = {
    enabled: true,
    trigger: { archivedBytesOver: 1234 },
    target: { removeOldestPercent: 40 },
    schedule: "manual",
    mode: "quarantine",
  };
  const initial = loadConfig();
  initial.storageCleanupPolicy = initialPolicy;
  saveConfig(initial);

  let injected = false;
  setPersistedConfigMutationBeforeCommitForTests(() => {
    injected = true;
    const concurrent = loadConfig();
    concurrent.apiKeys = [];
    concurrent.storageCleanupPolicy = {
      enabled: false,
      trigger: { archivedBytesOver: 9999 },
      target: { reduceToBytes: 42 },
      schedule: "daily",
      mode: "permanent",
    };
    saveConfig(concurrent);
  });

  const result = runStorageCleanupPolicy({
    reason: "manual",
    force: true,
    now,
    codexHome: configHome,
  });
  expect(result.skipped).toBe("under_threshold");

  const persisted = loadConfig();
  expect(injected).toBe(true);
  expect(persisted.apiKeys).toEqual([]);
  expect(persisted.storageCleanupPolicy).toEqual({
    enabled: false,
    trigger: { archivedBytesOver: 9999 },
    target: { reduceToBytes: 42 },
    schedule: "daily",
    mode: "permanent",
    nextRun: computeNextRun("daily", now),
  });
  expect(result.policy).toEqual(persisted.storageCleanupPolicy);
});

test("job outcome keeps successful cleanup when metadata cannot persist", async () => {
  const initial = loadConfig();
  initial.storageCleanupPolicy = {
    enabled: true,
    trigger: { archivedBytesOver: 0 },
    target: { removeOldestPercent: 100 },
    schedule: "daily",
    mode: "quarantine",
  };
  saveConfig(initial);
  const archived = join(configHome, "archived_sessions", "rollout-old.jsonl");
  mkdirSync(join(configHome, "archived_sessions"));
  writeFileSync(archived, "x".repeat(100));
  setStorageCleanupPolicyJobTestHooks({ runInProcess: true });
  setPersistedConfigMutationBeforeCommitForTests(() => {
    rmSync(getConfigPath(), { force: true });
  });

  const started = requestStorageCleanupPolicyRun({
    reason: "manual",
    force: true,
    codexHome: configHome,
  });
  expect(started.accepted).toBe(true);

  const deadline = Date.now() + 5_000;
  while (getStorageCleanupPolicyJobState().status !== "idle" && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  const state = getStorageCleanupPolicyJobState();
  expect(state.status).toBe("idle");
  expect(state.lastOutcome).toMatchObject({
    ok: true,
    mode: "quarantine",
    removed: 1,
    freedBytes: 100,
    metadataPersistenceError: "missing",
  });
  expect(state.lastError).toBeUndefined();
  expect(existsSync(archived)).toBe(false);
  expect(existsSync(getConfigPath())).toBe(false);
}, { timeout: 10_000 });
