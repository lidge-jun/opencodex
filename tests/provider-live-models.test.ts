import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";

// Phase 2 of devlog/model_update/260709_model_refresh: live /models discovery is the
// authoritative lineup; static config lists are the fallback seed. These tests pin the
// authority/fallback contract of fetchProviderModels through the public gatherRoutedModels seam.

const PROVIDER = "xai-live-test";
const HY3_PROVIDER = "opencode-go";
const HY3_CONTROL_PROVIDER = "hy3-control-live-test";

function config(): OcxConfig {
  return {
    providers: {
      [PROVIDER]: {
        baseUrl: "https://api.x.ai/v1",
        adapter: "openai-chat",
        authMode: "key",
        apiKey: "sk-test",
        models: ["grok-4.5", "grok-4.3"],
        modelContextWindows: { "grok-4.5": 500_000 },
      },
    },
  } as unknown as OcxConfig;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache(PROVIDER);
  clearModelCache(HY3_PROVIDER);
  clearModelCache(HY3_CONTROL_PROVIDER);
});

describe("live provider model discovery (authority + fallback)", () => {
  test("successful live /models is authoritative and drops configured-only ids", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let requested: { url: string; auth: string | undefined } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requested = {
        url: String(url),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
      };
      return new Response(JSON.stringify({
        data: [
          { id: "grok-4.5", context_length: 500_000 },
          { id: "grok-5-preview", context_length: 1_000_000 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels(config());
      const ids = models.filter(m => m.provider === PROVIDER).map(m => m.id);

      expect(requested?.url).toBe("https://api.x.ai/v1/models");
      expect(requested?.auth).toBe("Bearer sk-test");
      expect(ids.sort()).toEqual(["grok-4.5", "grok-5-preview"]);
      expect(models.find(m => m.provider === PROVIDER && m.id === "grok-5-preview")?.contextWindow)
        .toBe(1_000_000);
      expect(models.find(m => m.provider === PROVIDER && m.id === "grok-4.5")?.contextWindow)
        .toBe(500_000);
      const warningText = warning.mock.calls.flat().join(" ");
      expect(warningText).toContain(PROVIDER);
      expect(warningText).toContain("grok-4.3");
    } finally {
      warning.mockRestore();
    }
  });

  test("HY3 compatibility guard hides only opencode-go/hy3-preview from live discovery", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const isOpenCodeGo = String(url).startsWith("https://opencode-go.test/");
      return new Response(JSON.stringify({
        data: isOpenCodeGo
          ? [
              { id: "glm-5.2" },
              { id: "hy3-preview" },
              { id: "future-live-model" },
            ]
          : [{ id: "hy3-preview" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      providers: {
        [HY3_PROVIDER]: {
          baseUrl: "https://opencode-go.test/v1",
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "sk-test",
          models: ["glm-5.2"],
        },
        [HY3_CONTROL_PROVIDER]: {
          baseUrl: "https://hy3-control.test/v1",
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "sk-test",
        },
      },
    } as unknown as OcxConfig);
    const slugs = models.map(model => `${model.provider}/${model.id}`);

    expect(slugs).not.toContain("opencode-go/hy3-preview");
    expect(slugs).toContain("opencode-go/glm-5.2");
    expect(slugs).toContain("opencode-go/future-live-model");
    expect(slugs).toContain("hy3-control-live-test/hy3-preview");
  });

  test("fetch failure falls back to the configured static list", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const models = await gatherRoutedModels(config());
    const ids = models.filter(m => m.provider === PROVIDER).map(m => m.id);

    expect(ids.sort()).toEqual(["grok-4.3", "grok-4.5"]);
    expect(models.find(m => m.provider === PROVIDER && m.id === "grok-4.5")?.contextWindow)
      .toBe(500_000);
  });

  test("non-ok response also falls back to statics (and cooldown clears via clearModelCache)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    const models = await gatherRoutedModels(config());
    const ids = models.filter(m => m.provider === PROVIDER).map(m => m.id);
    expect(ids.sort()).toEqual(["grok-4.3", "grok-4.5"]);
  });
});
