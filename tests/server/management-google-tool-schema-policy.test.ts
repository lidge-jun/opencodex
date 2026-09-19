import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, saveConfig } from "../../src/config";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { providerEditorConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function config(policy?: "compatible" | "reject-lossy"): OcxConfig {
  return {
    port: 0,
    defaultProvider: "google",
    providers: {
      google: {
        adapter: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
        googleMode: "ai-studio",
        ...(policy ? { googleToolSchemaPolicy: policy } : {}),
      },
    },
  };
}

test("Google tool-schema policy validates, persists, and stays absent when omitted", () => {
  const testDir = mkdtempSync(join(tmpdir(), "ocx-google-tool-schema-policy-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  try {
    for (const policy of ["compatible", "reject-lossy"] as const) {
      saveConfig(config(policy));
      const loaded = loadConfig();
      expect(loaded.providers.google?.googleToolSchemaPolicy).toBe(policy);
      saveConfig(loaded);
      expect(loadConfig().providers.google?.googleToolSchemaPolicy).toBe(policy);
    }

    saveConfig(config());
    const omitted = loadConfig();
    expect(omitted.providers.google?.googleToolSchemaPolicy).toBeUndefined();
    saveConfig(omitted);
    expect(loadConfig().providers.google?.googleToolSchemaPolicy).toBeUndefined();

    const invalid = config() as unknown as Record<string, unknown>;
    (invalid.providers as Record<string, Record<string, unknown>>).google!.googleToolSchemaPolicy = "silent-loss";
    const validation = validateConfigCandidate(invalid);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.error).toContain("googleToolSchemaPolicy");
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
  }
});

test("provider editor round-trips valid policy and rejects an unknown value without mutation", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "ocx-google-tool-schema-editor-"));
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  const live = config("compatible");
  saveConfig(live);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  const request = async (body: unknown) => {
    const url = new URL("http://localhost/api/providers");
    return (await handleManagementAPI(new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), url, live, { createManagementConvergeCodex: catalogConvergenceFactory() }))!;
  };
  try {
    const baseline = providerEditorConfigDTO(loadConfig());
    expect(baseline.providers.google?.googleToolSchemaPolicy).toBe("compatible");
    const next = structuredClone(baseline);
    next.providers.google!.googleToolSchemaPolicy = "reject-lossy";
    const accepted = await request({ baseline, next });
    expect(accepted.status, await accepted.text()).toBe(200);
    expect(live.providers.google?.googleToolSchemaPolicy).toBe("reject-lossy");
    expect(loadConfig().providers.google?.googleToolSchemaPolicy).toBe("reject-lossy");

    const stable = providerEditorConfigDTO(loadConfig());
    const invalid = structuredClone(stable) as unknown as {
      providers: Record<string, Record<string, unknown>>;
    };
    invalid.providers.google!.googleToolSchemaPolicy = "silent-loss";
    const beforeBytes = readFileSync(join(testDir, "config.json"), "utf8");
    const rejected = await request({ baseline: stable, next: invalid });
    expect(rejected.status).toBe(400);
    expect(live.providers.google?.googleToolSchemaPolicy).toBe("reject-lossy");
    expect(readFileSync(join(testDir, "config.json"), "utf8")).toBe(beforeBytes);
  } finally {
    resolved.mockRestore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
  }
});
