import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeDefaultReasoningEffort,
  nativeReasoningEfforts,
  type CatalogModel,
} from "../src/codex/catalog";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import { buildGrokManagedBlock, injectGrokConfig, type GrokInjectModel } from "../src/grok/inject";
import { grokDefaultReasoningEffort, sanitizeGrokReasoningEfforts } from "../src/grok/effort";
import { buildGrokInjectModels } from "../src/grok/models";
import { syncGrokConfig } from "../src/grok/sync";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

const NATIVE_SOL = "gpt-5.6-sol";
const ROUTED_WITH_LADDER: CatalogModel = {
  provider: "kimi",
  id: "k3",
  contextWindow: 262_144,
  reasoningEfforts: ["low", "high", "max"],
  defaultReasoningEffort: "high",
};
const ROUTED_EMPTY_LADDER: CatalogModel = {
  provider: "kimi",
  id: "kimi-for-coding",
  contextWindow: 262_144,
  reasoningEfforts: [],
};

beforeEach(() => {
  seedCodexModelEntitlementsForTests("main", [NATIVE_SOL]);
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
});

type GrokTomlModel = {
  model?: string;
  supports_reasoning_effort?: boolean;
  reasoning_effort?: string;
  reasoning_efforts?: Array<{
    id: string;
    value: string;
    label: string;
    description: string;
    default: boolean;
  }>;
};

function baseConfig(): OcxConfig {
  return { port: 10190, hostname: "127.0.0.1", defaultProvider: "openai", providers: {} } as OcxConfig;
}

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-effort-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

function parseModels(content: string): Record<string, GrokTomlModel> {
  expect(() => Bun.TOML.parse(content)).not.toThrow();
  const parsed = Bun.TOML.parse(content) as { model?: Record<string, GrokTomlModel> };
  expect(parsed.model).toBeDefined();
  return parsed.model!;
}

function tableByModelId(models: Record<string, GrokTomlModel>, id: string): GrokTomlModel {
  const table = Object.values(models).find(entry => entry.model === id);
  expect(table).toBeDefined();
  return table!;
}

function expectedNativeEfforts(slug: string): string[] {
  return sanitizeGrokReasoningEfforts(nativeReasoningEfforts(slug));
}

describe("Grok inject model catalog", () => {
  test("applies native OpenAI context limits to Grok rows", () => {
    const defaults = buildGrokInjectModels(baseConfig(), []);
    expect(defaults.find(model => model.id === NATIVE_SOL)?.contextWindow).toBe(272_000);

    const groupOptIn = buildGrokInjectModels({
      ...baseConfig(),
      providerContextCaps: { openai: 922_000 },
    }, []);
    expect(groupOptIn.find(model => model.id === NATIVE_SOL)?.contextWindow).toBe(922_000);

    const perModelOptIn = buildGrokInjectModels({
      ...baseConfig(),
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          modelContextWindows: { [NATIVE_SOL]: 500_000 },
        },
      },
    }, []);
    const sol = perModelOptIn.find(model => model.id === NATIVE_SOL);
    expect(sol?.contextWindow).toBe(500_000);
    expect(sol?.reasoningEfforts).toEqual(nativeReasoningEfforts(NATIVE_SOL));
  });
});

describe("Grok managed-block thinking-intensity injection", () => {
  test("writer emits the proven Grok picker shape for a custom subset and omits an empty ladder", () => {
    const withLadder = buildGrokManagedBlock(10100, [{
      id: "kimi/k3",
      contextWindow: 262_144,
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    }]);
    expect(withLadder).toContain("supports_reasoning_effort = true");
    expect(withLadder).toContain('reasoning_effort = "high"');
    expect(withLadder).toContain("[[model.ocx-kimi-k3.reasoning_efforts]]");
    expect(withLadder).toContain('id = "low"');
    expect(withLadder).toContain('value = "low"');
    expect(withLadder).toContain('label = "Low"');
    expect(withLadder).toContain('description = "Quick, fast implementations"');
    expect(withLadder).toContain("default = true");
    expect(withLadder).toContain("default = false");
    expect(withLadder).not.toContain("medium");
    expect(withLadder).not.toContain("xhigh");
    expect(withLadder).not.toContain("ultra");

    const parsed = parseModels(withLadder);
    const k3 = parsed["ocx-kimi-k3"];
    expect(k3.supports_reasoning_effort).toBe(true);
    expect(k3.reasoning_effort).toBe("high");
    expect(k3.reasoning_efforts?.map(row => row.value)).toEqual(["low", "high", "max"]);
    expect(k3.reasoning_efforts?.filter(row => row.default)).toEqual([
      {
        id: "high",
        value: "high",
        label: "High",
        description: "Highest quality with extensive reasoning",
        default: true,
      },
    ]);

    const empty = buildGrokManagedBlock(10100, [{ id: "kimi/plain" }]);
    expect(empty).not.toContain("supports_reasoning_effort");
    expect(empty).not.toContain("reasoning_effort");
    expect(empty).not.toContain("reasoning_efforts");
    const emptyParsed = parseModels(empty);
    expect(emptyParsed["ocx-kimi-plain"]?.supports_reasoning_effort).toBeUndefined();
    expect(emptyParsed["ocx-kimi-plain"]?.reasoning_effort).toBeUndefined();
    expect(emptyParsed["ocx-kimi-plain"]?.reasoning_efforts).toBeUndefined();
  });

  test("Grok config injection drops Codex-only ultra from a mixed ladder", () => {
    const block = buildGrokManagedBlock(10100, [{
      id: "gpt-5.6-sol",
      reasoningEfforts: ["low", "max", "ultra"],
      defaultReasoningEffort: "ultra",
    }]);
    expect(block).not.toContain("ultra");
    const table = parseModels(block)["ocx-gpt-5-6-sol"];
    expect(table.reasoning_efforts?.map(row => row.value)).toEqual(["low", "max"]);
    expect(table.reasoning_effort).toBe("low");
  });

  test("Grok config injection omits effort fields for an ultra-only ladder", () => {
    const block = buildGrokManagedBlock(10100, [{
      id: "gpt-5.6-sol",
      reasoningEfforts: ["ultra"],
      defaultReasoningEffort: "ultra",
    }]);
    const table = parseModels(block)["ocx-gpt-5-6-sol"];
    expect(table.supports_reasoning_effort).toBeUndefined();
    expect(table.reasoning_effort).toBeUndefined();
    expect(table.reasoning_efforts).toBeUndefined();
  });

  test("Grok config injection falls back to medium when ultra is the configured default", () => {
    const block = buildGrokManagedBlock(10100, [{
      id: "gpt-5.6-sol",
      reasoningEfforts: ["medium", "ultra"],
      defaultReasoningEffort: "ultra",
    }]);
    const table = parseModels(block)["ocx-gpt-5-6-sol"];
    expect(table.reasoning_effort).toBe("medium");
    expect(table.reasoning_efforts?.map(row => row.value)).toEqual(["medium"]);
    expect(table.reasoning_efforts?.find(row => row.default)?.value).toBe("medium");
  });

  test("writer preserves none and minimal while dropping Codex-only ultra", () => {
    const block = buildGrokManagedBlock(10100, [{
      id: "voice/dual-mode",
      reasoningEfforts: ["none", "minimal", "low", "ultra"],
      defaultReasoningEffort: "minimal",
    }]);
    expect(block).not.toContain("ultra");

    const table = parseModels(block)["ocx-voice-dual-mode"];
    expect(table.reasoning_effort).toBe("minimal");
    expect(table.reasoning_efforts?.map(row => row.value)).toEqual(["none", "minimal", "low"]);
    expect(table.reasoning_efforts?.slice(0, 2)).toEqual([
      {
        id: "none",
        value: "none",
        label: "None",
        description: "No reasoning",
        default: false,
      },
      {
        id: "minimal",
        value: "minimal",
        label: "Minimal",
        description: "Minimal reasoning",
        default: true,
      },
    ]);
  });

  test("Grok config injection filters native ultra even though HTTP /v1/models preserves it", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = await syncGrokConfig(10190, baseConfig(), { grokHome }, {
        fetchAllModels: async () => [ROUTED_WITH_LADDER],
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      const models = parseModels(content);

      const sol = tableByModelId(models, NATIVE_SOL);
      const nativeLadder = expectedNativeEfforts(NATIVE_SOL);
      expect(nativeReasoningEfforts(NATIVE_SOL)).toContain("ultra");
      expect(nativeLadder).not.toContain("ultra");
      expect(sol.supports_reasoning_effort).toBe(true);
      expect(sol.reasoning_effort).toBe(
        grokDefaultReasoningEffort(nativeLadder, nativeDefaultReasoningEffort(NATIVE_SOL)),
      );
      expect(sol.reasoning_efforts?.map(row => row.value)).toEqual(nativeLadder);
      expect(sol.reasoning_efforts?.filter(row => row.default)).toHaveLength(1);
      expect(sol.reasoning_efforts?.find(row => row.default)?.value).toBe(sol.reasoning_effort);

      const k3 = tableByModelId(models, "kimi/k3");
      expect(k3.supports_reasoning_effort).toBe(true);
      expect(k3.reasoning_effort).toBe("high");
      expect(k3.reasoning_efforts?.map(row => row.value)).toEqual(["low", "high", "max"]);
      expect(k3.reasoning_efforts?.map(row => row.value)).not.toEqual(nativeLadder);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sync omits thinking-intensity fields for a routed model with an empty tier list", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const result = await syncGrokConfig(10190, baseConfig(), { grokHome }, {
        fetchAllModels: async () => [ROUTED_EMPTY_LADDER],
        injectGrokConfig,
      });
      expect(result).toMatchObject({ ok: true, changed: true });
      const content = readFileSync(join(grokHome, "config.toml"), "utf8");
      const models = parseModels(content);
      const plain = tableByModelId(models, "kimi/kimi-for-coding");
      expect(plain.supports_reasoning_effort).toBeUndefined();
      expect(plain.reasoning_effort).toBeUndefined();
      expect(plain.reasoning_efforts).toBeUndefined();
      expect(content).not.toMatch(/ocx-kimi-kimi-for-coding[\s\S]*supports_reasoning_effort/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard Grok enable apply writes the same ladders", () => {
  let grokHome: string;
  let fixtureRoot: string;
  let previousGrokHome: string | undefined;
  let previousOpencodexHome: string | undefined;
  const cleanup: string[] = [];

  beforeEach(() => {
    previousGrokHome = process.env.GROK_HOME;
    grokHome = mkdtempSync(join(tmpdir(), "ocx-grok-effort-apply-"));
    cleanup.push(grokHome);
    process.env.GROK_HOME = grokHome;
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-owned-home-"));
    cleanup.push(fixtureRoot);
    process.env.OPENCODEX_HOME = fixtureRoot;
    writeFileSync(join(fixtureRoot, "service-state.json"), JSON.stringify({
      version: 2,
      codexHome: process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
      opencodexHome: fixtureRoot,
      backend: "scheduler",
    }));
  });

  afterEach(() => {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  test("PUT /api/native-integrations/grok injects native + routed ladders", async () => {
    const config = baseConfig();
    const deps: ManagementApiDeps = {
      readRuntimePort: () => null,
      fetchAllModels: (async () => [ROUTED_WITH_LADDER]) as never,
    };
    const url = new URL("http://127.0.0.1:10190/api/native-integrations/grok");
    const res = await handleManagementAPI(
      new Request(url, {
        method: "PUT",
        headers: { Host: url.host, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      url,
      config,
      deps,
    );
    expect(res?.status).toBe(200);
    const content = readFileSync(join(grokHome, "config.toml"), "utf8");
    const models = parseModels(content);
    const sol = tableByModelId(models, NATIVE_SOL);
    expect(sol.supports_reasoning_effort).toBe(true);
    expect(sol.reasoning_efforts?.map(row => row.value)).toEqual(expectedNativeEfforts(NATIVE_SOL));
    const k3 = tableByModelId(models, "kimi/k3");
    expect(k3.reasoning_effort).toBe("high");
    expect(k3.reasoning_efforts?.map(row => row.value)).toEqual(["low", "high", "max"]);
  });
});

describe("inject payload threading", () => {
  test("sync and apply payloads both carry the catalog ladder, not a rebuilt one", async () => {
    const { root, grokHome } = tempGrokHome();
    try {
      const config = baseConfig();
      const catalog = [ROUTED_WITH_LADDER];
      let syncModels: GrokInjectModel[] | null = null;
      await syncGrokConfig(10190, config, { grokHome }, {
        fetchAllModels: async () => catalog,
        injectGrokConfig: ((port, models, opts) => {
          syncModels = models;
          return injectGrokConfig(port, models, opts);
        }) as typeof injectGrokConfig,
      });
      const k3 = syncModels?.find(model => model.id === "kimi/k3");
      expect(k3?.reasoningEfforts).toEqual(["low", "high", "max"]);
      expect(k3?.defaultReasoningEffort).toBe("high");
      const sol = syncModels?.find(model => model.id === NATIVE_SOL);
      expect(sol?.reasoningEfforts).toEqual(nativeReasoningEfforts(NATIVE_SOL));
      expect(sol?.reasoningEfforts).toContain("ultra");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
