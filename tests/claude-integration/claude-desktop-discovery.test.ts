import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { buildDesktopDiscoveryInputs } from "../../src/claude/desktop-discovery-inputs";
import { buildDesktop3pRegistry, generateDesktop3pModels, resolveDesktop3pAlias } from "../../src/claude/desktop-3p";
import { parseDesktopProfile } from "../../src/claude/desktop-profile";
import { desktopVisibleNativeSlugs, type CatalogModel } from "../../src/codex/catalog";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const emptyEntitlements = (): CodexModelEntitlementSnapshot => ({
  modelsByAccount: new Map(), clientVersionByAccount: new Map(),
  confirmedAccountIds: new Set(), credentialIdentities: new Map(),
});

function projectionConfig(mode: "direct" | "pool" = "pool"): OcxConfig {
  return {
    port: 0, defaultProvider: "test",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "https://example.test/v1", codexAccountMode: mode },
      test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", selectedModels: ["model-123", "model-155"] },
    },
    subagentModels: ["test/model-155"],
    providerContextCaps: { openai: 272_000 },
  } as OcxConfig;
}

describe("shared Desktop discovery inputs", () => {
  afterEach(() => buildDesktop3pRegistry([], []));

  test("filters direct grants against main and preserves routed metadata and input arrays", () => {
    const snapshot: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map([
        [MAIN_CODEX_ACCOUNT_ID, new Set<string>()],
        ["pool-fixture", new Set(["gpt-daybreak-blue-latest"])],
      ]),
      clientVersionByAccount: new Map(),
      confirmedAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID, "pool-fixture"]),
      credentialIdentities: new Map(),
    };
    const rows: CatalogModel[] = [
      { provider: "test", id: "model-123", contextWindow: 200_000 },
      { provider: "test", id: "not-selected" },
      { provider: "test", id: "model-155", reasoningEfforts: ["low", "high"], contextWindow: 1_000_000, inputModalities: ["text", "image"] },
    ];
    const before = structuredClone(rows);
    const candidates = Object.freeze(["gpt-5.6-sol", "gpt-daybreak-blue-latest"]);
    const direct = buildDesktopDiscoveryInputs({
      config: projectionConfig("direct"), models: rows,
      modelEntitlements: snapshot, desktopNativeCandidates: candidates,
    });
    expect(direct.nativeSlugs).toEqual(["gpt-5.6-sol"]);
    expect(direct.routedModels.map(row => row.id)).toEqual(["model-155", "model-123"]);
    expect(direct.routedModels[0]).toEqual(before[2]);
    expect(direct.nativeContextCap.cap).toBe(272_000);
    const pooled = buildDesktopDiscoveryInputs({
      config: projectionConfig("pool"), models: rows,
      modelEntitlements: snapshot, desktopNativeCandidates: candidates,
    });
    expect(pooled.nativeSlugs).toEqual(["gpt-5.6-sol", "gpt-daybreak-blue-latest"]);
    expect(rows).toEqual(before);
    expect(candidates).toEqual(["gpt-5.6-sol", "gpt-daybreak-blue-latest"]);
  });

  test("respects Desktop native opt-out and disabled routed selections", () => {
    const config = projectionConfig();
    config.claudeCode = { desktopNativeModels: false };
    config.disabledModels = ["test/model-155"];
    const result = buildDesktopDiscoveryInputs({
      config, modelEntitlements: emptyEntitlements(),
      desktopNativeCandidates: desktopVisibleNativeSlugs(config),
      models: [{ provider: "test", id: "model-123" }, { provider: "test", id: "model-155" }],
    });
    expect(result.nativeSlugs).toEqual([]);
    expect(result.routedModels.map(row => row.id)).toEqual(["model-123"]);
  });

  test("uses featured ordering for the no-profile hash collision winner on either install path", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const inputs = buildDesktopDiscoveryInputs({
        config: projectionConfig(), modelEntitlements: emptyEntitlements(), desktopNativeCandidates: [],
        models: [{ provider: "test", id: "model-123" }, { provider: "test", id: "model-155" }],
      });
      buildDesktop3pRegistry(inputs.nativeSlugs, inputs.routedModels, undefined, inputs.nativeContextCap);
      expect(resolveDesktop3pAlias("claude-opus-4-8-vdu")).toBe("test/model-155");
      const models = generateDesktop3pModels(inputs.nativeSlugs, inputs.routedModels, undefined, inputs.nativeContextCap);
      expect(models.map(model => model.name)).toEqual(["claude-opus-4-8-vdu"]);
      expect(resolveDesktop3pAlias("claude-opus-4-8-vdu")).toBe("test/model-155");
    } finally { warning.mockRestore(); }
  });
});

describe("Desktop snapshot through authenticated model discovery", () => {
  const key = "ocx_data_desktopsnapshotfixture";
  const envKeys = ["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_API_AUTH_TOKEN"] as const;
  let previous: Array<string | undefined>;
  let dir: string;
  let codexHome: IsolatedCodexHome;
  let upstream: ReturnType<typeof Bun.serve>;
  let server: ReturnType<typeof startServer> | undefined;

  beforeEach(() => {
    previous = envKeys.map(name => process.env[name]);
    dir = mkdtempSync(join(tmpdir(), "ocx-desktop-discovery-"));
    process.env.OPENCODEX_HOME = dir;
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "desktop");
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    codexHome = installIsolatedCodexHome("ocx-desktop-discovery-codex-");
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ data: [{ id: "model-123" }, { id: "model-155" }] }),
    });
  });

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
    await upstream.stop(true);
    buildDesktop3pRegistry([], []);
    codexHome.restore();
    envKeys.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    removeTreeWithRetry(dir);
  });

  function launch(enabled = true, pickerOrder?: string[]): void {
    saveConfig({
      port: 0, hostname: "0.0.0.0", defaultProvider: "test", runtimeRole: "hub",
      ...(pickerOrder ? { modelPickerOrder: pickerOrder, subagentModels: [], subagentModelsVersion: 1 } : {}),
      providers: {
        test: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "fixture", allowPrivateNetwork: true, models: ["model-123", "model-155"] },
      },
      claudeCode: {
        enabled, desktopNativeModels: false,
        desktopProfile: parseDesktopProfile({
          version: 1,
          assignments: { "test/model-155": { family: "fable", alias: "claude-opus-4-8-20260304" } },
          defaults: { opus: null, fable: "test/model-155", sonnet: null, haiku: null },
        }),
      },
      apiKeys: [{ id: "snapshot", name: "Snapshot", key, createdAt: "2026-09-06T00:00:00.000Z" }],
    } as OcxConfig);
    server = startServer(0);
  }

  function request(query: string, headers: Record<string, string> = { "x-opencodex-api-key": key }): Promise<Response> {
    return fetch(`http://127.0.0.1:${server!.port}/v1/models${query}`, { headers });
  }

  test("saved order reaches both public Codex and Claude discovery consumers", async () => {
    launch(true, ["test/model-155", "test/model-123"]);
    const anthropic = await request("?flavor=anthropic&ids=cli");
    expect(anthropic.status).toBe(200);
    const info = await anthropic.json() as { data: Array<{ display_name: string }> };
    expect(info.data.filter(row => row.display_name.endsWith("(test)")).map(row => row.display_name))
      .toEqual(["model-155 (test)", "model-123 (test)"]);
    const codex = await request("?client_version=0.145.0");
    expect(codex.status).toBe(200);
    const catalog = await codex.json() as { models: Array<{ slug: string; priority: number }> };
    const routed = catalog.models.filter(row => row.slug.startsWith("test/"));
    expect(routed.toSorted((a, b) => a.priority - b.priority).map(row => row.slug))
      .toEqual(["test/model-155", "test/model-123"]);
    expect(routed.find(row => row.slug === "test/model-155")?.priority).toBe(1000);
    expect(routed.find(row => row.slug === "test/model-123")?.priority).toBe(1001);
  });

  test("snapshot installs its exact aliases and retains ordinary discovery shapes", async () => {
    launch();
    const snapshot = await request("?ids=desktop&format=desktop-config");
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    const body = await snapshot.json() as { version: number; models: Array<{ name: string; anthropicFamilyTier: string }> };
    expect(body.version).toBe(1);
    expect(body.models.find(model => model.name === "claude-opus-4-8-20260304")?.anthropicFamilyTier).toBe("fable");
    expect(resolveDesktop3pAlias("claude-opus-4-8-20260304")).toBe("test/model-155");
    const anthropic = await request("?flavor=anthropic&ids=desktop");
    expect(anthropic.status).toBe(200);
    const anthropicBody = await anthropic.json() as { data: Array<{ id: string }>; version?: number };
    expect(anthropicBody.version).toBeUndefined();
    expect(anthropicBody.data.some(model => model.id === "claude-opus-4-8-20260304")).toBe(true);
    expect(resolveDesktop3pAlias("claude-opus-4-8-20260304")).toBe("test/model-155");
    const cli = await request("?flavor=anthropic&ids=cli");
    expect(cli.status).toBe(200);
    expect((await cli.json() as { data: Array<{ id: string }> }).data.some(model => model.id.startsWith("claude-ocx-test--"))).toBe(true);
    const openai = await request("");
    expect(openai.status).toBe(200);
    const openaiBody = await openai.json() as { object: string; data: unknown[]; version?: number };
    expect(openaiBody.object).toBe("list");
    expect(openaiBody.version).toBeUndefined();
    expect(openaiBody.data.length).toBeGreaterThan(0);
  });

  test("keeps data admission and origin checks ahead of snapshot format parsing", async () => {
    launch();
    expect((await request("?format=desktop-config&ids=cli", {})).status).toBe(401);
    expect((await request("?format=desktop-config", { "x-opencodex-api-key": key, Origin: "https://untrusted.example.test" })).status).toBe(403);
    for (const query of ["?format=desktop-config&ids=cli", "?format=desktop-config&client_version=0.150.0"]) {
      expect((await request(query)).status).toBe(400);
    }
  });

  test("disabled Claude returns a valid empty snapshot without changing ordinary disabled discovery", async () => {
    launch(false);
    const snapshot = await request("?format=desktop-config");
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    expect(await snapshot.json()).toEqual({ version: 1, models: [] });
    const ordinary = await request("?flavor=anthropic");
    expect(await ordinary.json()).toEqual({ data: [] });
  });
});
