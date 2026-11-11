/**
 * `providers.<name>.modelDiscovery` (#7910) at the config and management boundaries: the loader
 * keeps a valid block and degrades a malformed one to absent, the management API validates what it
 * writes, PATCH sets and clears it, a POST overwrite carries it only while the destination is
 * unchanged, and a hand edit on disk reaches the live config through reconciliation.
 *
 * The provider-level field is unrelated to the top-level `modelDiscovery` discovery state.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, reconcileLiveConfigFromDisk, saveConfig } from "../../src/config";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { startServer } from "../../src/server";
import { providerEditorConfigDTO, providerManagementConfigError } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxProviderConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { ManagementRequest, managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(60_000);

const BASE_URL = "https://gateway.example.test/v1";
const STORED: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: BASE_URL,
  apiKey: "sk-fixture",
  modelDiscovery: { skipInvalidRows: true },
};

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

function useHome(): void {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-model-discovery-"));
  process.env.OPENCODEX_HOME = home;
}

async function withServer(providers: Record<string, OcxProviderConfig>, run: (url: URL) => Promise<void>): Promise<void> {
  useHome();
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, ...providers } });
  const server = startServer(0);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    await run(server.url);
  } finally {
    resolved.mockRestore();
    await server.stop(true);
  }
}

function send(url: URL, path: string, method: "PATCH" | "POST", body: unknown): Promise<Response> {
  return fetch(new URL(path, url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MALFORMED = [
  { skipInvalidRows: "yes" },
  { skipInvalidRows: 1 },
  { skipInvalidRows: true, extra: true },
  [],
  "on",
  true,
];

describe("config load (#7910)", () => {
  test("keeps a valid block and resolves it into discovery", () => {
    useHome();
    const base = config("127.0.0.1");
    saveConfig({ ...base, providers: { ...base.providers, gateway: STORED } });
    const loaded = loadConfig().providers.gateway!;
    expect(loaded.modelDiscovery).toEqual({ skipInvalidRows: true });
    expect(resolveProviderModelDiscovery("gateway", loaded).skipInvalidRows).toBe(true);
  });

  // Wrapped so an array value reaches the callback instead of being spread into its arguments.
  test.each(MALFORMED.map(value => [value]))("a malformed block %p degrades to absent without discarding the provider", value => {
    useHome();
    const base = config("127.0.0.1");
    saveConfig(base);
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { providers: Record<string, unknown> };
    raw.providers.gateway = { adapter: "openai-chat", baseUrl: BASE_URL, modelDiscovery: value };
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    const loaded = loadConfig().providers.gateway;
    expect(loaded?.baseUrl).toBe(BASE_URL);
    expect(loaded?.modelDiscovery).toBeUndefined();
    expect(Object.hasOwn(resolveProviderModelDiscovery("gateway", loaded!), "skipInvalidRows")).toBe(false);
  });
});

describe("management writes (#7910)", () => {
  test("the shared validator accepts a boolean flag and rejects anything else", () => {
    const provider = { adapter: "openai-chat", baseUrl: BASE_URL };
    expect(providerManagementConfigError("gateway", { ...provider, modelDiscovery: { skipInvalidRows: true } })).toBeNull();
    expect(providerManagementConfigError("gateway", { ...provider, modelDiscovery: {} })).toBeNull();
    for (const value of MALFORMED) {
      expect(providerManagementConfigError("gateway", { ...provider, modelDiscovery: value })).toContain("modelDiscovery");
    }
  });

  test("the editor DTO exposes the block", () => {
    const base = config("127.0.0.1");
    const dto = providerEditorConfigDTO({ ...base, providers: { ...base.providers, gateway: STORED } });
    expect(dto.providers.gateway?.modelDiscovery).toEqual({ skipInvalidRows: true });
  });

  test("PATCH writes, clears and refuses the block", async () => {
    await withServer({ gateway: { adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "sk-fixture" } }, async url => {
      expect((await send(url, "/api/providers?name=gateway", "PATCH", { modelDiscovery: { skipInvalidRows: true } })).status).toBe(200);
      expect(loadConfig().providers.gateway!.modelDiscovery).toEqual({ skipInvalidRows: true });
      for (const value of MALFORMED) {
        const refused = await send(url, "/api/providers?name=gateway", "PATCH", { modelDiscovery: value });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error: string }).error).toContain("modelDiscovery");
      }
      expect(loadConfig().providers.gateway!.modelDiscovery).toEqual({ skipInvalidRows: true });
      expect((await send(url, "/api/providers?name=gateway", "PATCH", { modelDiscovery: null })).status).toBe(200);
      expect(loadConfig().providers.gateway).not.toHaveProperty("modelDiscovery");
    });
  });

  test("POST refuses a malformed block instead of storing it", async () => {
    await withServer({}, async url => {
      for (const value of MALFORMED) {
        const refused = await send(url, "/api/providers", "POST", {
          name: "gateway",
          provider: { adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "sk-fixture", modelDiscovery: value },
        });
        expect(refused.status).toBe(400);
      }
      expect(loadConfig().providers.gateway).toBeUndefined();
    });
  });

  test("a POST overwrite on the same destination keeps the omitted block", async () => {
    await withServer({ gateway: STORED }, async url => {
      const save = await send(url, "/api/providers", "POST", {
        name: "gateway",
        provider: { adapter: "openai-chat", baseUrl: BASE_URL + "/", apiKey: "sk-fixture", note: "renamed note" },
      });
      expect(save.status).toBe(200);
      const saved = loadConfig().providers.gateway!;
      expect(saved.note).toBe("renamed note");
      expect(saved.modelDiscovery).toEqual({ skipInvalidRows: true });
    });
  });

  test("a POST overwrite that moves the provider drops the block, and a sent value wins", async () => {
    await withServer({ gateway: STORED }, async url => {
      const moved = await send(url, "/api/providers", "POST", {
        name: "gateway",
        provider: { adapter: "openai-chat", baseUrl: "https://other-gateway.example.test/v1", apiKey: "sk-fixture" },
      });
      expect(moved.status).toBe(200);
      expect(loadConfig().providers.gateway).not.toHaveProperty("modelDiscovery");
      const sent = await send(url, "/api/providers", "POST", {
        name: "gateway",
        provider: { adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "sk-fixture", modelDiscovery: { skipInvalidRows: false } },
      });
      expect(sent.status).toBe(200);
      expect(loadConfig().providers.gateway!.modelDiscovery).toEqual({ skipInvalidRows: false });
    });
  });
});

describe("connection test (#7910)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function probe(provider: OcxProviderConfig): Promise<{ ok: boolean; models?: number; message?: string; error?: string }> {
    useHome();
    const cfg = withStubbedProviderFetch({ ...config("127.0.0.1"), providers: { gateway: provider } });
    globalThis.fetch = (async () => Response.json({ data: [{ id: "" }, { id: "example-chat-model" }] })) as unknown as typeof fetch;
    const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const url = new URL("http://127.0.0.1/api/providers/test?name=gateway");
      const response = await handleManagementAPI(new ManagementRequest(url, { method: "POST" }), url, cfg);
      if (!response) throw new Error("route missing");
      return await response.json() as { ok: boolean; models?: number; message?: string; error?: string };
    } finally { resolved.mockRestore(); }
  }

  test("the opt-in connects with the valid rows and says how many were skipped", async () => {
    const result = await probe(STORED);
    expect(result).toMatchObject({ ok: true, models: 1 });
    expect(result.message).toContain("1 invalid row skipped");
  });

  test("without the opt-in the failure counts the rows and names the opt-in", async () => {
    const result = await probe({ adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "sk-fixture" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("row 0 has an empty id; 1 of 2 rows invalid");
    expect(result.error).toContain("modelDiscovery.skipInvalidRows: true");
  });
});

describe("live reconciliation (#7910)", () => {
  test("a hand edit adding the block on disk reaches the live config", () => {
    useHome();
    const base = config("127.0.0.1");
    saveConfig({ ...base, providers: { ...base.providers, gateway: { adapter: "openai-chat", baseUrl: BASE_URL } } });
    const live = loadConfig();
    const baseline = loadConfig();
    const edited = loadConfig();
    edited.providers.gateway!.modelDiscovery = { skipInvalidRows: true };
    saveConfig(edited);
    reconcileLiveConfigFromDisk(live, baseline);
    expect(live.providers.gateway!.modelDiscovery).toEqual({ skipInvalidRows: true });
    expect(live.modelDiscovery).toEqual(baseline.modelDiscovery);
  });
});
