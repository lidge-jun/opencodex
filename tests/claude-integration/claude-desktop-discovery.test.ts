import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { buildDesktopDiscoveryInputs } from "../../src/claude/desktop-discovery-inputs";
import { buildDesktop3pRegistry, generateDesktop3pModels, resolveDesktop3pAlias, resolvableDesktop3pAlias, desktop3pAlias } from "../../src/claude/desktop-3p";
import { buildAnthropicModelInfos } from "../../src/claude/model-info";
import { getRequestLogEntries } from "../../src/server/request-log";
import { parseDesktopProfile } from "../../src/claude/desktop-profile";
import { desktopVisibleNativeSlugs, type CatalogModel } from "../../src/codex/catalog";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import type { CodexModelEntitlementSnapshot } from "../../src/codex/model-entitlements";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SUBAGENT_MODELS_VERSION } from "../../src/config/subagent-models";

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

  test("discovery omits a profile route when both its wire and fallback IDs belong to genuine models", () => {
    const wire = "claude-fable-5-p000";
    const fallback = desktop3pAlias("test", "model-123");
    const models: CatalogModel[] = [
      { provider: "test", id: "model-123" },
      { provider: "anthropic", id: wire },
      { provider: "anthropic", id: fallback },
    ];
    const profile = parseDesktopProfile({ version: 1,
      assignments: { "test/model-123": { family: "opus", alias: "claude-opus-4-8-20260101" } },
      defaults: { opus: "test/model-123", fable: null, sonnet: null, haiku: null },
    });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildDesktop3pRegistry([], models, profile);
      expect(resolvableDesktop3pAlias("test", "model-123")).toBeUndefined();
      const infos = buildAnthropicModelInfos([], models, undefined, "desktop3p", resolvableDesktop3pAlias);
      expect(infos.map(info => info.id)).toEqual([wire, fallback]);
      expect(infos.every(info => info.display_name.endsWith("(anthropic)"))).toBe(true);
      expect(resolveDesktop3pAlias(wire)).toBeNull();
      expect(resolveDesktop3pAlias(fallback)).toBeNull();
      // Readable selectors do not share the Desktop namespace or its collisions.
      expect(buildAnthropicModelInfos([], models, undefined, "readable", resolvableDesktop3pAlias))
        .toHaveLength(3);
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
  let upstreamRequests: Array<Record<string, unknown>>;

  beforeEach(() => {
    previous = envKeys.map(name => process.env[name]);
    dir = mkdtempSync(join(tmpdir(), "ocx-desktop-discovery-"));
    process.env.OPENCODEX_HOME = dir;
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "desktop");
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    codexHome = installIsolatedCodexHome("ocx-desktop-discovery-codex-");
    upstreamRequests = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async req => {
        if (new URL(req.url).pathname.endsWith("/chat/completions")) {
          const body = await req.json() as Record<string, unknown>;
          upstreamRequests.push(body);
          if (body.stream) {
            const chunk = { id: "chat_fixture", object: "chat.completion.chunk", model: body.model,
              choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
            return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
              headers: { "content-type": "text/event-stream" },
            });
          }
          return Response.json({ id: "chat_fixture", object: "chat.completion", model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
        }
        return Response.json({ data: [{ id: "model-123" }, { id: "model-155" }] });
      },
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

  function launch(enabled = true, pickerOrder?: string[], overrides: Partial<OcxConfig> = {}): void {
    saveConfig({
      port: 0, hostname: "0.0.0.0", defaultProvider: "test", runtimeRole: "hub",
      ...(pickerOrder ? { modelPickerOrder: pickerOrder, subagentModels: [], subagentModelsVersion: SUBAGENT_MODELS_VERSION } : {}),
      providers: {
        test: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "fixture", allowPrivateNetwork: true, models: ["model-123", "model-155"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
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
      ...overrides,
    } as OcxConfig);
    server = startServer(0);
  }

  function request(query: string, headers: Record<string, string> = { "x-opencodex-api-key": key }): Promise<Response> {
    return fetch(`http://127.0.0.1:${server!.port}/v1/models${query}`, { headers });
  }

  test("generated Desktop IDs preserve model switching and every effort through Messages to the adapter", async () => {
    launch();
    const snapshot = await (await request("?ids=desktop&format=desktop-config")).json() as { models: Array<{ name: string }> };
    for (const target of ["model-155", "model-123"]) {
      const selector = snapshot.models.find(model => resolveDesktop3pAlias(model.name) === `test/${target}`)!.name;
      expect(selector).toStartWith("claude-fable-5-p");
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        const response = await fetch(`http://127.0.0.1:${server!.port}/v1/messages`, {
          method: "POST", headers: { "content-type": "application/json", "x-opencodex-api-key": key },
          body: JSON.stringify({ model: selector, max_tokens: 32, stream: false,
            thinking: { type: "adaptive" }, output_config: { effort },
            messages: [{ role: "user", content: "fixture request" }] }),
        });
        expect(response.status, await response.text()).toBe(200);
        expect(upstreamRequests.at(-1)).toMatchObject({ model: target, reasoning_effort: effort });
        const row = getRequestLogEntries().find(entry => entry.requestId === response.headers.get("x-opencodex-request-id"));
        expect(row?.requestedEffort).toBe(effort);
      }
    }
    expect(upstreamRequests).toHaveLength(10);
  });

  test("HTTP discovery never publishes a routed row after wire and fallback collisions", async () => {
    const wire = "claude-fable-5-p000";
    const hash = desktop3pAlias("test", "model-155");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      launch(true, undefined, {
        providers: {
          test: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "fixture",
            allowPrivateNetwork: true, models: ["model-155"], liveModels: false },
          anthropic: { adapter: "anthropic", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: "fixture",
            authMode: "key", allowPrivateNetwork: true, models: [wire, hash], selectedModels: [wire, hash], liveModels: false },
        },
        claudeCode: { enabled: true, desktopNativeModels: false,
          desktopProfile: parseDesktopProfile({ version: 1,
            assignments: { "test/model-155": { family: "opus", alias: "claude-opus-4-8-20260101" } },
            defaults: { opus: "test/model-155", fable: null, sonnet: null, haiku: null },
          }),
        },
      });
      const response = await request("?flavor=anthropic&ids=desktop");
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string; display_name: string }> };
      expect(body.data.some(model => model.display_name === "model-155 (test)")).toBe(false);
      for (const id of [wire, hash]) {
        expect(body.data.some(model => model.id === id && model.display_name.endsWith("(anthropic)"))).toBe(true);
        expect(resolveDesktop3pAlias(id)).toBeNull();
      }
    } finally { warning.mockRestore(); }
  });

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

  test("snapshot installs Desktop-safe aliases, legacy decoders, and ordinary discovery shapes", async () => {
    launch();
    const legacyAlias = "claude-opus-4-8-20260304";
    const wireAlias = "claude-fable-5-p01q";
    const snapshot = await request("?ids=desktop&format=desktop-config");
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("cache-control")).toBe("no-store");
    const body = await snapshot.json() as { version: number; models: Array<{ name: string; anthropicFamilyTier: string }> };
    expect(body.version).toBe(1);
    expect(body.models.find(model => model.name === wireAlias)?.anthropicFamilyTier).toBe("fable");
    expect(resolveDesktop3pAlias(wireAlias)).toBe("test/model-155");
    expect(resolveDesktop3pAlias(legacyAlias)).toBe("test/model-155");
    expect(resolveDesktop3pAlias("claude-opus-4-8-p01q")).toBe("test/model-155");
    const anthropic = await request("?flavor=anthropic&ids=desktop");
    expect(anthropic.status).toBe(200);
    const anthropicBody = await anthropic.json() as { data: Array<{ id: string }>; version?: number };
    expect(anthropicBody.version).toBeUndefined();
    expect(anthropicBody.data.some(model => model.id === wireAlias)).toBe(true);
    expect(resolveDesktop3pAlias(wireAlias)).toBe("test/model-155");
    const cli = await request("?flavor=anthropic&ids=cli");
    expect(cli.status).toBe(200);
    expect((await cli.json() as { data: Array<{ id: string }> }).data.some(model => model.id.startsWith("ocx-claude-test--"))).toBe(true);
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
