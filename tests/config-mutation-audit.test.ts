import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    expect(JSON.stringify(rows)).toContain("10104");
    expect(JSON.stringify(rows)).not.toContain("10100");
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
});

describe("config mutation audit management API", () => {
  test("GET /api/config/mutations returns the bounded trail newest-first", async () => {
    saveConfig(configWithProvider(10100), { surface: "cli", detail: "ocx first" });
    saveConfig(configWithProvider(10200), { surface: "api", detail: "PUT /api/test" });
    const response = await handleManagementAPI(
      new Request("http://127.0.0.1:10100/api/config/mutations?limit=1", { headers: { Host: "127.0.0.1:10100" } }),
      new URL("http://127.0.0.1:10100/api/config/mutations?limit=1"),
      loadConfig(),
    );
    expect(response).not.toBeNull();
    const body = await response!.json() as { mutations: Array<{ detail: string }>; retention: { maxRows: number } };
    expect(body.mutations).toHaveLength(1);
    expect(body.mutations[0].detail).toBe("PUT /api/test");
    expect(body.retention.maxRows).toBe(5);
  });
});
