import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildConfigMutationSnapshot,
  loadConfig,
  mutatePersistedConfig,
  readConfigMutationAudit,
  saveConfig,
  saveConfigPreservingClaudeCode,
  setConfigAuditMaxRowsForTests,
} from "../src/config";
import type { OcxConfig } from "../src/types";
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

describe("config mutation audit log", () => {
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

  test("a secret-shaped provider name is redacted in the changed-field paths", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers["sk-live-abcdefghijklmnopqrstuvwxyz012345"] = {
        adapter: "openai-chat",
        baseUrl: "https://example.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      return { changed: true, value: true };
    }, { surface: "api", detail: "PUT /api/providers" });
    expect(outcome.status).toBe("committed");
    const { rows } = readConfigMutationAudit();
    expect(JSON.stringify(rows[0].fields)).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz012345");
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

  test("redacted field labels stay unique when distinct paths collapse", () => {
    saveConfig(configWithProvider());
    const outcome = mutatePersistedConfig(persisted => {
      persisted.providers["sk-live-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] = {
        adapter: "openai-chat",
        baseUrl: "https://a.invalid/v1",
      } as unknown as OcxConfig["providers"][string];
      persisted.providers["sk-live-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] = {
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
    writeFileSync(join(testRoot, "config-mutation-pending.json"), JSON.stringify({
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
    expect(existsSync(join(testRoot, "config-mutation-pending.json"))).toBe(false);
  });

  test("a pending marker whose rename never landed is dropped without a phantom row", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(join(testRoot, "config-mutation-pending.json"), JSON.stringify({
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
    expect(existsSync(join(testRoot, "config-mutation-pending.json"))).toBe(false);
  });

  test("the read path replays an orphaned pending marker without duplicating", () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    const configPath = join(testRoot, "config.json");
    const bytes = JSON.stringify(configWithProvider(10500), null, 2) + "\n";
    writeFileSync(configPath, bytes);
    writeFileSync(join(testRoot, "config-mutation-pending.json"), JSON.stringify({
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
    expect(existsSync(join(testRoot, "config-mutation-pending.json"))).toBe(false);
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
  });
});
