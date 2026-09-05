import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  loadConfig,
  mutatePersistedConfig,
  readConfigMutationAudit,
  saveConfig,
  saveConfigPreservingClaudeCode,
  setConfigAtomicWriteFailureForTests,
  setConfigRecoveryMarkerUnlinkFailureForTests,
  setConfigPostWriteFailureForTests,
  withConfigMutationLockSync,
} from "../src/config";
import {
  buildConfigMutationSnapshot,
  configMutationPendingAuditPath,
  insertConfigMutationAuditRow,
  listPendingConfigMutationAuditPaths,
  setConfigAuditMaxRowsForTests,
  setReconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests,
} from "../src/config-mutation-audit";
import { addProviderApiKey } from "../src/providers/api-keys";
import { setProviderKeychainEntryFactoryForTests, type ProviderKeychainEntry } from "../src/providers/key-store";
import { rotateKeyOn429 } from "../src/providers/key-failover";
import { writeStorageCleanupPolicyToConfig } from "../src/storage/policy";
import { setIntegrationEnabled } from "../src/codex/desired-state";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  markAccountNeedsReauth,
  updateAccountQuota,
} from "../src/codex/auth-api";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  releaseDrainedCodexAccountPin,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { POOL_KEY_CODEX, clearPoolRotationState, seedPoolRotationAccount } from "../src/codex/pool-rotation";
import { commitKeyLoginProvider } from "../src/oauth/login-cli";
import { clearClientConnection, commitClientConnection } from "../src/client/state";
import type { OcxClientConnectionConfig, OcxConfig, StorageCleanupPolicy } from "../src/types";
import { handleManagementAPI } from "../src/server/management-api";
import {
  resetPreservedDiskOnlyProvidersForTests,
  setPreservedDiskOnlyProviders,
} from "../src/usage/user-cost-overlays";
import type { OcxProviderConfig } from "../src/types";

let testRoot = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-config-audit-"));
  process.env.OPENCODEX_HOME = testRoot;
  setConfigAuditMaxRowsForTests(5);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  setConfigAuditMaxRowsForTests(null);
  setConfigAtomicWriteFailureForTests(null);
  setConfigRecoveryMarkerUnlinkFailureForTests(null);
  setConfigPostWriteFailureForTests(null);
  setProviderKeychainEntryFactoryForTests(null);
  setReconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests(null);
  resetPreservedDiskOnlyProvidersForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

function configWithProvider(port = 10100): OcxConfig {
  return {
    port,
    defaultProvider: "blsc",
    providers: {
      blsc: {
        adapter: "openai-chat",
        baseUrl: "https://llmapi.blsc.cn/v1",
        authMode: "key",
        apiKey: "sk-super-secret-value",
      },
    },
  } as unknown as OcxConfig;
}

function markerFile(mutationId: string): string {
  return configMutationPendingAuditPath(testRoot, mutationId);
}

describe("config mutation audit log", () => {
  test("api-key pool writers record api surface and operation detail", () => {
    saveConfig(configWithProvider());
    const live = loadConfig();
    addProviderApiKey(live, "blsc", "sk-second-key");
    rotateKeyOn429(live, "blsc", null);
    const { rows } = readConfigMutationAudit();
    expect(rows).toHaveLength(3);
    expect(rows[0].surface).toBe("internal");
    expect(rows[0].detail).toBe("key-failover: rotate active provider key");
    expect(rows[1].surface).toBe("api");
    expect(rows[1].detail).toBe("api-keys: add provider key");
    expect(JSON.stringify(rows[1].after)).not.toContain("sk-second-key");
  });

  test("nested changed saves remove every pending marker after commit", () => {
    withConfigMutationLockSync(() => {
      const first = configWithProvider(10100);
      first.managementUsageMaxReadBytes = 111;
      saveConfig(first, { surface: "internal", detail: "nested first" });
      const second = configWithProvider(10200);
      second.managementUsageMaxReadBytes = 222;
      saveConfig(second, { surface: "internal", detail: "nested second" });
    });
    const { rows } = readConfigMutationAudit();
    expect(rows.map(row => row.detail)).toEqual(["nested second", "nested first"]);
    expect(listPendingConfigMutationAuditPaths(testRoot)).toEqual([]);
  });

  test("storage cleanup policy writes record api surface and operation detail", () => {
    saveConfig(configWithProvider());
    const policy: StorageCleanupPolicy = {
      enabled: true,
      trigger: { archivedBytesOver: 1024 * 1024 },
      target: { reduceToBytes: 512 * 1024 },
      schedule: "manual",
      mode: "quarantine",
    };
    writeStorageCleanupPolicyToConfig(policy);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("storage-policy: write cleanup policy");
    expect(rows[0].fields).toContain("storageCleanupPolicy");
  });

  test("cli integration mutations record the invoking command detail", () => {
    saveConfig(configWithProvider());
    const live = loadConfig();
    setIntegrationEnabled("codex", false, { surface: "cli", detail: "ocx restore" });
    setIntegrationEnabled("codex", true, { surface: "cli", detail: "ocx restore back" });
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("cli");
    expect(rows[0].detail).toBe("ocx restore back");
    // Re-enable removes clientIntegrations when no disabled clients remain; the
    // audit snapshot records the removed top-level key as null.
    expect((rows[0].after as Record<string, unknown>).clientIntegrations).toBeNull();
    expect(rows[1].surface).toBe("cli");
    expect(rows[1].detail).toBe("ocx restore");
    expect((rows[1].after as Record<string, unknown>).clientIntegrations).toEqual({ codex: false });
  });

  test("routing pin clears record unavailable vs drained provenance", () => {
    saveConfig(configWithProvider());
    const live = loadConfig();
    live.activeCodexAccountPinned = "reauth-acc";
    saveConfigPreservingClaudeCode(live, { surface: "internal", detail: "test: set reauth pin" });
    markAccountNeedsReauth("reauth-acc");
    try {
      releaseDrainedCodexAccountPin(live, {});
      const { rows } = readConfigMutationAudit();
      expect(rows[0].surface).toBe("internal");
      expect(rows[0].detail).toBe("routing: clear unavailable codex account pin");
      expect((JSON.parse(readFileSync(join(testRoot, "config.json"), "utf8")) as Record<string, unknown>).activeCodexAccountPinned)
        .toBeUndefined();
    } finally {
      clearAccountNeedsReauth("reauth-acc");
    }
    const live2 = loadConfig();
    live2.activeCodexAccountPinned = "ghost-acc";
    saveConfigPreservingClaudeCode(live2, { surface: "internal", detail: "test: set pin" });
    releaseDrainedCodexAccountPin(live2, {});
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("internal");
    expect(rows[0].detail).toBe("routing: clear drained codex account pin");
    expect((JSON.parse(readFileSync(join(testRoot, "config.json"), "utf8")) as Record<string, unknown>).activeCodexAccountPinned)
      .toBeUndefined();
  });

  test("pin-only active selection records the pin-clear audit detail", () => {
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearPoolRotationState();
    clearAccountQuota();
    try {
      saveConfig(configWithProvider());
      const live = loadConfig();
      live.codexAccounts = [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
        { id: "c", email: "c@test", isMain: false },
      ];
      live.activeCodexAccountId = "a";
      live.accountPoolStrategy = "round-robin";
      // A stale pin on a healthy third account: moving an affined thread back onto
      // the already-active account persists only the pin clear, so the audit row
      // must say so instead of claiming a new active-account selection.
      live.activeCodexAccountPinned = "c";
      saveConfigPreservingClaudeCode(live, { surface: "internal", detail: "test: seed stale pin" });
      saveCodexAccountCredential("a", {
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: "acct-a",
      });
      saveCodexAccountCredential("b", {
        accessToken: "access-b",
        refreshToken: "refresh-b",
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: "acct-b",
      });
      saveCodexAccountCredential("c", {
        accessToken: "access-c",
        refreshToken: "refresh-c",
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: "acct-c",
      });
      const config = loadConfig();
      seedPoolRotationAccount(POOL_KEY_CODEX, "b");
      // Bind the thread to b first so the quota re-evaluation below can move it
      // back onto the already-active account a.
      expect(resolveCodexAccountForThread("affined", config)).toBe("b");
      config.accountPoolStrategy = "quota";
      saveConfigPreservingClaudeCode(config, { surface: "internal", detail: "test: switch to quota" });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 90);
      updateAccountQuota("c", 10);
      expect(resolveCodexAccountForThread("affined", config)).toBe("a");
      const { rows } = readConfigMutationAudit();
      expect(rows[0].surface).toBe("internal");
      expect(rows[0].detail).toBe("routing: clear codex account pin");
      // The pin-only save must not touch any operator configuration field; the
      // audit writer's own configRebaseProvenance bookkeeping is the only extra.
      expect(rows[0].fields.filter(field => field !== "configRebaseProvenance")).toEqual(["activeCodexAccountPinned"]);
      const before = rows[0].before as Record<string, unknown>;
      const after = rows[0].after as Record<string, unknown>;
      // Snapshots contain only changed fields: unchanged operator state is absent.
      expect(before).not.toHaveProperty("activeCodexAccountId");
      expect(after).not.toHaveProperty("activeCodexAccountId");
      expect(before).not.toHaveProperty("accountPoolStrategy");
      expect(after).not.toHaveProperty("accountPoolStrategy");
      expect(before).not.toHaveProperty("codexAccounts");
      expect(after).not.toHaveProperty("codexAccounts");
      expect(before.activeCodexAccountPinned).toBe("c");
      expect(after.activeCodexAccountPinned).toBeNull();
    } finally {
      clearThreadAccountMap();
      clearCodexUpstreamHealth();
      clearPoolRotationState();
      clearAccountQuota();
    }
  });

  test("saveConfig records source, changed fields, and redacts secrets", () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx test write" });
    const { rows } = readConfigMutationAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].surface).toBe("cli");
    expect(rows[0].detail).toBe("ocx test write");
    expect(rows[0].fields).toEqual(["<root>"]);
    expect(JSON.stringify(rows[0].after)).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(rows[0].after)).toContain("[REDACTED]");
    expect(JSON.stringify(rows[0].before)).toBe(JSON.stringify({ "<root>": null }));
  });

  test("a byte-identical save records nothing", () => {
    saveConfig(configWithProvider());
    const before = readConfigMutationAudit().rows.length;
    saveConfig(configWithProvider());
    expect(readConfigMutationAudit().rows.length).toBe(before);
  });

  test("mutatePersistedConfig records fine-grained fields with redaction", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers.blsc.apiKey = "sk-new-secret-value";
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers/blsc" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    expect(rows).toHaveLength(2);
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PUT /api/providers/blsc");
    expect(rows[0].fields).toContain("providers.blsc.apiKey");
    expect(JSON.stringify(rows[0].before)).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(rows[0].after)).not.toContain("sk-new-secret-value");
    expect(JSON.stringify(rows[0].after)).toContain("[REDACTED]");
  });

  test("saveConfigPreservingClaudeCode records the changed top-level field", () => {
    saveConfig(configWithProvider());
    const live = loadConfig();
    live.streamMode = "eager-relay";
    saveConfigPreservingClaudeCode(live, { surface: "api", detail: "PUT /api/settings" });
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PUT /api/settings");
    expect(rows[0].fields).toContain("streamMode");
    expect(rows[0].after.streamMode).toBe("eager-relay");
  });

  test("retention keeps only the newest bounded rows", () => {
    setConfigAuditMaxRowsForTests(3);
    for (let i = 0; i < 5; i += 1) saveConfig(configWithProvider(10100 + i));
    const { rows, maxRows } = readConfigMutationAudit();
    expect(maxRows).toBe(3);
    expect(rows).toHaveLength(3);
    // Newest first: the last three ports survive.
    expect(rows[0].fields).toContain("port");
    expect(rows.map(row => row.after.port)).toEqual([10104, 10103, 10102]);
    expect(rows.map(row => row.before.port)).not.toContain(10100);
  });

  test("buildConfigMutationSnapshot is bounded and redacts secrets", () => {
    const snapshot = buildConfigMutationSnapshot(
      { providers: { a: { apiKey: "sk-old", baseUrl: "u" } }, port: 1 },
      { providers: { a: { apiKey: "sk-new", baseUrl: "u" } }, port: 2 },
    );
    expect(snapshot.fields.sort()).toEqual(["port", "providers.a.apiKey"]);
    expect(JSON.stringify(snapshot.before)).not.toContain("sk-old");
    expect(JSON.stringify(snapshot.after)).not.toContain("sk-new");
    expect(JSON.stringify(snapshot.after)).toContain("[REDACTED]");
  });

  test("provider header values are redacted regardless of the header name", () => {
    const snapshot = buildConfigMutationSnapshot(
      { providers: { p: { headers: { "X-Custom-Auth": "opaque-before" } } } },
      { providers: { p: { headers: { "X-Custom-Auth": "opaque-after" } } } },
    );
    expect(snapshot.fields).toContain("providers.p.headers");
    expect(JSON.stringify(snapshot.before)).not.toContain("opaque-before");
    expect(JSON.stringify(snapshot.after)).not.toContain("opaque-after");
    expect(JSON.stringify(snapshot.before)).toContain("[REDACTED]");
    expect(JSON.stringify(snapshot.after)).toContain("[REDACTED]");
  });

  test("provider header values are redacted inside a whole-config snapshot", () => {
    const snapshot = buildConfigMutationSnapshot(
      undefined,
      { providers: { p: { headers: { "X-Auth-Token": "opaque-value" } } }, port: 10100 },
    );
    expect(snapshot.fields).toEqual(["<root>"]);
    expect(JSON.stringify(snapshot.after)).not.toContain("opaque-value");
    expect(JSON.stringify(snapshot.after)).toContain("[REDACTED]");
  });

  test("a secret-shaped provider name is redacted in the changed-field paths", () => {
    saveConfig(configWithProvider());
    const tokenName = "sk-" + "live-" + "abcdefghijklmnopqrstuvwxyz012345";
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers[tokenName] = {
        adapter: "openai-chat",
        baseUrl: "https://example.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    expect(JSON.stringify(rows[0].fields)).not.toContain(tokenName);
  });

  test("dotted provider names keep their before/after values", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers["my.provider"] = {
        adapter: "openai-chat",
        baseUrl: "https://example.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    expect(rows[0].fields).toContain("providers.my.provider");
    expect(rows[0].after["providers.my.provider"]).toEqual({
      adapter: "openai-chat",
      baseUrl: "https://example.invalid/v1",
    });
  });

  test("credential-shaped leaves are redacted by key matcher", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers.blsc = {
        ...persisted.providers.blsc,
        apiKeyPool: [{ key: "sk-pool-secret-value" }],
        oauthClientSecret: "oauth-client-secret-value",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers/blsc" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("sk-pool-secret-value");
    expect(serialized).not.toContain("oauth-client-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });

  test("apiKeys entry key is redacted even inside a whole-config snapshot", () => {
    const rawAdmissionKey = "ocx_data_admission_secret_do_not_leak";
    saveConfig({
      ...configWithProvider(),
      apiKeys: [{
        id: "admission-1",
        name: "benchmark key",
        key: rawAdmissionKey,
        createdAt: "2026-08-23T00:00:00.000Z",
      }],
    }, { surface: "api", detail: "PUT /api/admission-keys" });
    const first = readConfigMutationAudit();
    expect(first.rows).toHaveLength(1);
    expect(JSON.stringify(first.rows[0])).not.toContain(rawAdmissionKey);
    expect(JSON.stringify(first.rows[0])).toContain("[REDACTED]");
    // A later mutation that changes only the key field must also be masked.
    const outcome = mutatePersistedConfig(persisted => {
      persisted.apiKeys = [{
        id: "admission-1",
        name: "benchmark key",
        key: "ocx_data_second_secret_do_not_leak",
        createdAt: "2026-08-23T00:00:00.000Z",
      }];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/admission-keys" });
    expect(outcome.status).toBe("committed");
    const second = readConfigMutationAudit();
    expect(JSON.stringify(second.rows[0])).not.toContain("ocx_data_second_secret_do_not_leak");
    expect(second.rows[0].fields).toContain("apiKeys");
  });

  test("degraded apiKeys entries (missing metadata) are redacted in before and after", () => {
    const rawAdmissionKey = "ocx_data_degraded_secret_do_not_leak";
    // A hand-edited / older row with only key+name: the schema salvages it, and the
    // before snapshot is built from the RAW disk bytes, so the mask must not depend
    // on the full happy-path entry shape.
    const configPath = join(testRoot, "config.json");
    writeFileSync(configPath, JSON.stringify({
      ...configWithProvider(),
      apiKeys: [{ key: rawAdmissionKey, name: "degraded" }],
    }, null, 2) + "\n");
    const outcome = mutatePersistedConfig(persisted => {
      persisted.apiKeys = [{
        id: "degraded-1",
        name: "degraded",
        key: rawAdmissionKey,
        createdAt: "2026-08-23T00:00:00.000Z",
      }];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/admission-keys" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(rawAdmissionKey);
    expect(serialized).toContain("[REDACTED]");
  });

  test("a degraded apiKeys entry with only a key is redacted from rows and the endpoint", async () => {
    const rawAdmissionKey = "ocx_data_minimal_degraded_secret_do_not_leak";
    // A hand-edited row with NO id/name/createdAt must still be masked: the raw
    // before snapshot has no happy-path metadata for the heuristic to latch onto.
    const configPath = join(testRoot, "config.json");
    writeFileSync(configPath, JSON.stringify({
      ...configWithProvider(),
      apiKeys: [{ key: rawAdmissionKey }],
    }, null, 2) + "\n");
    const outcome = mutatePersistedConfig(persisted => {
      persisted.apiKeys = [{ key: "ocx_data_minimal_second_secret_do_not_leak" }];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/admission-keys" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(rawAdmissionKey);
    expect(serialized).not.toContain("ocx_data_minimal_second_secret_do_not_leak");
    expect(serialized).toContain("[REDACTED]");
    // The management endpoint must not echo the plaintext admission keys either.
    const url = new URL("http://127.0.0.1:10100/api/config/mutations?limit=5");
    const response = await handleManagementAPI(
      new Request(url, { headers: { Host: "127.0.0.1:10100" } }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response).not.toBeNull();
    const body = await response!.json() as { mutations: Array<Record<string, unknown>> };
    expect(JSON.stringify(body)).not.toContain(rawAdmissionKey);
    expect(JSON.stringify(body)).not.toContain("ocx_data_minimal_second_secret_do_not_leak");
  });

  test("the pending marker never contains the raw apiKeys admission secret", () => {
    setConfigAtomicWriteFailureForTests(() => new Error("stop after marker"));
    expect(() => saveConfig({
      ...configWithProvider(),
      apiKeys: [{
        id: "marker-1",
        name: "marker key",
        key: "ocx_data_marker_secret_do_not_leak",
        createdAt: "2026-08-23T00:00:00.000Z",
      }],
    }, { surface: "api", detail: "PUT /api/admission-keys" })).toThrow("stop after marker");
    const marker = readFileSync(listPendingConfigMutationAuditPaths(testRoot)[0]!, "utf8");
    expect(marker).not.toContain("ocx_data_marker_secret_do_not_leak");
    expect(marker).toContain("[REDACTED]");
  });

  test("apiKeyPool rows are redacted by key name even without an sk- prefix", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers.blsc.apiKeyPool = [{ key: "plain-pool-secret-value" }];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers/blsc" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("plain-pool-secret-value");
    expect(serialized).toContain("[REDACTED]");
  });

  test("redacted field labels stay unique when distinct paths collapse", () => {
    saveConfig(configWithProvider());
    const firstName = "sk-" + "live-" + "a".repeat(30);
    const secondName = "sk-" + "live-" + "b".repeat(30);
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers[firstName] = {
        adapter: "openai-chat",
        baseUrl: "https://a.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      persisted.providers[secondName] = {
        adapter: "openai-chat",
        baseUrl: "https://b.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const fields = rows[0].fields;
    // Distinct paths that both redact to providers.[REDACTED].<field> keep unique labels.
    expect(new Set(fields).size).toBe(fields.length);
    const redactedFields = fields.filter(field => field.includes("[REDACTED]"));
    expect(redactedFields.length).toBeGreaterThanOrEqual(2);
    for (const field of redactedFields) {
      expect(rows[0].after[field]).toBeDefined();
    }
  });

  test("persisted fields match the before/after keys after bounding and dedup", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      const longA = "a".repeat(300);
      const longB = "b".repeat(300);
      persisted.providers[longA] = {
        adapter: "openai-chat",
        baseUrl: "https://a.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      persisted.providers[longB] = {
        adapter: "openai-chat",
        baseUrl: "https://b.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const beforeKeys = Object.keys(rows[0].before).sort();
    const afterKeys = Object.keys(rows[0].after).sort();
    // The persisted fields array must reference exactly the labels stored in
    // before/after; insertion must not re-bound them into a different label.
    expect([...rows[0].fields].sort()).toEqual(beforeKeys);
    expect([...rows[0].fields].sort()).toEqual(afterKeys);
    for (const field of rows[0].fields) {
      expect(rows[0].after[field]).toBeDefined();
    }
  });

  test("URL userinfo is redacted before a large value is truncated", () => {
    saveConfig(configWithProvider());
    const userinfoUrl = "https://user:top-secret-userinfo@relay.test/v1/" + "x".repeat(10_000);
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers.blsc.baseUrl = userinfoUrl;
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers/blsc" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("top-secret-userinfo");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[truncated]");
  });

  test("URL userinfo is redacted when embedded or repeated in a string", () => {
    const note = "see https://user:secret-one@relay.test/a and https://second:pw@relay.test/b";
    const snapshot = buildConfigMutationSnapshot(
      { note },
      { note: note + " updated" },
    );
    const serialized = JSON.stringify(snapshot.before);
    expect(serialized).not.toContain("secret-one");
    expect(serialized).not.toContain("second:pw");
    expect(serialized).toContain("https://[REDACTED]@relay.test/a");
    expect(serialized).toContain("https://[REDACTED]@relay.test/b");
  });

  test("__proto__ keys survive in audit snapshot fields and values", () => {
    const before = { note: JSON.parse('{"__proto__":{"value":1}}') as Record<string, unknown> };
    const after = { note: "replaced" };
    const snapshot = buildConfigMutationSnapshot(before, after);
    expect(snapshot.fields).toContain("note");
    expect(JSON.stringify(snapshot.before)).toContain('"__proto__"');
    expect(JSON.stringify(snapshot.before)).toContain('"value":1');
  });

  test("a disk-only provider is not reported as deleted", () => {
    saveConfig(configWithProvider());

    // Simulate an external editor adding a provider the in-memory config never saw.
    const configPath = join(testRoot, "config.json");
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    const staging = { adapter: "openai-chat", baseUrl: "https://staging.invalid/v1" };
    onDisk.providers.staging = staging;
    writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + "\n");
    // Mirror the running server: the admission snapshot has already seen the disk-only row.
    setPreservedDiskOnlyProviders({ staging } as Record<string, OcxProviderConfig>);

    saveConfig(configWithProvider(10500), { surface: "cli", detail: "ocx port change" });

    const { rows } = readConfigMutationAudit();
    expect(rows[0].fields).not.toContain("providers.staging");
    // The provider must still be on disk.
    const after = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(after.providers.staging).toBeDefined();
  });

  test("a crash after the config rename is replayed from the pending marker", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    // Simulate a crash between the config.json rename and the audit-row commit:
    // disk already carries the new bytes, the audit row does not exist yet.
    const next = configWithProvider(10500);
    const bytes = JSON.stringify(next, null, 2) + "\n";
    writeFileSync(configPath, bytes);
    writeFileSync(markerFile("crash-replay"), JSON.stringify({
      mutationId: "crash-replay",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/test-crash",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(bytes).digest("hex"),
    }));

    // The next write (even a byte-identical retry) reconciles the marker first.
    saveConfig(configWithProvider(10500), { surface: "cli", detail: "ocx retry" });

    const { rows } = readConfigMutationAudit();
    expect(rows.some(row => row.detail === "PUT /api/test-crash")).toBe(true);
    // The byte-identical retry records nothing of its own.
    expect(rows.some(row => row.detail === "ocx retry")).toBe(false);
    expect(existsSync(markerFile("crash-replay"))).toBe(false);
  });

  test("a pending marker whose rename never landed is dropped without a phantom row", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(markerFile("never-landed"), JSON.stringify({
      mutationId: "never-landed",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/test-never-landed",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(bytes).digest("hex"),
    }));

    saveConfig(configWithProvider(10600), { surface: "cli", detail: "ocx next" });

    const { rows } = readConfigMutationAudit();
    expect(rows.some(row => row.detail === "PUT /api/test-never-landed")).toBe(false);
    expect(rows[0].detail).toBe("ocx next");
    expect(existsSync(markerFile("never-landed"))).toBe(false);
  });

  test("a malformed marker with non-string field labels is skipped without blocking later writes", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const markerPath = markerFile("bad-fields");
    writeFileSync(markerPath, JSON.stringify({
      mutationId: "bad-fields",
      createdAt: Date.now(),
      surface: "api",
      detail: "PUT /api/test-bad-fields",
      fields: ["port", null],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(JSON.stringify({ port: 10500 })).digest("hex"),
    }));
    // The malformed marker must not crash recovery or block the next write.
    saveConfig(configWithProvider(10500), { surface: "cli", detail: "ocx next" });
    const { rows } = readConfigMutationAudit();
    expect(rows.some(row => row.detail === "PUT /api/test-bad-fields")).toBe(false);
    expect(rows[0].detail).toBe("ocx next");
  });

  test("the read path replays an orphaned pending marker without duplicating", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(configPath, bytes);
    writeFileSync(markerFile("orphan-replay"), JSON.stringify({
      mutationId: "orphan-replay",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/test-crash",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(bytes).digest("hex"),
    }));

    const first = readConfigMutationAudit();
    const second = readConfigMutationAudit();
    expect(first.rows.filter(row => row.detail === "PUT /api/test-crash")).toHaveLength(1);
    expect(second.rows.filter(row => row.detail === "PUT /api/test-crash")).toHaveLength(1);
    expect(existsSync(markerFile("orphan-replay"))).toBe(false);
  });

  test("read-side recovery retains an in-flight marker whose rename has not landed", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    const mutationId = "in-flight-write";
    writeFileSync(markerFile(mutationId), JSON.stringify({
      mutationId,
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/in-flight",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(bytes).digest("hex"),
    }));

    // The marker is written BEFORE the config rename lands; a read in this window
    // must not delete the marker or record a phantom row.
    const first = readConfigMutationAudit();
    expect(first.rows.some(row => row.detail === "PUT /api/in-flight")).toBe(false);
    expect(existsSync(markerFile(mutationId))).toBe(true);

    // The rename lands now; the next recovery replays exactly one audit row.
    writeFileSync(configPath, bytes);
    const second = readConfigMutationAudit();
    expect(second.rows.filter(row => row.detail === "PUT /api/in-flight")).toHaveLength(1);
    expect(existsSync(markerFile(mutationId))).toBe(false);
  });

  test("a parseable-but-invalid pending marker is dropped by the read path", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const markerPath = markerFile("invalid-marker");
    // JSON.parse succeeds but validation fails (afterSha256 missing): the read path
    // drops the unusable marker immediately so recovery does not reprocess it
    // on every read or write.
    writeFileSync(markerPath, JSON.stringify({
      mutationId: "invalid-marker",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/invalid-marker",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
    }));
    readConfigMutationAudit();
    expect(existsSync(markerPath)).toBe(false);
    const { rows } = readConfigMutationAudit();
    expect(rows.some(row => row.detail === "PUT /api/invalid-marker")).toBe(false);
    // The next successful save overwrites and drops the invalid marker without
    // ever recording a phantom row.
    saveConfig(configWithProvider(10600), { surface: "cli", detail: "ocx next" });
    expect(existsSync(markerPath)).toBe(false);
    const after = readConfigMutationAudit();
    expect(after.rows.some(row => row.detail === "PUT /api/invalid-marker")).toBe(false);
    expect(after.rows[0].detail).toBe("ocx next");
  });

  test("a pending marker whose root is JSON null is removed by the read path", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const markerPath = markerFile("null-marker");
    writeFileSync(markerPath, "null");
    readConfigMutationAudit();
    expect(existsSync(markerPath)).toBe(false);
    const { rows } = readConfigMutationAudit();
    expect(rows.some(row => row.detail === "PUT /api/null-marker")).toBe(false);
  });

  test("undefined-valued keys and absent keys compare equal after JSON semantics", () => {
    const before = { providers: { p: { retryOn429: { attempts: undefined } } } };
    const after = { providers: { p: { retryOn429: {} } } };
    const snapshot = buildConfigMutationSnapshot(before, after);
    expect(snapshot.fields).toEqual([]);
  });

  test("a rollback after reconciliation keeps the recovered audit row committed", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(configPath, bytes);
    const markerPath = markerFile("rollback-replay");
    writeFileSync(markerPath, JSON.stringify({
      mutationId: "rollback-replay",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/test-crash",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(bytes).digest("hex"),
    }));

    // Reconciliation commits the recovered row in its own transaction, so a
    // mutation that fails afterwards cannot roll the row back or let a new marker
    // overwrite the marker whose replay already committed.
    expect(() => mutatePersistedConfig(() => {
      throw new Error("mutation failed after reconciliation");
    }, { surface: "api", detail: "PUT /api/fails" })).toThrow();
    let audit = readConfigMutationAudit();
    expect(audit.rows.some(row => row.detail === "PUT /api/test-crash")).toBe(true);
    expect(existsSync(markerPath)).toBe(false);

    saveConfig(configWithProvider(10600), { surface: "cli", detail: "ocx next" });
   audit = readConfigMutationAudit();
   expect(audit.rows.some(row => row.detail === "PUT /api/test-crash")).toBe(true);
   expect(audit.rows.filter(row => row.detail === "PUT /api/test-crash")).toHaveLength(1);
   expect(audit.rows[0].detail).toBe("ocx next");
 });

  test("a failed config write cannot let a new marker replace a recovered row", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    // Simulate a crash after an earlier rename: disk carries the new bytes and the
    // audit row has not committed yet (recovered row C1).
    const interruptedBytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(configPath, interruptedBytes);
    writeFileSync(markerFile("recovered-row"), JSON.stringify({
      mutationId: "recovered-row",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/test-crash",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(interruptedBytes).digest("hex"),
    }));

    // The next save writes a NEW marker (P2), then fails before the config rename
    // lands. P2 must not be able to clobber the C1 row that already committed.
    setConfigAtomicWriteFailureForTests(() => new Error("simulated config write failure"));
    expect(() => saveConfig(configWithProvider(10600), {
      surface: "api",
      detail: "PUT /api/failed-write",
    })).toThrow("simulated config write failure");
    // The failed write left its OWN per-mutation marker behind and the config
    // rename never landed; the recovered marker was already removed by the lock
    // recovery at the start of this mutation.
    const failedMarkers = listPendingConfigMutationAuditPaths(testRoot);
    expect(failedMarkers).toHaveLength(1);
    expect(readFileSync(failedMarkers[0]!, "utf8")).toContain("PUT /api/failed-write");
    expect(existsSync(markerFile("recovered-row"))).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(interruptedBytes);

    const audit = readConfigMutationAudit();
    // The recovered C1 row survives exactly once; the failed write recorded nothing.
    expect(audit.rows.filter(row => row.detail === "PUT /api/test-crash")).toHaveLength(1);
    expect(audit.rows.some(row => row.detail === "PUT /api/failed-write")).toBe(false);

    // The next successful save reconciles P2 (rename never landed -> dropped) and
    // C1 remains committed exactly once.
    saveConfig(configWithProvider(10700), { surface: "cli", detail: "ocx next" });
    const after = readConfigMutationAudit();
    expect(after.rows.filter(row => row.detail === "PUT /api/test-crash")).toHaveLength(1);
    expect(after.rows.some(row => row.detail === "PUT /api/failed-write")).toBe(false);
    expect(after.rows[0].detail).toBe("ocx next");
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(0);
  });

  test("a crash between the config rename and the audit commit replays exactly one row", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    const before = readFileSync(configPath, "utf8");
    setConfigPostWriteFailureForTests(() => new Error("simulated post-rename failure"));
    expect(() => saveConfig(configWithProvider(10500), {
      surface: "api",
      detail: "PUT /api/post-rename",
    })).toThrow("simulated post-rename failure");
    // The rename landed: disk carries the new bytes even though the audit row
    // never committed; the write-ahead marker is the only durable trace.
    expect(readFileSync(configPath, "utf8")).not.toBe(before);
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(1);
    // Inspect the store directly: the read-path recovery must not be triggered
    // before the next save so the replay actually exercises the marker.
    const db = new Database(join(testRoot, "config-mutation.sqlite"), { readonly: true });
    try {
      const count = db.query("SELECT COUNT(*) AS n FROM config_mutation_audit WHERE detail = ?").get("PUT /api/post-rename") as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
    }
    // The next save recovers the interrupted write: exactly one row for the
    // post-rename mutation id, and the marker is removed.
    saveConfig(configWithProvider(10600), { surface: "cli", detail: "ocx next" });
    const audit = readConfigMutationAudit();
    expect(audit.rows.filter(row => row.detail === "PUT /api/post-rename")).toHaveLength(1);
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(0);
  });

  test("a marker that cannot be unlinked after a recovery commit does not fail the save", () => {
    saveConfig(configWithProvider(10100));
    const configPath = join(testRoot, "config.json");
    // Plant a VALID marker whose hash matches the on-disk bytes — the exact state a
    // real writer leaves after a crash between the config rename and audit commit.
    const interruptedBytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    setConfigPostWriteFailureForTests(() => new Error("simulated post-rename failure"));
    expect(() => saveConfig(configWithProvider(10500), {
      surface: "api",
      detail: "PUT /api/post-rename",
    })).toThrow("simulated post-rename failure");
    expect(readFileSync(configPath, "utf8")).toBe(interruptedBytes);
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(1);

    // Recovery COMMITs the row first; the one-shot unlink seam then throws, so
    // the leftover marker must not turn the next save into a reported failure.
    setConfigRecoveryMarkerUnlinkFailureForTests(() => new Error("simulated marker unlink failure"));
    expect(() => saveConfig(configWithProvider(10600), { surface: "cli", detail: "ocx next-1" })).not.toThrow();
    let audit = readConfigMutationAudit();
    expect(audit.rows.filter(row => row.detail === "PUT /api/post-rename")).toHaveLength(1);
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(1);

    // Restore the interrupted bytes and let recovery replay the SAME marker:
    // mutation-id dedupe must keep exactly one row while the unlink fails again.
    writeFileSync(configPath, interruptedBytes);
    setConfigRecoveryMarkerUnlinkFailureForTests(() => new Error("simulated marker unlink failure"));
    expect(() => saveConfig(configWithProvider(10700), { surface: "cli", detail: "ocx next-2" })).not.toThrow();
    audit = readConfigMutationAudit();
    expect(audit.rows.filter(row => row.detail === "PUT /api/post-rename")).toHaveLength(1);
    expect(audit.rows[0].detail).toBe("ocx next-2");
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(1);

    // Once the unlink succeeds the marker is removed and the row stays at one.
    expect(() => saveConfig(configWithProvider(10800), { surface: "cli", detail: "ocx next-3" })).not.toThrow();
    audit = readConfigMutationAudit();
    expect(audit.rows.filter(row => row.detail === "PUT /api/post-rename")).toHaveLength(1);
    expect(audit.rows[0].detail).toBe("ocx next-3");
    expect(listPendingConfigMutationAuditPaths(testRoot)).toHaveLength(0);
  });

  test("proxy URL userinfo is never stored in the pending marker", () => {
    saveConfig(configWithProvider());
    setConfigAtomicWriteFailureForTests(() => new Error("stop after marker"));
    expect(() => mutatePersistedConfig(persisted => {
      persisted.proxy = "http://user:supersecretpw@127.0.0.1:8080";
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/proxy" })).toThrow("stop after marker");
    const marker = readFileSync(listPendingConfigMutationAuditPaths(testRoot)[0]!, "utf8");
    expect(marker).not.toContain("supersecretpw");
    expect(marker).toContain("[REDACTED]");
  });

  test("proxy URL userinfo is redacted from audit rows", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.proxy = "http://user:supersecretpw@127.0.0.1:8080";
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/proxy" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("supersecretpw");
    expect(serialized).toContain("[REDACTED]");
  });

  test("userinfo containing multiple @ characters is fully redacted", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.proxy = "http://user:p@ss-word@127.0.0.1:8080";
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/proxy" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("p@ss-word");
    expect(serialized).toContain("[REDACTED]@127.0.0.1");
  });

  test("duplicate overlong labels keep a distinct occurrence suffix", () => {
    saveConfig(configWithProvider());
    const shared = "a".repeat(300);
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers[`${shared}1`] = {
        adapter: "openai-chat",
        baseUrl: "https://a.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      persisted.providers[`${shared}2`] = {
        adapter: "openai-chat",
        baseUrl: "https://b.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    const fields = rows[0].fields;
    expect(new Set(fields).size).toBe(fields.length);
    const base = fields[0]!;
    expect(base).toBeDefined();
    const suffixed = fields.find(field => field !== base)!;
    expect(suffixed.endsWith("#2")).toBe(true);
    for (const field of fields) {
      expect(field.length).toBeLessThanOrEqual(256);
      expect(rows[0].before[field]).toBeDefined();
      expect(rows[0].after[field]).toBeDefined();
    }
  });

  test("recovery deletes only the exact marker it reconciled, never a newer one", () => {
    saveConfig(configWithProvider(10100));
    const configPath = join(testRoot, "config.json");
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(configPath, bytes);
    const oldMarker = markerFile("old-marker");
    writeFileSync(oldMarker, JSON.stringify({
      mutationId: "old-marker",
      createdAt: 1234567890,
      surface: "api",
      detail: "PUT /api/old",
      fields: ["port"],
      before: { port: 10100 },
      after: { port: 10500 },
      afterSha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    // A marker written after the recovery snapshot but before cleanup must be
    // untouched: cleanup only deletes the exact paths it reconciled.
    const newerMarker = markerFile("newer-marker");
    setReconcilePendingConfigMutationAuditOnReadBeforeCleanupForTests(() => {
      writeFileSync(newerMarker, JSON.stringify({
        mutationId: "newer-marker",
        createdAt: 1234567891,
        surface: "api",
        detail: "PUT /api/newer",
        fields: ["port"],
        before: { port: 10500 },
        after: { port: 10600 },
        afterSha256: createHash("sha256").update(JSON.stringify(configWithProvider(10600), null, 2) + "\n").digest("hex"),
      }));
    });
    readConfigMutationAudit();
    expect(existsSync(oldMarker)).toBe(false);
    expect(existsSync(newerMarker)).toBe(true);
  });

  test("insert dedupes by mutation id, not by identical same-millisecond content", () => {
    const db = new Database(join(testRoot, "config-mutation.sqlite"), { create: true });
    try {
      insertConfigMutationAuditRow(db, "m1", 1234567890, { surface: "cli", detail: "ocx same" }, ["port"], { port: 1 }, { port: 2 });
      insertConfigMutationAuditRow(db, "m2", 1234567890, { surface: "cli", detail: "ocx same" }, ["port"], { port: 1 }, { port: 2 });
      insertConfigMutationAuditRow(db, "m1", 1234567890, { surface: "cli", detail: "ocx same" }, ["port"], { port: 1 }, { port: 2 });
      const count = db.query("SELECT COUNT(*) AS n FROM config_mutation_audit").get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      db.close();
    }
  });

  test("audit detail and field labels are bounded", () => {
    const db = new Database(join(testRoot, "config-mutation.sqlite"), { create: true });
    try {
      const snapshot = buildConfigMutationSnapshot(
        { providers: { ["x".repeat(300)]: { baseUrl: "https://a.invalid/v1" } } },
        { providers: { ["x".repeat(300)]: { baseUrl: "https://b.invalid/v1" } } },
      );
      insertConfigMutationAuditRow(db, "m-bound", 1, { surface: "cli", detail: "d".repeat(1000) }, snapshot.fields, snapshot.before, snapshot.after);
      const row = db.query("SELECT detail, fields, before_json AS beforeJson FROM config_mutation_audit LIMIT 1").get() as { detail: string; fields: string; beforeJson: string };
      expect(row.detail.length).toBeLessThanOrEqual(512);
      const storedFields = JSON.parse(row.fields) as string[];
      const storedBefore = JSON.parse(row.beforeJson) as Record<string, unknown>;
      // Insertion stores the final labels as-is; every label is bounded and
      // still referenced by the before/after snapshot keys.
      expect(storedFields).toEqual(snapshot.fields);
      for (const field of storedFields) {
        expect(field.length).toBeLessThanOrEqual(256);
        expect(Object.keys(storedBefore)).toContain(field);
      }
    } finally {
      db.close();
    }
  });
});

describe("config mutation audit management API", () => {
  test("GET /api/config/mutations returns the bounded trail newest-first", async () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    saveConfig(configWithProvider(10200), { surface: "api", detail: "PUT /api/test" });
    const url = new URL("http://127.0.0.1:10100/api/config/mutations?limit=1");
    const response = await handleManagementAPI(
      new Request(url, { headers: { Host: "127.0.0.1:10100" } }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response).not.toBeNull();
    expect(response!.headers.get("Cache-Control")).toBe("no-store");
    const body = await response!.json() as { mutations: Array<{ detail: string }>; retention: { maxRows: number } };
    expect(body.mutations).toHaveLength(1);
    expect(body.mutations[0].detail).toBe("PUT /api/test");
    expect(body.retention.maxRows).toBe(5);
  });

  test("GET /api/config/mutations rejects anonymous and unauthorized principals", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/config/mutations");
    const request = () => new Request(url, { headers: { Host: "127.0.0.1:10100" } });
    const anonymous = await handleManagementAPI(request(), url, loadConfig());
    expect(anonymous?.status).toBe(401);
    const capability = await handleManagementAPI(request(), url, loadConfig(), {}, "local-read-capability");
    expect(capability?.status).toBe(403);
    const admin = await handleManagementAPI(request(), url, loadConfig(), {}, "admin-token");
    expect(admin?.status).toBe(200);
    expect(admin?.headers.get("Cache-Control")).toBe("no-store");
  });

  // The route's best-effort agent-def sync performs a real provider model discovery after
  // the audited save. Under parallel workers that network probe can exceed the default
  // 5s test budget even though the audit row is written before the sync starts.
  test("PUT /api/claude-code records api surface and route detail", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/claude-code");
    const response = await handleManagementAPI(
      new Request(url, {
        method: "PUT",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response?.status).toBe(200);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PUT /api/claude-code");
    expect(rows[0].fields).toContain("claudeCode");
  }, 20_000);

  test("admission-key writes record api surface and route detail", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const keysUrl = new URL("http://127.0.0.1:10100/api/keys");
    const post = await handleManagementAPI(
      new Request(keysUrl, {
        method: "POST",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy" }),
      }),
      keysUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(post?.status).toBe(201);
    const created = await post!.json() as { id: string };
    let rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("POST /api/keys");
    expect(rows[0].fields).toContain("apiKeys");

    const patch = await handleManagementAPI(
      new Request(keysUrl, {
        method: "PATCH",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.id, name: "deploy-renamed" }),
      }),
      keysUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(patch?.status).toBe(200);
    rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PATCH /api/keys");

    const del = await handleManagementAPI(
      new Request(keysUrl, {
        method: "DELETE",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.id }),
      }),
      keysUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(del?.status).toBe(200);
    rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("DELETE /api/keys");
  });

  test("PUT /api/oauth/accounts/pool records api surface and route detail", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/oauth/accounts/pool");
    const response = await handleManagementAPI(
      new Request(url, {
        method: "PUT",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", enabled: true }),
      }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response?.status).toBe(200);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PUT /api/oauth/accounts/pool");
    expect(rows[0].fields).toContain("anthropicAccountPool");
  });

  test("PATCH /api/oauth/accounts/pool records the actual request method in audit detail", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/oauth/accounts/pool");
    const response = await handleManagementAPI(
      new Request(url, {
        method: "PATCH",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", strategy: "round-robin" }),
      }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response?.status).toBe(200);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PATCH /api/oauth/accounts/pool");
    expect(rows[0].fields).toContain("anthropicAccountPool");
  });

  test("generic OAuth pool persistence records api surface and route detail", async () => {
    saveConfig({
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
        },
      },
    } as unknown as OcxConfig, { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/oauth/accounts/pool");
    const response = await handleManagementAPI(
      new Request(url, {
        method: "PUT",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          enabled: true,
          strategy: "round-robin",
        }),
      }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response?.status).toBe(200);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PUT /api/oauth/accounts/pool");
    expect(rows[0].fields).toContain("providers.google-antigravity.oauthAccountFailover");
  });

  test("codex account management writes record api surface and route detail", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/codex-auth/auto-switch");
    const response = await handleCodexAuthAPI(
      new Request(url, {
        method: "PUT",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: 50 }),
      }),
      url,
      loadConfig(),
    );
    expect(response?.status).toBe(200);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("PUT /api/codex-auth/auto-switch");
    expect(rows[0].fields).toContain("autoSwitchThreshold");
  });
});

describe("cli key login audit provenance", () => {
  test("commitKeyLoginProvider records the cli surface and operation detail", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const config = loadConfig();
    await commitKeyLoginProvider(config, "blsc", {
      adapter: "openai-chat",
      baseUrl: "https://llmapi.blsc.cn/v1",
      authMode: "key",
      apiKey: "sk-rotated",
    } as unknown as OcxProviderConfig);
    const { rows } = readConfigMutationAudit();
    expect(rows[0].surface).toBe("cli");
    expect(rows[0].detail).toBe("ocx key login");
    expect(rows[0].fields).toContain("providers.blsc.apiKey");
  });
});

describe("config mutation audit attribution sweep", () => {
  test("admission-key rotation lifecycle records route-specific api details", async () => {
    const config = configWithProvider();
    config.apiKeys = [{
      id: "admission-1",
      name: "admission",
      key: "ocx_data_0123456789abcdef0123456789abcdef01234567",
      createdAt: new Date(0).toISOString(),
    }];
    saveConfig(config, { surface: "cli", detail: "ocx first" });
    const rotateUrl = new URL("http://127.0.0.1:10100/api/keys/rotate");
    const startResponse = await handleManagementAPI(
      new Request(rotateUrl, {
        method: "POST",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ id: "admission-1" }),
      }),
      rotateUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(startResponse?.status).toBe(201);
    let rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("POST /api/keys/rotate");
    const startBody = await startResponse!.json() as { rotationId: string };
    const commitUrl = new URL("http://127.0.0.1:10100/api/keys/rotate/commit");
    const commitResponse = await handleManagementAPI(
      new Request(commitUrl, {
        method: "POST",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ id: "admission-1", rotationId: startBody.rotationId }),
      }),
      commitUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(commitResponse?.status).toBe(200);
    rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("POST /api/keys/rotate/commit");
    expect(rows[0].fields).toContain("apiKeys");
  });

  test("keychain store and restore record route-specific api details", async () => {
    saveConfig(configWithProvider(), { surface: "cli", detail: "ocx first" });
    const secrets = new Map<string, string>();
    const factory = (service: string, account: string): ProviderKeychainEntry => {
      const key = service + "\u0000" + account;
      return {
        getPassword: () => secrets.get(key) ?? null,
        setPassword: value => { secrets.set(key, value); },
        deletePassword: () => secrets.delete(key),
      };
    };
    setProviderKeychainEntryFactoryForTests(factory);
    try {
      const url = new URL("http://127.0.0.1:10100/api/providers/keychain");
      const store = await handleManagementAPI(
        new Request(url, {
          method: "POST",
          headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "blsc", action: "store" }),
        }),
        url,
        loadConfig(),
        {},
        "admin-token",
      );
      expect(store?.status).toBe(200);
      let rows = readConfigMutationAudit().rows;
      expect(rows[0].surface).toBe("api");
      expect(rows[0].detail).toBe("POST /api/providers/keychain (store)");
      expect(rows[0].fields).toContain("providers.blsc.apiKey");

      const restore = await handleManagementAPI(
        new Request(url, {
          method: "POST",
          headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "blsc", action: "restore" }),
        }),
        url,
        loadConfig(),
        {},
        "admin-token",
      );
      expect(restore?.status).toBe(200);
      rows = readConfigMutationAudit().rows;
      expect(rows[0].surface).toBe("api");
      expect(rows[0].detail).toBe("POST /api/providers/keychain (restore)");
      expect(rows[0].fields).toContain("providers.blsc.apiKey");
    } finally {
      setProviderKeychainEntryFactoryForTests(null);
    }
  });

  test("expired rotation cleanup during GET and commit records route-specific details", async () => {
    const past = new Date(0).toISOString();
    const key = "ocx_data_0123456789abcdef0123456789abcdef01234567";
    const seedExpired = () => {
      const config = configWithProvider();
      config.apiKeys = [{
        id: "admission-expired", name: "admission", key, createdAt: past,
        pendingRotation: {
          id: "rotation-expired", key, createdAt: past, expiresAt: past,
        },
      }];
      saveConfig(config, { surface: "cli", detail: "ocx first" });
    };

    seedExpired();
    const keysUrl = new URL("http://127.0.0.1:10100/api/keys");
    const list = await handleManagementAPI(
      new Request(keysUrl, { headers: { Host: "127.0.0.1:10100" } }),
      keysUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(list?.status).toBe(200);
    let rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("GET /api/keys (expired rotation cleanup)");
    expect(rows[0].fields).toContain("apiKeys");
    expect(loadConfig().apiKeys?.[0]?.pendingRotation).toBeUndefined();

    seedExpired();
    const commitUrl = new URL("http://127.0.0.1:10100/api/keys/rotate/commit");
    const commit = await handleManagementAPI(
      new Request(commitUrl, {
        method: "POST",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ id: "admission-expired", rotationId: "rotation-expired" }),
      }),
      commitUrl,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(commit?.status).toBe(409);
    rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("POST /api/keys/rotate/commit (expired rotation cleanup)");
    expect(rows[0].fields).toContain("apiKeys");
  });

  test("rotation abort records DELETE /api/keys/rotate", async () => {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const key = "ocx_data_0123456789abcdef0123456789abcdef01234567";
    const config = configWithProvider();
    config.apiKeys = [{
      id: "admission-abort", name: "admission", key, createdAt,
      pendingRotation: {
        id: "rotation-abort", key, createdAt,
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    }];
    saveConfig(config, { surface: "cli", detail: "ocx first" });
    const url = new URL("http://127.0.0.1:10100/api/keys/rotate");
    const response = await handleManagementAPI(
      new Request(url, {
        method: "DELETE",
        headers: { Host: "127.0.0.1:10100", "Content-Type": "application/json" },
        body: JSON.stringify({ id: "admission-abort", rotationId: "rotation-abort" }),
      }),
      url,
      loadConfig(),
      {},
      "admin-token",
    );
    expect(response?.status).toBe(200);
    const rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("api");
    expect(rows[0].detail).toBe("DELETE /api/keys/rotate");
    expect(rows[0].fields).toContain("apiKeys");
    expect(loadConfig().apiKeys?.[0]?.pendingRotation).toBeUndefined();
  });

  test("client connection commit and clear record cli operation details", () => {
    const connection: OcxClientConnectionConfig = {
      serverUrl: "http://127.0.0.1:1",
      managementUrl: "http://127.0.0.1:1",
      managementTransport: "direct",
      selectedClients: ["codex"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "client-key-1",
      tokenFingerprint: "0123456789abcdef".repeat(4),
      protocolVersion: 1,
      connectedAt: new Date(0).toISOString(),
      priorCatalog: "",
      catalogSyncedAt: new Date(0).toISOString(),
    };
    expect(commitClientConnection(connection)).toBe("committed");
    let rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("cli");
    expect(rows[0].detail).toBe("ocx connect: commit client connection");
    expect(clearClientConnection("client-key-1")).toBe("committed");
    rows = readConfigMutationAudit().rows;
    expect(rows[0].surface).toBe("cli");
    expect(rows[0].detail).toBe("ocx disconnect: clear client connection");
  });

  test("GET /api/config/mutations defaults missing, blank, non-positive, or unparseable limits to 100", async () => {
    saveConfig(configWithProvider(), { surface: "api", detail: "PUT /api/audit-seed" });
    saveConfig(configWithProvider(10200), { surface: "api", detail: "PUT /api/audit-seed-2" });
    const config = loadConfig();
    for (const suffix of ["", "?limit=", "?limit=0", "?limit=-1", "?limit=abc", "?limit=1.5"]) {
      const url = new URL(`http://127.0.0.1:10100/api/config/mutations${suffix}`);
      const response = await handleManagementAPI(
        new Request(url, { headers: { Host: "127.0.0.1:10100" } }),
        url,
        config,
        {},
        "admin-token",
      );
      expect(response?.status).toBe(200);
      const body = await response!.json() as { mutations: Array<{ detail?: string }> };
      // Two mutations make the fallback limit (100) distinguishable from limit=1: the
      // fallback must return more than one row, while an explicit limit=1 returns one.
      expect(body.mutations.length).toBeGreaterThan(1);
      expect(body.mutations[0]?.detail).toBe("PUT /api/audit-seed-2");
    }
    const limited = new URL("http://127.0.0.1:10100/api/config/mutations?limit=1");
    const limitedResponse = await handleManagementAPI(
      new Request(limited, { headers: { Host: "127.0.0.1:10100" } }),
      limited,
      config,
      {},
      "admin-token",
    );
    const limitedBody = await limitedResponse!.json() as { mutations: unknown[] };
    expect(limitedBody.mutations).toHaveLength(1);
  });

  test("DELETE /api/codex-auth/accounts records the API source in the audit", async () => {
    const live = configWithProvider();
    live.codexAccounts = [{ id: "audit-delete", email: "audit-delete@example.test", isMain: false }];
    saveConfig(live, { surface: "internal", detail: "test: seed account" });
    saveCodexAccountCredential("audit-delete", {
      accessToken: "access-delete-audit",
      refreshToken: "refresh-delete-audit",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-delete-audit",
    });
    const config = loadConfig();
    const req = new Request("http://localhost/api/codex-auth/accounts?id=audit-delete", { method: "DELETE" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp?.status).toBe(200);
    expect(config.codexAccounts).toEqual([]);
    const { rows } = readConfigMutationAudit();
    expect(rows[0]).toMatchObject({ surface: "api", detail: "DELETE /api/codex-auth/accounts" });
    expect(JSON.stringify(rows[0].fields)).not.toContain("access-delete-audit");
  });
});
