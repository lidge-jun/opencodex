import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfigCandidate } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { clearModelCache, getStaleCached, setCached } from "../../src/codex/model-cache";
import * as destinationPolicy from "../../src/lib/destination-policy";
import * as stateStores from "../../src/lib/state-store-registrations";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { providerEditorConfigDTO, safeConfigDTO } from "../../src/server/auth-cors";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;
let destination: ReturnType<typeof spyOn<typeof destinationPolicy, "providerDestinationResolvedError">>;
let reconcile: ReturnType<typeof spyOn<typeof stateStores, "reconcileLiveStateStores">>;

beforeEach(() => {
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-provider-inference-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.CODEX_HOME);
  // Direct handler calls only: no listener, DNS, provider discovery, or client convergence.
  destination = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  reconcile = spyOn(stateStores, "reconcileLiveStateStores").mockReturnValue({ storesVisited: 0, rowsRemoved: 0 });
  const acl = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => acl);
  setAsyncIcaclsRunnerForTests(async () => acl);
});

afterEach(async () => {
  try {
    await flushConfigDirHardeningForTests();
    clearModelCache();
  } finally {
    destination.mockRestore();
    reconcile.mockRestore();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOcxHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(home);
  }
});

function harness(inferContextWindow?: boolean) {
  const config: OcxConfig = {
    port: 10100, defaultProvider: "relay", openaiProviderTierVersion: 2,
    providers: { relay: {
      adapter: "openai-chat", baseUrl: "https://relay.example.test/v1", liveModels: false,
      models: ["claude-opus-5-5"],
      ...(inferContextWindow === undefined ? {} : { inferContextWindow }),
    } },
  };
  const events: string[] = [];
  const path = join(home, "config.json");
  // The injectable writer owns exactly this fixture file; reload uses the real config schema.
  const persist = (saved: OcxConfig) => writeFileSync(path, JSON.stringify(saved));
  persist(config);
  async function request(method: "GET" | "PATCH" | "POST", body?: unknown) {
    const url = new URL("http://127.0.0.1/api/providers?name=relay");
    const response = await handleProviderRoutes({
      req: new Request(url, { method, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      url, config, version: "test", trustedLoopbackIngress: true, guiSessionIssuance: null,
      deps: { saveConfigPreservingClaudeCode: saved => { events.push("save"); persist(saved); } },
      convergeCodexCatalog: async () => {
        events.push("catalog");
        return { status: "committed", changed: false, degraded: false, notices: [] };
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    if (!response) throw new Error("provider route did not handle fixture request");
    return response;
  }
  return {
    config, events, path, request,
    post: (fields: Record<string, unknown> = {}) => request("POST", { name: "relay", provider: {
      adapter: "openai-chat", baseUrl: "https://relay.example.test/v1", liveModels: false,
      models: ["claude-opus-5-5"], ...fields,
    } }),
    row: async () => ((await (await request("GET")).json()) as Array<OcxProviderConfig & { name: string }>)
      .find(provider => provider.name === "relay")!,
  };
}

describe("provider context inference management", () => {
  test("PATCH true, false and null survive GET/reload and invalidate the catalog", async () => {
    const h = harness();
    expect(await h.row()).not.toHaveProperty("inferContextWindow");
    for (const value of [true, false, null]) {
      setCached("relay", []);
      expect((await h.request("PATCH", { inferContextWindow: value })).status).toBe(200);
      expect(h.config.providers.relay!.inferContextWindow).toBe(value ?? undefined);
      expect((await h.row()).inferContextWindow).toBe(value ?? undefined);
      expect(loadConfig().providers.relay!.inferContextWindow).toBe(value ?? undefined);
      expect(getStaleCached("relay")).toBeNull();
    }
    expect(await h.row()).not.toHaveProperty("inferContextWindow");
    expect(h.events).toEqual(["save", "catalog", "save", "catalog", "save", "catalog"]);
  });

  test("PATCH rejects non-booleans without applying a valid sibling field", async () => {
    const h = harness(true);
    const before = readFileSync(h.path, "utf8");
    for (const value of [0, 1, "true", "false", {}, []]) {
      const response = await h.request("PATCH", { inferContextWindow: value, note: "must not save" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "inferContextWindow must be a boolean or null" });
      expect(h.config.providers.relay!.inferContextWindow).toBe(true);
      expect(h.config.providers.relay!.note).toBeUndefined();
      expect(readFileSync(h.path, "utf8")).toBe(before);
    }
    expect(h.events).toEqual([]);
  });

  test.each([true, false])("POST omission retains stored %s; explicit false wins", async value => {
    const h = harness(value);
    expect((await h.post({ defaultModel: "claude-opus-5-5" })).status).toBe(200);
    expect(h.config.providers.relay!.inferContextWindow).toBe(value);
    expect(loadConfig().providers.relay!.inferContextWindow).toBe(value);
    expect((await h.row()).inferContextWindow).toBe(value);
    expect((await h.post({ inferContextWindow: false })).status).toBe(200);
    expect(loadConfig().providers.relay!.inferContextWindow).toBe(false);
  });

  test("explicit POST values round-trip while invalid values and POST null fail schema validation", async () => {
    const h = harness();
    for (const value of [true, false]) {
      expect((await h.post({ inferContextWindow: value })).status).toBe(200);
      expect((await h.row()).inferContextWindow).toBe(value);
      expect(loadConfig().providers.relay!.inferContextWindow).toBe(value);
      expect(providerEditorConfigDTO(h.config).providers.relay!.inferContextWindow).toBe(value);
      expect(safeConfigDTO(h.config)).toHaveProperty("providers.relay.inferContextWindow", value);
    }
    const before = readFileSync(h.path, "utf8");
    for (const value of [null, 1, "true", {}, []]) {
      expect((await h.post({ inferContextWindow: value })).status).toBe(400);
      expect(readFileSync(h.path, "utf8")).toBe(before);
      expect(h.config.providers.relay!.inferContextWindow).toBe(false);
      expect(validateConfigCandidate({ ...h.config, providers: { relay: {
        ...h.config.providers.relay, inferContextWindow: value,
      } } }).ok).toBe(false);
    }
  });

  for (const value of [true, false, null]) {
    test(`POST omission keeps a concurrent PATCH ${value} after destination validation`, async () => {
      const h = harness(value === true ? false : true);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      destination.mockImplementation(async (_name, provider) => {
        if (provider.note === "delayed overwrite") { enter(); await gate; }
        return null;
      });
      const pending = h.post({ note: "delayed overwrite" });
      try {
        await Promise.race([entered, pending.then(() => { throw new Error("POST did not await destination validation"); })]);
        expect((await h.request("PATCH", { inferContextWindow: value })).status).toBe(200);
      } finally {
        release();
        await pending;
      }
      expect((await pending).status).toBe(200);
      expect(h.config.providers.relay!.inferContextWindow).toBe(value ?? undefined);
      expect(loadConfig().providers.relay!.inferContextWindow).toBe(value ?? undefined);
    });
  }
});
