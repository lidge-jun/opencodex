import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  addProviderApiKey,
  isKeyAuthProvider,
  listProviderApiKeys,
  removeProviderApiKey,
  setActiveProviderApiKey,
  setProviderApiKeyLabel,
} from "../src/providers/api-keys";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "key-first-000111222333" },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-keys-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-keys-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("provider API key pool", () => {
  test("fails closed for Azure identity without mutating or persisting keys", () => {
    const provider = {
      adapter: "azure-openai",
      baseUrl: "https://resource.openai.azure.com/openai",
      azureCredential: { type: "default-azure-credential" as const },
      models: ["gpt-4o"],
      liveModels: false,
    };
    const config = { ...baseConfig(), providers: { identity: provider } };
    const before = structuredClone(provider);
    expect(isKeyAuthProvider(provider)).toBe(false);
    expect(listProviderApiKeys(config, "identity")).toEqual({ activeId: null, keys: [] });
    expect(addProviderApiKey(config, "identity", "secret-key")).toEqual({ error: "provider does not use API-key auth" });
    expect(setActiveProviderApiKey(config, "identity", "entry")).toBe(false);
    expect(setProviderApiKeyLabel(config, "identity", "entry", "label")).toBe(false);
    expect(removeProviderApiKey(config, "identity", "entry")).toBe(false);
    expect(provider).toEqual(before);
    expect(provider.apiKey).toBeUndefined();
    expect(provider.apiKeyPool).toBeUndefined();
  });

  test("GET seeds legacy bare apiKey into a one-entry pool with masked value", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeId: string | null; keys: Array<{ id: string; masked: string; active: boolean }> };
      expect(body.keys.length).toBe(1);
      expect(body.keys[0]!.active).toBe(true);
      expect(body.keys[0]!.masked.includes("****")).toBe(true);
      expect(JSON.stringify(body).includes("key-first-000111222333")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("POST adds + activates; PUT switches; DELETE removes and promotes", async () => {
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "key-second-444555666777" }),
      });
      expect(add.status).toBe(201);
      const { id: secondId } = await add.json() as { id: string };

      let list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { activeId: string; keys: Array<{ id: string; active: boolean }> };
      expect(list.keys.length).toBe(2);
      expect(list.activeId).toBe(secondId); // new key becomes active

      // config.json mirrors the active key into apiKey
      const cfg = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg.providers["opencode-go"].apiKey).toBe("key-second-444555666777");

      const firstId = list.keys.find(k => k.id !== secondId)!.id;
      const rename = await fetch(new URL("/api/providers/keys/alias", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: secondId, alias: "Work key" }),
      });
      expect(rename.status).toBe(200);
      const renamed = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { keys: Array<{ id: string; label?: string }> };
      expect(renamed.keys.find(key => key.id === secondId)?.label).toBe("Work key");
      const put = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: firstId }),
      });
      expect(put.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.activeId).toBe(firstId);

      // Remove the active key: the other one is promoted.
      const del = await fetch(new URL(`/api/providers/keys?name=opencode-go&id=${firstId}`, server.url), { method: "DELETE" });
      expect(del.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.keys.length).toBe(1);
      expect(list.activeId).toBe(secondId);
      const cfg2 = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg2.providers["opencode-go"].apiKey).toBe("key-second-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("rejects every management key-pool operation for Azure identity", async () => {
    const config = baseConfig();
    config.defaultProvider = "azure-identity";
    config.providers["azure-identity"] = {
      adapter: "azure-openai",
      baseUrl: "https://resource.openai.azure.com/openai",
      azureCredential: { type: "default-azure-credential" },
      models: ["gpt-4o"],
      liveModels: false,
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      // Startup normalizes the loaded config; capture the persisted baseline only
      // after that one-time normalization, before exercising the pool routes.
      const before = readFileSync(join(testDir, "config.json"), "utf-8");
      const requests: Array<Promise<Response>> = [
        fetch(new URL("/api/providers/keys?name=azure-identity", server.url)),
        fetch(new URL("/api/providers/keys", server.url), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "azure-identity", key: "should-not-persist" }),
        }),
        fetch(new URL("/api/providers/keys/active", server.url), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "azure-identity", id: "entry" }),
        }),
        fetch(new URL("/api/providers/keys/alias", server.url), {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "azure-identity", id: "entry", alias: "label" }),
        }),
        fetch(new URL("/api/providers/keys?name=azure-identity&id=entry", server.url), { method: "DELETE" }),
      ];
      const responses = await Promise.all(requests);
      expect(responses.map(response => response.status)).toEqual([400, 400, 400, 400, 400]);
      expect(readFileSync(join(testDir, "config.json"), "utf-8")).toBe(before);
    } finally {
      await server.stop(true);
    }
  });

  test("unknown provider 404; empty key 400", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/providers/keys?name=nope", server.url));
      expect(missing.status).toBe(404);
      const bad = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "   " }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});
