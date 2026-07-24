import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const TEST_DIR = join(import.meta.dir, `.tmp-model-visibility-management-${process.pid}`);
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let refreshes = 0;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-model-visibility-codex-");
  refreshes = 0;
  saveConfig({
    port: 0,
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-key",
        liveModels: false,
        models: ["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.1-pro", "gemini-3.6-flash", "gpt-oss-120b-medium", "vendor/model"],
        selectedModels: ["gemini-3.1-pro", "gemini-3.6-flash"],
      },
    },
    combos: {
      free: { alias: "fast-chat", targets: [{ provider: "google-antigravity", model: "gemini-3.1-pro" }] },
      plain: { targets: [{ provider: "google-antigravity", model: "gemini-3.6-flash" }] },
    },
    disabledModels: ["google-antigravity/gpt-oss-120b-medium", "google-antigravity/temporarily-missing", "other/keep"],
  });
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

async function putWithConfig(body: unknown, config = loadConfig()): Promise<Response> {
  const url = new URL("http://localhost/api/model-visibility");
  const response = await handleManagementAPI(new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), url, config, { refreshCodexCatalog: async () => { refreshes += 1; } });
  if (!response) throw new Error("model visibility route was not handled");
  return response;
}

async function put(body: unknown): Promise<Response> {
  return putWithConfig(body);
}

describe("atomic model visibility management", () => {
  test("enables excluded or blocked models and disables without erasing the allowlist", async () => {
    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "claude-sonnet-4-6" }], enabled: true })).status).toBe(200);
    expect(loadConfig().providers["google-antigravity"].selectedModels)
      .toEqual(["gemini-3.1-pro", "gemini-3.6-flash", "claude-sonnet-4-6"]);

    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "gpt-oss-120b-medium" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).not.toContain("google-antigravity/gpt-oss-120b-medium");

    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "gemini-3.1-pro" }], enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toContain("google-antigravity/gemini-3.1-pro");
    expect(loadConfig().providers["google-antigravity"].selectedModels).toContain("gemini-3.1-pro");
    expect(refreshes).toBe(3);
  });

  test("all-on enters future-proof All mode while all-off blocks only current targets", async () => {
    const targets = ["claude-sonnet-4-6", "gemini-3.1-pro", "gpt-oss-120b-medium"].map(id => ({ id }));
    expect((await put({ scope: "provider", provider: "google-antigravity", targets, enabled: true })).status).toBe(200);
    expect(loadConfig().providers["google-antigravity"].selectedModels).toBeUndefined();
    expect(loadConfig().disabledModels).toEqual(["other/keep"]);

    expect((await put({ scope: "provider", provider: "google-antigravity", targets, enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual([
      "other/keep",
      "google-antigravity/claude-sonnet-4-6",
      "google-antigravity/gemini-3.1-pro",
      "google-antigravity/gpt-oss-120b-medium",
    ]);
    expect(loadConfig().disabledModels).not.toContain("google-antigravity/future-model");
    expect(refreshes).toBe(2);
  });

  test("treats a physical combo provider with no configured combos as a routed provider", async () => {
    saveConfig({
      port: 0,
      defaultProvider: "combo",
      providers: {
        combo: {
          adapter: "openai-chat",
          baseUrl: "https://combo.example.test/v1",
          apiKey: "test-key",
          liveModels: false,
          models: ["model-a", "vendor/model"],
          selectedModels: ["model-a"],
        },
      },
      combos: {},
      disabledModels: ["combo/vendor-model", "combo/temporarily-missing", "other/keep"],
    });

    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "vendor/model" }], enabled: true })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toEqual(["model-a", "vendor/model"]);
    expect(loadConfig().disabledModels).toEqual(["combo/temporarily-missing", "other/keep"]);
    expect(refreshes).toBe(1);

    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "model-a" }], enabled: false })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toEqual(["model-a", "vendor/model"]);
    expect(loadConfig().disabledModels).toEqual(["combo/temporarily-missing", "other/keep", "combo/model-a"]);
    expect(refreshes).toBe(2);

    const targets = [{ id: "model-a" }, { id: "vendor/model" }];
    expect((await put({ scope: "provider", provider: "combo", targets, enabled: false })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toEqual(["model-a", "vendor/model"]);
    expect(loadConfig().disabledModels).toEqual([
      "combo/temporarily-missing",
      "other/keep",
      "combo/model-a",
      "combo/vendor-model",
    ]);
    expect(loadConfig().disabledModels).not.toContain("combo/future-model");
    expect(refreshes).toBe(3);

    expect((await put({ scope: "provider", provider: "combo", targets, enabled: true })).status).toBe(200);
    expect(loadConfig().providers.combo.selectedModels).toBeUndefined();
    expect(loadConfig().disabledModels).toEqual(["other/keep"]);
    expect(refreshes).toBe(4);
  });

  test("preserves provider-prefixed combo aliases until the combo provider enables them", async () => {
    const config = loadConfig();
    config.providers.anthropic = {
      adapter: "openai-chat",
      baseUrl: "https://anthropic.example.test/v1",
      apiKey: "test-key",
      liveModels: false,
      models: ["claude-a"],
      selectedModels: ["claude-a"],
    };
    config.combos!.free!.alias = "anthropic/fast";
    config.disabledModels = [
      "anthropic/claude-a",
      "anthropic/temporarily-missing",
      "anthropic/fast",
      "combo/free",
      "combo/plain",
      "other/keep",
      "other/provider",
    ];
    saveConfig(config);

    expect((await put({ scope: "provider", provider: "anthropic", targets: [{ id: "claude-a" }], enabled: true })).status).toBe(200);
    expect(loadConfig().providers.anthropic.selectedModels).toBeUndefined();
    expect(loadConfig().disabledModels).toEqual([
      "anthropic/fast",
      "combo/free",
      "combo/plain",
      "other/keep",
      "other/provider",
    ]);
    expect(refreshes).toBe(1);

    expect((await put({ scope: "provider", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["other/keep", "other/provider"]);
    expect(refreshes).toBe(2);
  });

  test("keeps a colliding physical combo allowlist untouched when virtual combos take precedence", async () => {
    const config = loadConfig();
    config.providers.combo = {
      adapter: "openai-chat",
      baseUrl: "https://combo.example.test/v1",
      models: ["physical-only"],
      selectedModels: ["physical-only"],
    };
    config.combos = {
      free: { alias: "anthropic/fast", targets: [{ provider: "google-antigravity", model: "gemini-3.1-pro" }] },
    };
    config.disabledModels = ["anthropic/fast", "other/keep"];

    expect((await putWithConfig({ scope: "models", provider: "combo", targets: [{ id: "free" }], enabled: true }, config)).status).toBe(200);
    expect(config.providers.combo.selectedModels).toEqual(["physical-only"]);
    expect(config.disabledModels).toEqual(["other/keep"]);
    expect(refreshes).toBe(1);

    config.disabledModels = ["combo/free", "anthropic/fast", "other/keep"];
    expect((await putWithConfig({ scope: "provider", provider: "combo", targets: [{ id: "free" }], enabled: true }, config)).status).toBe(200);
    expect(config.providers.combo.selectedModels).toEqual(["physical-only"]);
    expect(config.disabledModels).toEqual(["other/keep"]);
    expect(refreshes).toBe(2);
  });

  test("toggles canonical and aliased combo rows", async () => {
    const config = loadConfig();
    config.disabledModels?.push("fast-chat", "combo/plain");
    saveConfig(config);
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["google-antigravity/gpt-oss-120b-medium", "google-antigravity/temporarily-missing", "other/keep"]);
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "free" }], enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toContain("combo/free");
    const beforeAllOn = loadConfig();
    beforeAllOn.disabledModels?.push("fast-chat", "combo/plain");
    saveConfig(beforeAllOn);
    expect((await put({ scope: "provider", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: true })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(["google-antigravity/gpt-oss-120b-medium", "google-antigravity/temporarily-missing", "other/keep"]);
    expect((await put({ scope: "provider", provider: "combo", targets: [{ id: "free" }, { id: "plain" }], enabled: false })).status).toBe(200);
    expect(loadConfig().disabledModels).toEqual(expect.arrayContaining(["combo/free", "combo/plain"]));
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "missing" }], enabled: true })).status).toBe(400);
    expect(refreshes).toBe(4);
  });

  test("uses raw allowlist ids, canonical routed slugs, and rejects invalid requests", async () => {
    await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "vendor/model" }, { id: "vendor/model" }], enabled: true });
    expect(loadConfig().providers["google-antigravity"].selectedModels).toContain("vendor/model");
    expect(loadConfig().providers["google-antigravity"].selectedModels).not.toContain("google-antigravity/vendor-model");
    await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "vendor/model" }], enabled: false });
    expect(loadConfig().disabledModels).toContain("google-antigravity/vendor-model");

    const before = loadConfig();
    expect((await put("{")).status).toBe(400);
    for (const nonObject of [null, [], 1, JSON.stringify("value")]) {
      expect((await put(nonObject)).status).toBe(400);
    }
    expect((await put({ scope: "bad", provider: "google-antigravity", targets: [], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "missing-provider", targets: [{ id: "model" }], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "google-antigravity", targets: [{ id: "gpt-5.6-sol", native: true }], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "openai", targets: [{ id: "gpt-5.6-sol" }], enabled: true })).status).toBe(400);
    expect((await put({ scope: "models", provider: "combo", targets: [{ id: "toString" }], enabled: true })).status).toBe(400);
    expect(loadConfig()).toEqual(before);
    expect(refreshes).toBe(2);
  });
});
