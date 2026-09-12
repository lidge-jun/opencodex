import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../../src/config";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { safeConfigDTO } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, rotateKeyOn429, selectProactiveApiKey } from "../../src/providers/key-failover";
import { setActiveProviderApiKey } from "../../src/providers/api-keys";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type EditorConfig = {
  defaultProvider: string;
  providers: Record<string, Record<string, unknown>>;
};

const previousOpencodexHome = process.env.OPENCODEX_HOME;
let testDir: string;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function seededConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "alpha",
    providers: {
      alpha: {
        adapter: "openai-chat",
        baseUrl: "https://alpha.example.test/v1",
        defaultModel: "alpha-old",
        apiKey: "sk-alpha-secret",
        apiKeyPool: [{ id: "alpha-main", key: "sk-alpha-secret", label: "primary" }],
        headers: { "x-private": "private-value", "x-private-two": "private-value-two" },
        project: "private-alpha-project",
      },
      beta: {
        adapter: "anthropic",
        baseUrl: "https://beta.example.test/v1",
        defaultModel: "beta-old",
        apiKey: "sk-beta-secret",
        headers: { "x-beta-private": "keep-me" },
        project: "private-beta-project",
      },
    },
  };
}

function editorBaseline(config: OcxConfig): EditorConfig {
  return {
    defaultProvider: config.defaultProvider,
    providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
      adapter: provider.adapter,
      baseUrl: provider.baseUrl,
      ...(provider.defaultModel === undefined ? {} : { defaultModel: provider.defaultModel }),
      ...(provider.project === undefined ? {} : { project: provider.project }),
    }])),
  };
}

async function putBatch(liveConfig: OcxConfig, body: unknown, onCatalog = () => {}): Promise<Response | null> {
  const request = new Request("http://127.0.0.1/api/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleManagementAPI(request, new URL(request.url), liveConfig, {
    createManagementConvergeCodex: catalogConvergenceFactory(onCatalog),
  });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-batch-"));
  mkdirSync(testDir, { recursive: true });
  process.env.OPENCODEX_HOME = testDir;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-batch-codex-");
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testDir);
});

describe("atomic provider editor batch", () => {
  test("round-trips an unchanged realistic provider config without rewriting values or secrets", async () => {
    const liveConfig: OcxConfig = {
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "woong",
      providers: {
        woong: {
          adapter: "openai-chat",
          baseUrl: "https://woong.example.test/v1",
          defaultModel: "woong-reasoner",
          note: "private deployment",
          modelContextWindows: { "woong-reasoner": 131_072 },
          modelMaxInputTokens: { "woong-reasoner": 120_000 },
          modelReasoningEfforts: { "woong-reasoner": ["low", "medium", "high"] },
          noVisionModels: ["woong-reasoner"],
          allowPrivateNetwork: true,
          apiKey: "sk-woong-secret",
          apiKeyPool: [{ id: "woong-main", key: "sk-woong-secret", label: "primary" }],
          headers: { "x-tenant-token": "tenant-secret" },
          mcpServers: {
            private: {
              url: "https://mcp.example.test",
              headers: { authorization: "Bearer mcp-secret" },
            },
          },
          desktopExecutor: {
            computerUseCommand: "private-runner",
            env: { ACCESS_TOKEN: "desktop-secret" },
          },
        },
      },
    };
    const publicRow = (safeConfigDTO(liveConfig) as {
      providers: Record<string, Record<string, unknown>>;
    }).providers.woong!;
    for (const field of [
      "apiKey",
      "apiKeyPool",
      "headers",
      "mcpServers",
      "desktopExecutor",
      "modelMaxInputTokens",
    ]) {
      expect(publicRow).not.toHaveProperty(field);
    }
    expect(JSON.stringify(publicRow)).not.toContain("secret");
    saveConfig(liveConfig);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const baseline: EditorConfig = {
      defaultProvider: "woong",
      providers: {
        woong: {
          adapter: "openai-chat",
          baseUrl: "https://woong.example.test/v1",
          defaultModel: "woong-reasoner",
          note: "private deployment",
          modelContextWindows: { "woong-reasoner": 131_072 },
          modelReasoningEfforts: { "woong-reasoner": ["low", "medium", "high"] },
          noVisionModels: ["woong-reasoner"],
          allowPrivateNetwork: true,
        },
      },
    };

    const destinationSpy = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    let response: Response | null;
    try {
      response = await putBatch(liveConfig, { baseline, next: structuredClone(baseline) });
    } finally {
      destinationSpy.mockRestore();
    }

    expect(response?.status).toBe(200);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
    expect(loadConfig().providers.woong).toEqual(liveConfig.providers.woong);
    expect(loadConfig().providers.woong).toMatchObject({
      apiKey: "sk-woong-secret",
      apiKeyPool: [{ id: "woong-main", key: "sk-woong-secret", label: "primary" }],
      headers: { "x-tenant-token": "tenant-secret" },
    });
  });

  test("updates several providers in one commit and preserves credentials and private fields", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const baseline = editorBaseline(liveConfig);
    const next: EditorConfig = structuredClone(baseline);
    next.defaultProvider = "beta";
    next.providers.alpha!.defaultModel = "alpha-new";
    next.providers.beta!.baseUrl = "https://beta-new.example.test/v1";
    next.providers.beta!.defaultModel = "beta-new";
    next.providers.gamma = {
      adapter: "openai-chat",
      baseUrl: "https://gamma.example.test/v1",
      defaultModel: "gamma-1",
    };

    let catalogRefreshes = 0;
    const destinationSpy = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    const mutationSpy = spyOn(configModule, "mutatePersistedConfig");
    try {
      const response = await putBatch(liveConfig, { baseline, next }, () => { catalogRefreshes += 1; });
      expect(response?.status).toBe(200);
      expect(mutationSpy).toHaveBeenCalledTimes(1);
    } finally {
      mutationSpy.mockRestore();
      destinationSpy.mockRestore();
    }

    const persisted = loadConfig();
    expect(persisted.defaultProvider).toBe("beta");
    expect(persisted.providers.alpha).toMatchObject({
      defaultModel: "alpha-new",
      apiKey: "sk-alpha-secret",
      apiKeyPool: [{ id: "alpha-main", key: "sk-alpha-secret", label: "primary" }],
      headers: { "x-private": "private-value", "x-private-two": "private-value-two" },
      project: "private-alpha-project",
    });
    expect(persisted.providers.beta).toMatchObject({
      baseUrl: "https://beta-new.example.test/v1",
      defaultModel: "beta-new",
      apiKey: "sk-beta-secret",
      headers: { "x-beta-private": "keep-me" },
      project: "private-beta-project",
    });
    expect(persisted.providers.gamma).toEqual({
      ...next.providers.gamma,
      initialModelSelection: {
        version: 1,
        registrationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: "pending",
      },
    });
    expect(liveConfig.defaultProvider).toBe("beta");
    expect(liveConfig.providers).toEqual(persisted.providers);
    expect(catalogRefreshes).toBe(1);
  });

  test("rejects one invalid row with zero persisted or live change", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const beforeLive = structuredClone(liveConfig);
    const baseline = editorBaseline(liveConfig);
    const next = structuredClone(baseline);
    next.providers.alpha!.defaultModel = "must-not-land";
    next.providers.beta!.baseUrl = "not a URL";
    let catalogRefreshes = 0;

    const response = await putBatch(liveConfig, { baseline, next }, () => { catalogRefreshes += 1; });

    expect(response?.status).toBe(400);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
    expect(liveConfig).toEqual(beforeLive);
    expect(catalogRefreshes).toBe(0);
  });

  test("rejects derived public markers instead of persisting them", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const baseline = editorBaseline(liveConfig);

    for (const [field, value] of [
      ["hasApiKey", true],
      ["hasHeaders", true],
      ["xaiResponsesOptInState", true],
      ["virtualModels", { "alpha-pro": { wireModelId: "alpha", reasoningMode: "pro" } }],
    ] as const) {
      const next = structuredClone(baseline);
      next.providers.alpha![field] = structuredClone(value);

      const response = await putBatch(liveConfig, { baseline, next });

      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ code: "invalid_provider_editor_field" });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
      expect(loadConfig().providers.alpha).not.toHaveProperty(field);
    }
  });

  test("rejects runtime-derived provider metadata as editor write authority", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const baseline = editorBaseline(liveConfig);
    const next = structuredClone(baseline);
    next.providers.alpha!.modelMaxInputTokens = { "alpha-old": 128_000 };

    const response = await putBatch(liveConfig, { baseline, next });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ code: "invalid_provider_editor_field" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
    expect(loadConfig().providers.alpha).not.toHaveProperty("modelMaxInputTokens");
  });

  test("rejects credential-bearing provider fields as editor write authority", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const baseline = editorBaseline(liveConfig);

    for (const [field, value] of [
      ["apiKey", "sk-attacker-write"],
      ["apiKeyPool", [{ id: "attacker", key: "sk-attacker-write" }]],
      ["headers", { authorization: "Bearer attacker-write" }],
      ["mcpServers", { attacker: { url: "https://mcp.example.test", headers: { authorization: "Bearer attacker-write" } } }],
      ["desktopExecutor", { computerUseCommand: "runner", env: { ACCESS_TOKEN: "attacker-write" } }],
    ] as const) {
      const next = structuredClone(baseline);
      next.providers.alpha![field] = structuredClone(value);

      const response = await putBatch(liveConfig, { baseline, next });

      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ code: "invalid_provider_editor_field" });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
    }
  });

  test("rejects unknown provider fields instead of creating hidden write authority", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const beforeBytes = readFileSync(getConfigPath(), "utf8");
    const baseline = editorBaseline(liveConfig);
    const next = structuredClone(baseline);
    next.providers.alpha!.runtimeExtension = { token: "attacker-write" };

    const response = await putBatch(liveConfig, { baseline, next });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ code: "invalid_provider_editor_field" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeBytes);
  });

  test("returns 409 and preserves a concurrent edit when baseline is stale", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const baseline = editorBaseline(liveConfig);
    const next = structuredClone(baseline);
    next.providers.alpha!.defaultModel = "stale-write";

    const concurrent = loadConfig();
    concurrent.providers.alpha!.defaultModel = "concurrent-write";
    saveConfig(concurrent);
    const concurrentBytes = readFileSync(getConfigPath(), "utf8");

    const response = await putBatch(liveConfig, { baseline, next });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "stale_provider_editor_baseline" });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(concurrentBytes);
    expect(loadConfig().providers.alpha?.defaultModel).toBe("concurrent-write");
  });

  test("keeps the full-config PUT disabled", async () => {
    const liveConfig = seededConfig();
    saveConfig(liveConfig);
    const request = new Request("http://127.0.0.1/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(liveConfig),
    });

    const response = await handleManagementAPI(request, new URL(request.url), liveConfig);

    expect(response?.status).toBe(405);
    expect(await response?.json()).toEqual({
      error: "Full config PUT is disabled. Use /api/providers POST for provider changes.",
    });
  });

  /**
   * The batch PUT rewrites the whole roster, which is why it already clears every key cooldown
   * without naming a provider. The rotation cursor is the other half of that state and was
   * being left behind, so round-robin resumed after the pre-edit position instead of at the
   * head of the roster the operator had just saved.
   *
   * Red control: drop `forgetApiKeyRotationCursor()` from the PUT success path and the pick
   * below returns `sk-alpha-three`, continuing after the stale cursor instead of taking the
   * first eligible key.
   */
  test("a batch PUT forgets the rotation cursor along with the cooldowns", async () => {
    const liveConfig = seededConfig();
    liveConfig.providers.alpha!.apiKeyPoolStrategy = "round-robin";
    liveConfig.providers.alpha!.apiKeyPool = [
      { id: "one", key: "sk-alpha-one" },
      { id: "two", key: "sk-alpha-two" },
      { id: "three", key: "sk-alpha-three" },
    ];
    liveConfig.providers.alpha!.apiKey = "sk-alpha-one";
    saveConfig(liveConfig);
    clearKeyCooldowns();
    forgetApiKeyRotationCursor();

    // Establish a cursor the honest way: cool the committed key, point the stored selection
    // back at it -- which is the state a restart or a config reload leaves -- and let the pool
    // advance. Cooling alone is not enough, because rotateKeyOn429 already commits the next
    // key and the picker refuses to second-guess a healthy committed one.
    const t0 = Date.now();
    rotateKeyOn429(loadConfig(), "alpha", null, t0, "sk-alpha-one");
    setActiveProviderApiKey(loadConfig(), "alpha", "one");
    const first = selectProactiveApiKey(loadConfig(), "alpha", t0);
    expect(first?.apiKey).toBe("sk-alpha-two");

    const baseline = editorBaseline(loadConfig());
    // apiKeyPoolStrategy is a public editor field, so it has to appear in the baseline or the
    // deep-equal staleness check rejects the PUT.
    baseline.providers.alpha!.apiKeyPoolStrategy = "round-robin";
    const next = structuredClone(baseline);
    next.providers.alpha!.defaultModel = "alpha-new";
    // Same seam the other successful-PUT cases use: the destination check would otherwise do a
    // real DNS lookup for alpha.example.test on the commit path.
    const destinationSpy = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const response = await putBatch(loadConfig(), { baseline, next });
      expect(response?.status).toBe(200);
    } finally {
      destinationSpy.mockRestore();
    }

    // The PUT cleared the cooldowns, so key one is eligible again. Cool only the committed key
    // and point the selection back at it, the same way as above.
    rotateKeyOn429(loadConfig(), "alpha", null, t0, "sk-alpha-two");
    setActiveProviderApiKey(loadConfig(), "alpha", "two");
    const second = selectProactiveApiKey(loadConfig(), "alpha", t0);
    expect(second?.apiKey).toBe("sk-alpha-one");
  });
});
