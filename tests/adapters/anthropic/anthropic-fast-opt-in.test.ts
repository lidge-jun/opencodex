import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../../src/config";
import { inheritedFastWireConflictProviderNames } from "../../../src/config/load-degrade";
import { fastSwitchOff, providerFastSwitchOff } from "../../../src/providers/fast-opt-in";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { decideTier } from "../../../src/providers/fastwire";
import { fastPolicyForModel } from "../../../src/providers/service-tier";
import { captureRouteStaticPolicy, routedProviderConfig } from "../../../src/router";
import { startServer } from "../../../src/server";
import { catalogFastRowEligible } from "../../../src/server/fast-row";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { managementFetch as fetch } from "../../helpers/management-auth";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

/**
 * Anthropic fast mode draws usage credits at 2x price, so the `anthropic` and `anthropic-apikey`
 * registry entries mark their Fast lane opt-in: it stays off until `fastEnabled: true`
 * (devlog/_plan/260924_anthropic_fast_opt_in).
 */

setDefaultTimeout(60_000);

const FAST_MODEL = "claude-opus-5-5";

function anthropic(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "key",
    apiKey: "test-token",
    models: [FAST_MODEL],
    ...overrides,
  } as OcxProviderConfig;
}

describe("Anthropic Fast opt-in", () => {
  test("both Anthropic registry entries are opt-in and Cursor is not", () => {
    expect(getProviderRegistryEntry("anthropic")?.fastOptIn).toBe(true);
    expect(getProviderRegistryEntry("anthropic-apikey")?.fastOptIn).toBe(true);
    expect(getProviderRegistryEntry("cursor")?.fastOptIn).toBeUndefined();
    expect(getProviderRegistryEntry("openai")?.fastOptIn).toBeUndefined();
  });

  test("the switch reads the operator value before the registry default", () => {
    expect(providerFastSwitchOff("anthropic-apikey", {})).toBe(true);
    expect(providerFastSwitchOff("anthropic-apikey", { fastEnabled: true })).toBe(false);
    expect(providerFastSwitchOff("cursor", {})).toBe(false);
    expect(providerFastSwitchOff("cursor", { fastEnabled: false })).toBe(true);
    expect(providerFastSwitchOff(undefined, {})).toBe(false);
    expect(fastSwitchOff({}, { fastOptIn: true })).toBe(true);
  });

  test("default off: the Fast policy denies, drops forced fast mode, and publishes no --fast row", () => {
    for (const name of ["anthropic", "anthropic-apikey"]) {
      const policy = fastPolicyForModel(anthropic(), FAST_MODEL, name);
      expect(policy).toMatchObject({ capability: false, eligibility: "capability-unsupported" });
      expect(decideTier(policy, true, "priority")).toEqual({ kind: "drop" });
      const config = { providers: { [name]: anthropic() } } as unknown as OcxConfig;
      expect(catalogFastRowEligible(config, { provider: name, id: FAST_MODEL })).toBe(false);
    }
  });

  test("fastEnabled: true restores the documented fast lane and its speed value", () => {
    const policy = fastPolicyForModel(anthropic({ fastEnabled: true }), FAST_MODEL, "anthropic-apikey");
    expect(policy).toMatchObject({ capability: true, eligibility: "eligible" });
    expect(decideTier(policy, true, undefined)).toEqual({ kind: "set", value: "fast" });
    const config = { providers: { "anthropic-apikey": anthropic({ fastEnabled: true }) } } as unknown as OcxConfig;
    expect(catalogFastRowEligible(config, { provider: "anthropic-apikey", id: FAST_MODEL })).toBe(true);
    // Unsupported models stay unclassified even when the switch is on.
    expect(fastPolicyForModel(anthropic({ fastEnabled: true }), "claude-sonnet-5", "anthropic-apikey").eligibility)
      .toBe("unclassified");
  });

  test("fastEnabled: false denies an ordinary service-tier provider", () => {
    const relay = { adapter: "openai-responses", baseUrl: "https://relay.example/v1", supportsServiceTier: true } as OcxProviderConfig;
    expect(fastPolicyForModel(relay, "gpt-x", "relay").eligibility).toBe("eligible");
    expect(fastPolicyForModel({ ...relay, fastEnabled: false }, "gpt-x", "relay").eligibility)
      .toBe("capability-unsupported");
  });

  test("static model policy and the routed provider carry the denial", () => {
    const off = captureRouteStaticPolicy("anthropic-apikey", FAST_MODEL, anthropic());
    expect(off.model.supportsServiceTier).toBe(false);
    expect(off.model.fastTierDescription).toBeUndefined();
    const on = captureRouteStaticPolicy("anthropic-apikey", FAST_MODEL, anthropic({ fastEnabled: true }));
    expect(on.model.supportsServiceTier).toBe(true);

    // A policy resolved without the provider name still refuses on the routed provider.
    const routed = routedProviderConfig("anthropic-apikey", anthropic());
    expect(routed.supportsServiceTier).toBe(false);
    expect(fastPolicyForModel(routed, FAST_MODEL).eligibility).toBe("capability-unsupported");
    expect(routedProviderConfig("anthropic-apikey", anthropic({ fastEnabled: true })).supportsServiceTier).toBeUndefined();
  });

  test("an off switch is not reported as a fastWire=null conflict", () => {
    const config = { providers: { "anthropic-apikey": anthropic({ fastWire: null }) } } as unknown as OcxConfig;
    expect(inheritedFastWireConflictProviderNames(config)).toEqual([]);
    const enabled = { providers: { "anthropic-apikey": anthropic({ fastWire: null, fastEnabled: true }) } } as unknown as OcxConfig;
    expect(inheritedFastWireConflictProviderNames(enabled)).toEqual(["anthropic-apikey"]);
  });
});

describe("Anthropic Fast switch over the management API", () => {
  const previousHome = process.env.OPENCODEX_HOME;
  const testDir = mkdtempSync(join(tmpdir(), "ocx-anthropic-fast-opt-in-"));
  afterAll(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(testDir);
  });

  test("GET reports the opt-in switch and PATCH sets, clears, and rejects fastEnabled", async () => {
    process.env.OPENCODEX_HOME = testDir;
    saveConfig({
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "relay",
      providers: {
        relay: { adapter: "openai-chat", baseUrl: "https://relay.example/v1", apiKey: "sk-relay" },
        "anthropic-apikey": anthropic(),
      },
    } as OcxConfig);
    const server = startServer(0);
    const patch = (body: unknown) => fetch(new URL("/api/providers?name=anthropic-apikey", server.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const summary = async (name: string) => {
      const response = await fetch(new URL("/api/providers", server.url));
      const rows = await response.json() as Array<{ name: string; fastOptIn?: { enabled: boolean } }>;
      return rows.find(row => row.name === name);
    };
    try {
      expect((await summary("anthropic-apikey"))?.fastOptIn).toEqual({ enabled: false });
      expect(await summary("relay")).not.toHaveProperty("fastOptIn");

      const reject = await patch({ fastEnabled: "yes" });
      expect(reject.status).toBe(400);
      expect(await reject.json()).toMatchObject({ error: "fastEnabled must be a boolean or null" });

      expect((await patch({ fastEnabled: true })).status).toBe(200);
      expect(loadConfig().providers["anthropic-apikey"]?.fastEnabled).toBe(true);
      expect((await summary("anthropic-apikey"))?.fastOptIn).toEqual({ enabled: true });

      // A full provider save from the edit form omits the PATCH-owned switch and keeps it.
      const overwrite = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "anthropic-apikey",
          provider: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", note: "edited" },
        }),
      });
      expect(overwrite.status).toBe(200);
      expect(loadConfig().providers["anthropic-apikey"]?.fastEnabled).toBe(true);

      expect((await patch({ fastEnabled: null })).status).toBe(200);
      expect(loadConfig().providers["anthropic-apikey"]).not.toHaveProperty("fastEnabled");
      expect((await summary("anthropic-apikey"))?.fastOptIn).toEqual({ enabled: false });
    } finally {
      await server.stop(true);
    }
  });
});
