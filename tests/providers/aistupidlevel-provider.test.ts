import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveInitProviders, deriveProviderPresets, enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import { candidateCapabilityEvidence } from "../../src/routing/capability";
import { startServer } from "../../src/server";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { resetVisionDescriptionCache } from "../../src/vision";
import { isModelVisionSidecarConsumer, isVisionSidecarConsumer } from "../../src/vision/eligibility";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const originalFetch = globalThis.fetch;
const baseUrl = "https://aistupidlevel.info/v1";
// The routing modes the authenticated GET /v1/models listed on 2026-10-23 and again on 2026-10-26.
const ROUTING_MODES = [
  "auto-coding", "auto-tooling", "auto-reasoning", "auto-best", "auto", "auto-task",
  "auto-value", "auto-value-coding", "auto-value-tooling", "auto-value-reasoning",
  "auto-fastest-quality", "auto-consistent", "auto-cheapest", "auto-fastest", "auto-split",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("aistupidlevel");
});

function entry() {
  const row = PROVIDER_REGISTRY.find(candidate => candidate.id === "aistupidlevel");
  if (!row) throw new Error("missing AI Stupid Level preset");
  return row;
}

function config(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return withStubbedProviderFetch({
    port: 10100,
    defaultProvider: "aistupidlevel",
    providers: { aistupidlevel: { ...providerConfigSeed(entry()), apiKey: "test-key", ...overrides } },
  });
}

describe("AI Stupid Level provider", () => {
  test("is offered by ocx provider add, ocx init and the dashboard picker", () => {
    expect(deriveInitProviders().find(row => row.id === "aistupidlevel")).toMatchObject({
      label: "AI Stupid Level", kind: "key", adapter: "openai-chat", baseUrl,
    });
    const preset = deriveProviderPresets().find(row => row.id === "aistupidlevel");
    expect(preset).toMatchObject({ auth: "key", dashboardUrl: "https://aistupidlevel.info/router/keys" });
    expect(preset?.sponsor).toBeUndefined();
    expect(KEY_LOGIN_PROVIDERS.aistupidlevel?.defaultModel).toBe("auto-coding");
  });

  test("seeds the routing modes as text-only, with limits that hold for any routed model", () => {
    const seeded = config().providers.aistupidlevel!;
    expect(seeded).toMatchObject({ adapter: "openai-chat", baseUrl, defaultModel: "auto-coding", liveModels: true });
    expect(entry().models).toEqual([...ROUTING_MODES]);
    for (const mode of ROUTING_MODES) {
      expect(seeded.modelContextWindows?.[mode]).toBe(262_144);
      expect(seeded.modelMaxOutputTokens?.[mode]).toBe(64_000);
      // Text-only: the vision sidecar describes an image before the request reaches the router.
      expect(isModelVisionSidecarConsumer(seeded, mode)).toBe(true);
    }
  });

  test.each(["auto-coding", "auto-tooling", "claude-opus-5-5"])("%s routes over Chat with its upstream id unchanged", model => {
    const route = routeModel(config(), `aistupidlevel/${model}`);
    expect(route.modelId).toBe(model);
    expect(route.provider).toMatchObject({ adapter: "openai-chat", baseUrl });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("aistupidlevel", model, config().providers.aistupidlevel!, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("keeps a same-named custom destination instead of retargeting it", () => {
    const custom = config({ baseUrl: "https://relay.example.test/v1" });
    expect(routeModel(custom, "aistupidlevel/custom-model").provider.baseUrl).toBe("https://relay.example.test/v1");
  });

  test("lists routing modes and pinnable models from the authenticated live catalog", async () => {
    let requests = 0;
    globalThis.fetch = (async (input, init) => {
      requests++;
      expect(String(input)).toBe("https://aistupidlevel.info/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      // The upstream row shape: id, object, created and owned_by only.
      return Response.json({ object: "list", data: [
        { id: "auto-coding", object: "model", created: 1792750208, owned_by: "aistupidlevel" },
        { id: "auto-tooling", object: "model", created: 1792750208, owned_by: "aistupidlevel" },
        { id: "claude-opus-5-5", object: "model", created: 1792750208, owned_by: "anthropic" },
      ] });
    }) as typeof fetch;
    const models = (await gatherRoutedModels(config())).filter(row => row.provider === "aistupidlevel");
    expect(requests).toBe(1);
    expect(models.map(row => row.id).sort()).toEqual(["auto-coding", "auto-tooling", "claude-opus-5-5"]);
  });

  test("validates a key against the key-gated model list and separates rejection from an outage", async () => {
    expect(buildModelsRequest(config().providers.aistupidlevel!, "test-key", "aistupidlevel").url)
      .toBe("https://aistupidlevel.info/v1/models");
    for (const [status, expected] of [[200, true], [401, false], [503, "unknown"]] as const) {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://aistupidlevel.info/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return new Response(status === 200 ? JSON.stringify({ object: "list", data: [] }) : null, { status });
      }) as typeof fetch;
      expect(await validateApiKey("aistupidlevel", KEY_LOGIN_PROVIDERS.aistupidlevel!, "test-key")).toBe(expected);
    }
  });
});

describe("AI Stupid Level text-only contract for pinned models", () => {
  // A live id that no registry map lists: the provider-wide declaration must cover it.
  const PINNED = "claude-sonnet-4-6";
  const IMAGE = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";
  let previousHome: string | undefined;
  let previousCodexHome: string | undefined;
  let home = "";
  let codexHome: IsolatedCodexHome | null = null;
  let mainCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    codexHome = installIsolatedCodexHome("ocx-asl-text-only-codex-");
    home = mkdtempSync(join(tmpdir(), "ocx-asl-text-only-"));
    process.env.OPENCODEX_HOME = home;
    clearModelCache();
    resetVisionDescriptionCache();
    mainCalls = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://aistupidlevel.info") {
        if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: PINNED, object: "model" }] });
        if (url.pathname === "/v1/chat/completions") {
          mainCalls.push(JSON.parse(String(init?.body)));
          return Response.json({
            id: "chatcmpl-asl-text-only", object: "chat.completion", model: PINNED,
            choices: [{ index: 0, message: { role: "assistant", content: "No image here." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          });
        }
      }
      if (url.hostname === "127.0.0.1") return originalFetch(input, init);
      throw new Error("Unexpected network destination in AI Stupid Level text-only fixture");
    }) as typeof fetch;
  });

  async function cleanupFixture(removeTree = removeTreeAfterBackgroundWork): Promise<void> {
    const failures: unknown[] = [];
    try {
      // A case can leave tracked teardown work (config-dir ACL hardening, an icacls
      // reap) holding a file in either fixture tree. Settle and reap before removing,
      // and remove both through the same drain-aware path: codexHome.restore() would
      // delete its tree synchronously ahead of the drain and swallow a sharing
      // violation. The env restore is unconditional so a retained, named tree never
      // leaks into the next case's config resolution.
      for (const root of [home, codexHome?.path]) {
        if (!root) continue;
        try { await removeTree(root); }
        catch (error) { failures.push(error); }
      }
      // A sharing violation in one tree must not strand the other. Preserve a
      // single error's identity, and report both causes when both removals fail.
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "AI Stupid Level fixture cleanup failed");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      codexHome?.restoreEnvironment();
    }
  }

  // Cover both drain/retry sequences with reap headroom; a stuck ACL child must still time out.
  afterEach(async () => {
    clearModelCache();
    resetVisionDescriptionCache();
    try {
      await cleanupFixture();
    } finally {
      home = "";
      codexHome = null;
    }
  }, 3 * SERVER_BUDGET_MS);

  test.each(["home", "codex", "both"] as const)(
    "attempts both removals and restores the environment when %s cleanup fails",
    async failingRoot => {
      const roots = [home, codexHome!.path];
      const attempted: string[] = [];
      const homeError = new Error("fixture home removal failed");
      const codexError = new Error("fixture Codex home removal failed");
      const expectedError = failingRoot === "codex" ? codexError : homeError;
      const cleanupError = await cleanupFixture(async root => {
        attempted.push(root);
        if (root === roots[0] && failingRoot !== "codex") throw homeError;
        if (root === roots[1] && failingRoot !== "home") throw codexError;
        await removeTreeAfterBackgroundWork(root);
      }).catch(error => error);
      if (failingRoot === "both") {
        expect(cleanupError).toBeInstanceOf(AggregateError);
        expect(cleanupError.errors).toHaveLength(2);
        expect(cleanupError.errors[0]).toBe(homeError);
        expect(cleanupError.errors[1]).toBe(codexError);
      } else {
        expect(cleanupError).toBe(expectedError);
      }
      expect(attempted).toEqual(roots);
      expect(process.env.OPENCODEX_HOME).toBe(previousHome);
      expect(process.env.CODEX_HOME).toBe(previousCodexHome);
      expect(existsSync(roots[0]!)).toBe(failingRoot !== "codex");
      expect(existsSync(roots[1]!)).toBe(failingRoot !== "home");
      // afterEach retries any deliberately retained tree through the real remover.
    },
  );

  test("a pinned live id needs vision preprocessing at the preset destination", () => {
    const saved = config();
    // Registry-only: the saved row does not carry the declaration; routing backfills it.
    expect(saved.providers.aistupidlevel!.inputModalities).toBeUndefined();
    const route = routeModel(saved, `aistupidlevel/${PINNED}`);
    expect(route.modelId).toBe(PINNED);
    expect(route.provider.inputModalities).toEqual(["text"]);
    expect(requiresVisionPreprocessing(saved, route.provider, route.modelId, route.providerName)).toBe(true);
  });

  test("a same-named custom destination does not inherit the text-only declaration", () => {
    const custom: OcxConfig = {
      port: 10100, defaultProvider: "aistupidlevel",
      providers: { aistupidlevel: { adapter: "openai-chat", baseUrl: "https://relay.example.test/v1", apiKey: "test-key" } },
    };
    // A row seeded from the preset and then pointed at another URL must drop it too.
    const moved = config({ baseUrl: "https://relay.example.test/v1" });
    expect(moved.providers.aistupidlevel!.inputModalities).toBeUndefined();
    for (const candidate of [custom, moved]) {
      const route = routeModel(candidate, `aistupidlevel/${PINNED}`);
      expect(route.provider.baseUrl).toBe("https://relay.example.test/v1");
      expect(route.provider.inputModalities).toBeUndefined();
      expect(requiresVisionPreprocessing(candidate, route.provider, route.modelId, route.providerName)).toBe(false);
      expect(candidateCapabilityEvidence(candidate, "aistupidlevel", PINNED).image).toBeUndefined();
    }
  });

  test("registry enrichment never writes the declaration into a saved provider object", () => {
    const saved = config();
    enrichProviderFromRegistry("aistupidlevel", saved.providers.aistupidlevel!);
    expect(saved.providers.aistupidlevel!.inputModalities).toBeUndefined();
    // The runtime classification still applies at the preset destination, and only there.
    expect(isVisionSidecarConsumer(saved, "aistupidlevel", PINNED)).toBe(true);
    expect(isVisionSidecarConsumer(config({ baseUrl: "https://relay.example.test/v1" }), "aistupidlevel", PINNED)).toBe(false);
  });

  test.each(["aistupidlevel", "my-asl"])("%s: an image sent to a pinned model never reaches the router", async providerName => {
    saveConfig({
      port: 0, hostname: "127.0.0.1", defaultProvider: providerName,
      providers: { [providerName]: { ...providerConfigSeed(entry()), apiKey: "fixture-asl-key" } },
    });
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${providerName}/${PINNED}`, stream: false,
          input: [{ role: "user", content: [
            { type: "input_text", text: "Describe this image." }, { type: "input_image", image_url: IMAGE },
          ] }],
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(mainCalls).toHaveLength(1);
      const forwarded = JSON.stringify(mainCalls[0]);
      expect(forwarded).not.toContain(IMAGE);
      expect(forwarded).not.toContain("image_url");
      expect(forwarded).toContain("[image omitted:");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS); // the file's only cases binding a real server; Windows startup measured ~4.8s of Bun's 5s default.
});
