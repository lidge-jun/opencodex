/**
 * /api/injection-model effort support (devlog/260710_injection_effort):
 * PUT validates the reasoning effort against the Codex ladder, clears it with the
 * model, and GET surfaces `{ effort, efforts }` next to the existing model picker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig } from "../src/config";
import { refreshCodexModelCatalog } from "../src/codex/refresh";
import { handleManagementAPI } from "../src/server/management-api";
import { CODEX_REASONING_LEVELS } from "../src/reasoning-effort";
import type { OcxConfig } from "../src/types";

const savedHome = process.env.OPENCODEX_HOME;
let tempHome: string | null = null;

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) { rmSync(tempHome, { recursive: true, force: true }); tempHome = null; }
});

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-injection-"));
  process.env.OPENCODEX_HOME = tempHome;
}

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

async function put(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/injection-model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

describe("/api/injection-model reasoning effort", () => {
  test("PUT model+effort roundtrips; GET surfaces effort + ladder", async () => {
    isolatedHome();
    const config = makeConfig();
    const putRes = await put(config, { model: "openai/gpt-5.6-sol", effort: "xhigh" });
    expect(await putRes.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, model: "openai/gpt-5.6-sol", effort: "xhigh", prompt: null });
    expect(config.injectionEffort).toBe("xhigh");

    const getRes = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    const data = await getRes!.json() as { model: string | null; effort: string | null; efforts: string[] };
    expect(data.model).toBe("openai/gpt-5.6-sol");
    expect(data.effort).toBe("xhigh");
    expect(data.efforts).toEqual(CODEX_REASONING_LEVELS.map(l => l.effort));
  });

  test("prompt key: set, keep-when-absent, clear, reject non-string", async () => {
    isolatedHome();
    const config = makeConfig();
    const setRes = await put(config, { model: "openai/gpt-5.6-sol", prompt: "RULES {{model}} {{roster}}" });
    expect(((await setRes.json()) as { prompt: string | null }).prompt).toBe("RULES {{model}} {{roster}}");
    expect(config.injectionPrompt).toBe("RULES {{model}} {{roster}}");
    // absent key leaves it unchanged
    await put(config, { model: "openai/gpt-5.6-sol", effort: "xhigh" });
    expect(config.injectionPrompt).toBe("RULES {{model}} {{roster}}");
    // null clears
    await put(config, { model: "openai/gpt-5.6-sol", prompt: null });
    expect(config.injectionPrompt).toBeUndefined();
    // non-string rejected
    const bad = await put(config, { model: "openai/gpt-5.6-sol", prompt: 42 });
    expect(bad.status).toBe(400);
  });

  test("invalid effort is rejected with 400 and leaves config untouched", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "high" });
    const res = await put(config, { model: "anthropic/claude-sonnet-5", effort: "turbo" });
    expect(res.status).toBe(400);
    expect(config.injectionModel).toBe("openai/gpt-5.6-sol");
    expect(config.injectionEffort).toBe("high");
  });

  test("clearing the effort alone keeps the model", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "max" });
    const res = await put(config, { model: "openai/gpt-5.6-sol", effort: null });
    expect(await res.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, model: "openai/gpt-5.6-sol", effort: null, prompt: null });
    expect(config.injectionEffort).toBeUndefined();
  });

  test("clearing the model clears the effort too", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "max" });
    const res = await put(config, { model: null });
    expect(await res.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, model: null, effort: null, prompt: null });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
  });

  test("effort key absent leaves a stored effort unchanged while the model stays", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "ultra" });
    const res = await put(config, { model: "anthropic/claude-sonnet-5" });
    expect(await res.json()).toEqual({ ok: true, multiAgentGuidanceEnabled: true, model: "anthropic/claude-sonnet-5", effort: "ultra", prompt: null });
  });

  test("GET round-trips combo aliases and excludes an alias-disabled combo", async () => {
    const alias = "deepseek-v4-flash";
    const config = makeConfig({
      defaultProvider: "a",
      providers: {
        a: {
          adapter: "openai-chat",
          baseUrl: "https://a.example/v1",
          liveModels: false,
          models: ["m1"],
          modelContextWindows: { m1: 128_000 },
        },
      },
      combos: {
        free: { alias, targets: [{ provider: "a", model: "m1" }] },
      },
      injectionModel: alias,
    });

    let response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    let data = await response!.json() as {
      model: string | null;
      available: Array<{ provider: string; model: string; namespaced: string }>;
    };
    expect(data.model).toBe(alias);
    expect(data.available).toContainEqual({ provider: "combo", model: "free", namespaced: alias });
    expect(data.available.some(model => model.namespaced === "combo/free")).toBe(false);

    config.disabledModels = [alias];
    response = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    data = await response!.json() as typeof data;
    expect(data.available.some(model => model.namespaced === alias)).toBe(false);
  }, 15_000);
});

describe("/api/injection-model guidance kill switch + partial update", () => {
  test("flag-only PUT preserves model, effort, and prompt in memory and on disk", async () => {
    isolatedHome();
    const config = makeConfig({
      multiAgentGuidanceEnabled: true,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{model}} {{roster}}",
    });

    const response = await put(config, { multiAgentGuidanceEnabled: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      multiAgentGuidanceEnabled: false,
      model: "gpt-5.6-terra",
      effort: "max",
      prompt: "RULES {{model}} {{roster}}",
    });
    expect(config).toMatchObject({
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{model}} {{roster}}",
    });
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted).toMatchObject({
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{model}} {{roster}}",
    });
  });

  test("explicit model clear clears effort but preserves prompt and guidance flag", async () => {
    isolatedHome();
    const config = makeConfig({
      multiAgentGuidanceEnabled: false,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{roster}}",
    });

    const response = await put(config, { model: null });
    expect(await response.json()).toEqual({
      ok: true,
      multiAgentGuidanceEnabled: false,
      model: null,
      effort: null,
      prompt: "RULES {{roster}}",
    });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
    expect(config.injectionPrompt).toBe("RULES {{roster}}");
    expect(config.multiAgentGuidanceEnabled).toBe(false);
  });

  test.each([
    ["null", null],
    ["array", []],
    ["scalar", "text"],
  ] as const)("rejects top-level %s before any partial-update key check", async (_label, body) => {
    isolatedHome();
    const config = makeConfig({
      multiAgentGuidanceEnabled: true,
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "high",
      injectionPrompt: "RULES",
    });
    const before = structuredClone(config);

    const response = await put(config, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "body must be a JSON object" });
    expect(config).toEqual(before);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("guidance flag and injection settings survive save, catalog sync, and reload", async () => {
    isolatedHome();
    const config = makeConfig({
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
      multiAgentGuidanceEnabled: true,
      multiAgentMode: "v2",
      subagentModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{roster}}",
    });
    await put(config, { multiAgentGuidanceEnabled: false });

    let flagSeenBySync: boolean | undefined;
    await refreshCodexModelCatalog(config, {
      syncCatalogModels: async syncedConfig => {
        flagSeenBySync = syncedConfig.multiAgentGuidanceEnabled;
        return { added: 0, path: join(tempHome!, "missing-catalog.json") };
      },
      invalidateCodexModelsCache: () => {},
      existsSync: () => false,
    });
    expect(flagSeenBySync).toBe(false);
    expect(config.multiAgentMode).toBe("v2");

    const reloaded = loadConfig();
    expect(reloaded).toMatchObject({
      multiAgentGuidanceEnabled: false,
      multiAgentMode: "v2",
      subagentModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      injectionModel: "gpt-5.6-terra",
      injectionEffort: "max",
      injectionPrompt: "RULES {{roster}}",
    });
  });
});
