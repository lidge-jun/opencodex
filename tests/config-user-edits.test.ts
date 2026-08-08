import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armClaudeCodeBaseline,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  mutatePersistedConfig,
  readConfigDiagnostics,
  reconcileLiveConfigFromDisk,
  saveConfig,
  saveConfigPreservingClaudeCode,
  validateConfigCandidate,
} from "../src/config";
import { legacyCustomModelCatalogSlugs } from "../src/codex/custom-model-catalog-migration";
import { rateLimitRetryPolicyFor } from "../src/providers/key-failover";
import type { OcxConfig } from "../src/types";

/**
 * A user hand-edits `config.json` while the proxy runs. `saveConfig` serializes the
 * WHOLE object, so ANY later service-time save rewrites `claudeCode` from memory and
 * the edit vanishes with no visible cause (#488, devlog 260726_claude_auth_auto/040 H1).
 */

let home: string;
let previousHome: string | undefined;

/** Merge a patch into the on-disk config.json, simulating a user hand-edit. */
function writeDiskConfig(patch: Record<string, unknown>): void {
  const current = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
  writeFileSync(getConfigPath(), JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
}

/** Read the current on-disk config.json as a plain record. */
function diskConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
}

/** Seed the exact pre-version shape: custom models exist, but no migration cutover does. */
function writePreVersionCustomConfig(patch: Record<string, unknown> = {}): void {
  const current = diskConfig();
  delete current.customModelCatalogMigration;
  writeFileSync(getConfigPath(), JSON.stringify({
    ...current,
    customModels: [customModel("legacy-model")],
    ...patch,
  }, null, 2) + "\n");
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-user-edits-"));
  process.env.OPENCODEX_HOME = home;
  saveConfig({
    port: 10100,
    defaultProvider: "test",
    providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true } },
    claudeCode: { authMode: "subscription" },
  } as unknown as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function customModel(modelId: string): NonNullable<OcxConfig["customModels"]>[number] {
  return {
    id: `custom-${modelId}`,
    provider: "test",
    modelId,
    addedAt: "2026-08-08T00:00:00.000Z",
  };
}

test("whole-config saves durably capture a pre-version custom-model slug", () => {
  writePreVersionCustomConfig();
  const withoutCustom = loadConfig();
  delete withoutCustom.customModels;
  saveConfig(withoutCustom);

  expect(legacyCustomModelCatalogSlugs(withoutCustom)).toEqual(
    new Set(["test/legacy-model"]),
  );
  expect(diskConfig().customModelCatalogMigration).toEqual({
    version: 1,
    legacyOwnedSlugs: ["test/legacy-model"],
  });
});

test("guarded binding saves project legacy ownership back onto the live config", () => {
  writePreVersionCustomConfig();
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  reconcileLiveConfigFromDisk(live, structuredClone(live));
  delete live.customModels;
  saveConfigPreservingClaudeCode(live);

  expect(legacyCustomModelCatalogSlugs(live)).toEqual(new Set(["test/legacy-model"]));
  expect(diskConfig().customModelCatalogMigration).toEqual({
    version: 1,
    legacyOwnedSlugs: ["test/legacy-model"],
  });
});

test("field-scoped persisted mutations use the final disk snapshot for legacy ownership", () => {
  writePreVersionCustomConfig();
  const outcome = mutatePersistedConfig(config => {
    delete config.customModels;
    return { changed: true, value: "removed" };
  });

  expect(outcome).toEqual({ status: "committed", value: "removed" });
  expect(legacyCustomModelCatalogSlugs(loadConfig())).toEqual(
    new Set(["test/legacy-model"]),
  );
});

test("post-version custom models never expand legacy ownership", () => {
  const live = loadConfig();
  live.customModels = [customModel("new-model")];
  saveConfig(live);
  expect(legacyCustomModelCatalogSlugs(live)).toEqual(new Set());

  delete live.customModels;
  saveConfig(live);
  expect(legacyCustomModelCatalogSlugs(live)).toEqual(new Set());
  expect(diskConfig().customModelCatalogMigration).toEqual({
    version: 1,
    legacyOwnedSlugs: [],
  });
});

test("unrelated recoverable config damage does not hide pre-version ownership", () => {
  writePreVersionCustomConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { attempts: "bad" },
      },
    },
  });
  const live = loadConfig();
  delete live.customModels;
  saveConfig(live);

  expect(legacyCustomModelCatalogSlugs(live)).toEqual(new Set(["test/legacy-model"]));
});

test("a future migration state survives an older save and grants no deletion authority", () => {
  const futureState = { version: 2, opaque: { keep: true } };
  writeDiskConfig({
    customModels: [customModel("legacy-model")],
    customModelCatalogMigration: futureState,
  });
  const live = loadConfig();
  delete live.customModels;

  saveConfig(live);

  expect(diskConfig().customModelCatalogMigration).toEqual(futureState);
  expect(loadConfig().providers.test).toBeDefined();
  expect(legacyCustomModelCatalogSlugs(live)).toEqual(new Set());
});

test("a hand edit made while the service holds memory survives a guarded save", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  saveConfigPreservingClaudeCode(live);

  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
  expect(live.claudeCode?.authMode).toBe("proxy");
});

// THE case the per-writer design could not cover: the save that clobbers `claudeCode`
// does not touch `claudeCode` at all.
test("an unrelated save does not clobber the hand edit", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  live.disabledModels = ["test/one"];
  saveConfigPreservingClaudeCode(live);

  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
  expect(diskConfig().disabledModels).toEqual(["test/one"]);
});

test("an unrelated save does not resurrect an invalid persisted subagent effort", () => {
  writeDiskConfig({ claudeCode: { authMode: "subscription", subagentEffort: "ultra" } });
  const live = loadConfig();
  armClaudeCodeBaseline(live);

  live.disabledModels = ["test/one"];
  saveConfigPreservingClaudeCode(live);

  expect(live.claudeCode).toEqual({ authMode: "subscription" });
  expect(diskConfig().claudeCode).toEqual({ authMode: "subscription" });
});

// R3-2: arming must be eager. A lazy "arm on first save" loses exactly this edit.
test("an edit made before the first save still survives", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);           // startup
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });  // user edits, no save yet
  live.port = 10101;
  saveConfigPreservingClaudeCode(live);  // the service's FIRST save

  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

// R3-2: the baseline is per instance, so an unrelated loadConfig() cannot refresh it.
test("an unrelated loadConfig does not refresh the armed baseline", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  const other = loadConfig();            // some CLI path elsewhere
  expect(other.claudeCode?.authMode).toBe("proxy");

  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

test("an invalid retryOn429 field degrades at load instead of discarding the config", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { attempts: 0, attempt: 5, intervalMs: 120, respectRetryAfter: false },
      },
    },
  });
  const live = loadConfig();
  expect(live.providers.test).toBeDefined();
  // Invalid field (attempts: 0) and the misnamed key (attempt) dropped with warnings;
  // valid fields kept; missing fields defaulted.
  expect(live.providers.test.retryOn429).toEqual({ intervalMs: 120, respectRetryAfter: false });
});

test("a non-object retryOn429 degrades at load instead of discarding the config", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: "enabled",
      },
    },
  });
  const live = loadConfig();
  expect(live.providers.test).toBeDefined();
  expect(live.providers.test.retryOn429).toBeUndefined();
});

test("an invalid retryOn429 master switch discards the policy instead of enabling it", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { enabled: "false", intervalMs: 120 },
      },
    },
  });
  const live = loadConfig();
  expect(live.providers.test).toBeDefined();
  // A hand-edit that tried to disable retries must not become default-ENABLED.
  expect(live.providers.test.retryOn429).toBeUndefined();
});

test("a retryOn429 policy with every field invalid is dropped instead of enabling retries", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        // Every supplied field invalid: the sanitizer must NOT write back {} — presence
        // would opt IN to retries with defaults, the opposite of a disable-oriented
        // hand-edit like `attempts: 0`.
        retryOn429: { attempts: 0 },
      },
    },
  });
  const live = loadConfig();
  expect(live.providers.test.retryOn429).toBeUndefined();
  expect(rateLimitRetryPolicyFor(live.providers.test)).toBeNull();
});

test("an intentionally empty retryOn429 policy still resolves as enabled (presence = opt-in)", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: {},
      },
    },
  });
  const live = loadConfig();
  expect(live.providers.test.retryOn429).toEqual({});
  // Object presence is the opt-in contract: an explicit `retryOn429: {}` resolves to the
  // enabled defaults, exactly like the documented hand-written config.
  expect(rateLimitRetryPolicyFor(live.providers.test)).toEqual({
    enabled: true,
    attempts: 3,
    intervalMs: 5_000,
    maxIntervalMs: 60_000,
    respectRetryAfter: true,
  });
});

test("config diagnostics sanitize invalid retryOn429 before schema validation", () => {
  writeDiskConfig({
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        retryOn429: { attempts: 0 },
      },
    },
  });
  const diagnostics = readConfigDiagnostics();
  // Without sanitization the schema rejects the config and the diagnostics path returns a
  // default fallback, which the config command could persist over the user's providers.
  expect(diagnostics.source).not.toBe("fallback");
  expect(diagnostics.config.providers.test).toBeDefined();
  expect(diagnostics.config.providers.test.retryOn429).toBeUndefined();
});

test("invalid retryOn429 values never log the raw value", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeDiskConfig({
      providers: {
        test: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          allowPrivateNetwork: true,
          retryOn429: "sk-super-secret-abc123",
        },
      },
    });
    loadConfig();
    const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
    expect(logged).not.toContain("sk-super-secret-abc123");
    // Anchor the type-only diagnostic to the exact field so unrelated warnings can't satisfy it.
    expect(logged).toContain('providers."test".retryOn429 (string) is invalid');
  } finally {
    warn.mockRestore();
  }
});

test("unrecognized retryOn429 field names are redacted before logging", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeDiskConfig({
      providers: {
        test: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          allowPrivateNetwork: true,
          retryOn429: { "sk-super-secret-9876": true, intervalMs: 120 },
        },
      },
    });
    const live = loadConfig();
    expect(live.providers.test.retryOn429).toEqual({ intervalMs: 120 });
    const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
    // The secret-shaped property NAME must never reach the log; the valid field survives.
    expect(logged).not.toContain("sk-super-secret-9876");
    expect(logged).toContain("[REDACTED]");
  } finally {
    warn.mockRestore();
  }
});

test("unrecognized retryOn429 field names are JSON-escaped before logging", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeDiskConfig({
      providers: {
        test: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          allowPrivateNetwork: true,
          retryOn429: { "evil\nattempt": true, intervalMs: 120 },
        },
      },
    });
    const live = loadConfig();
    expect(live.providers.test.retryOn429).toEqual({ intervalMs: 120 });
    const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
    // The raw control character must never reach the log (no line forging); the escaped form
    // still names the field for typo debugging.
    expect(logged).not.toContain("evil\nattempt");
    expect(logged).toContain('"evil\\nattempt"');
  } finally {
    warn.mockRestore();
  }
});

test("provider names are redacted before retryOn429 load warnings", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeDiskConfig({
      providers: {
        "sk-super-secret-9876": {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          allowPrivateNetwork: true,
          retryOn429: "enabled",
        },
      },
    });
    loadConfig();
    const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
    // The sanitizer runs before schema validation, so a secret-shaped provider NAME must
    // never reach the log either.
    expect(logged).not.toContain("sk-super-secret-9876");
    expect(logged).toContain("[REDACTED]");
  } finally {
    warn.mockRestore();
  }
});

test("provider names with control characters are JSON-escaped before retryOn429 load warnings", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeDiskConfig({
      providers: {
        "evil\nprovider": {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          allowPrivateNetwork: true,
          retryOn429: "enabled",
        },
      },
    });
    loadConfig();
    const logged = warn.mock.calls.map(call => call.join(" ")).join("\n");
    // The raw newline must never forge a log line; the escaped form still names the provider.
    expect(logged).not.toContain("evil\nprovider");
    expect(logged).toContain('"evil\\nprovider"');
  } finally {
    warn.mockRestore();
  }
});

// R4-1: the request path. A 429 mid-turn rotates a key and saves, with no user action.
test("a 429 key rotation does not clobber the hand edit", async () => {
  const { rotateKeyOn429 } = await import("../src/providers/key-failover");
  const live = loadConfig();
  live.providers.pool = {
    adapter: "openai-chat",
    baseUrl: "http://127.0.0.1:1/v1",
    allowPrivateNetwork: true,
    apiKey: "key-a",
    apiKeyPool: [
      { id: "a", key: "key-a" },
      { id: "b", key: "key-b" },
    ],
  } as never;
  saveConfig(live);
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  const rotated = rotateKeyOn429(live, "pool", null, Date.now(), "key-a");
  expect(rotated?.apiKey).toBe("key-b");
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

// Both sides changed: ours wins and the baseline rebases, so the NEXT edit starts fresh.
test("our own change wins a conflict and rebases the baseline", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });
  live.claudeCode = { authMode: "subscription", systemEnv: true };

  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("subscription");

  // Rebased: a fresh hand edit on top of OUR value is preserved by the next save.
  writeDiskConfig({ claudeCode: { authMode: "proxy", systemEnv: true } });
  live.port = 10102;
  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

test("OAuth reconciliation keeps a pending live Claude subtree authoritative", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  const persistedBaseline = loadConfig();
  live.claudeCode = { authMode: "subscription", systemEnv: true };
  live.disabledModels = ["pending/model"];
  writeDiskConfig({
    claudeCode: { authMode: "proxy" },
    contextCapValue: 240_000,
  });

  reconcileLiveConfigFromDisk(live, persistedBaseline);

  expect(live.claudeCode).toEqual({ authMode: "subscription", systemEnv: true });
  expect(live.disabledModels).toEqual(["pending/model"]);
  expect(live.contextCapValue).toBe(240_000);

  saveConfigPreservingClaudeCode(live);
  expect(diskConfig().claudeCode).toEqual({ authMode: "subscription", systemEnv: true });
  expect(diskConfig().disabledModels).toEqual(["pending/model"]);
  expect(diskConfig().contextCapValue).toBe(240_000);
});

test("OAuth reconciliation adopts a guarded Claude edit that predates its disk snapshot", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });
  const persistedBaseline = loadConfig();

  reconcileLiveConfigFromDisk(live, persistedBaseline);

  expect(live.claudeCode).toEqual({ authMode: "proxy" });
  saveConfigPreservingClaudeCode(live);
  expect(diskConfig().claudeCode).toEqual({ authMode: "proxy" });
});

// Structural compare, not JSON.stringify: key order must not fake an external edit.
test("a key-order-only difference is not treated as an external edit", () => {
  const live = loadConfig();
  live.claudeCode = { authMode: "subscription", systemEnv: true };
  saveConfig(live);
  armClaudeCodeBaseline(live);
  writeDiskConfig({ claudeCode: { systemEnv: true, authMode: "subscription" } });

  live.claudeCode = { authMode: "proxy", systemEnv: true };
  saveConfigPreservingClaudeCode(live);
  // No spurious "their edit wins" branch: our real change lands.
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

test("an unreadable config file never fails the save", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeFileSync(getConfigPath(), "{ not json");

  live.claudeCode = { authMode: "proxy" };
  expect(() => saveConfigPreservingClaudeCode(live)).not.toThrow();
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("proxy");
});

// An UNARMED config (a short-lived CLI load) behaves exactly like the old saveConfig.
test("an unarmed config saves without reconciliation", () => {
  const live = loadConfig();
  writeDiskConfig({ claudeCode: { authMode: "proxy" } });

  live.claudeCode = { authMode: "subscription" };
  saveConfigPreservingClaudeCode(live);
  expect((diskConfig().claudeCode as Record<string, unknown>).authMode).toBe("subscription");
});

// DOCUMENTED RESIDUAL, asserted so it cannot drift into an assumed guarantee: only the
// `claudeCode` subtree is reconciled. A hand edit to `providers` is still lost.
test("a providers hand edit is NOT preserved", () => {
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  writeDiskConfig({ providers: { handEdited: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:2/v1", allowPrivateNetwork: true } } });

  live.port = 10103;
  saveConfigPreservingClaudeCode(live);
  expect(Object.keys(diskConfig().providers as Record<string, unknown>)).toEqual(["test"]);
});

test("upstreamHostCircuitThreshold live writes accept only integer values from 0 through 20", () => {
  for (const value of [0, 1, 20]) {
    expect(validateConfigCandidate({ ...getDefaultConfig(), upstreamHostCircuitThreshold: value }).ok).toBe(true);
  }
  for (const value of [-1, 1.5, 21, "3", null]) {
    const result = validateConfigCandidate({ ...getDefaultConfig(), upstreamHostCircuitThreshold: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("upstreamHostCircuitThreshold");
  }
});

test("a malformed upstreamHostCircuitThreshold hand edit disables only the circuit and warns", () => {
  writeDiskConfig({ upstreamHostCircuitThreshold: 999 });
  const diagnostics = readConfigDiagnostics();
  expect(diagnostics.source).toBe("file");
  expect(diagnostics.config.upstreamHostCircuitThreshold).toBeUndefined();
  expect(diagnostics.warnings).toContain(
    "upstreamHostCircuitThreshold ignored: expected an integer from 0 to 20",
  );
  expect(diagnostics.config.providers.test).toBeDefined();
});
