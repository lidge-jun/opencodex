// 260718: Codex-facing slug codec for providers whose NATIVE model ids contain "/"
// (zenmux `moonshotai/kimi-k3-free`, openrouter `anthropic/...`, nvidia `moonshotai/...`).
// Codex's models-manager metadata lookup tolerates exactly one "/", so two-slash slugs
// lost tagging; the proxy aliases inner slashes to "_" and decodes bijectively.
// Plan: devlog/_plan/260718_slash_model_id_codec/000_plan.md.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  decodeRoutedModelId,
  encodeRoutedModelId,
  routedSlug,
  slugEquals,
  slugsEquivalent,
} from "../src/providers/slug-codec";
import { knownModelIdsForProvider, routeModel } from "../src/router";
import { buildCatalogEntries, resetCatalogRuntimeStateForTests } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { getJawcodeModelMetadata } from "../src/generated/jawcode-model-metadata";
import type { RawEntry } from "../src/codex/catalog";
import type { OcxConfig } from "../src/types";

beforeEach(() => {
  clearModelCache();
});

afterEach(() => {
  clearModelCache();
});

function zenmuxConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "zenmux",
    providers: {
      // Bare persisted config, like `ocx init` writes: registry seeds backfill the rest.
      zenmux: { adapter: "openai-chat", baseUrl: "https://zenmux.ai/api/v1", apiKey: "k" },
    },
  };
}

function nativeTemplate(): RawEntry {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "template",
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 9,
    base_instructions: "You are Codex, a coding agent based on GPT-5.\n\nBe helpful.",
  } as unknown as RawEntry;
}

describe("slug-codec primitives", () => {
  test("encode is a no-op for plain ids and maps inner slashes", () => {
    expect(encodeRoutedModelId("kimi-k3")).toBe("kimi-k3");
    expect(encodeRoutedModelId("moonshotai/kimi-k3-free")).toBe("moonshotai-kimi-k3-free");
    expect(routedSlug("zenmux", "moonshotai/kimi-k3-free")).toBe("zenmux/moonshotai-kimi-k3-free");
    expect(routedSlug("zenmux", "moonshotai-kimi-k3-free")).toBe("zenmux/moonshotai-kimi-k3-free");
  });

  test("decode precedence: native exact > unique alias > pass-through", () => {
    const known = ["moonshotai/kimi-k3-free", "a-b", "a/b"];
    // Native exact (raw selector back-compat) — wins even over the alias it collides with.
    expect(decodeRoutedModelId("a-b", known)).toBe("a-b");
    expect(decodeRoutedModelId("moonshotai/kimi-k3-free", known)).toBe("moonshotai/kimi-k3-free");
    // Unique alias match decodes.
    expect(decodeRoutedModelId("moonshotai-kimi-k3-free", known)).toBe("moonshotai/kimi-k3-free");
    // Unknown ids pass through unchanged (honest upstream error, never a blind decode).
    expect(decodeRoutedModelId("unknown/model-x", known)).toBe("unknown/model-x");
    expect(decodeRoutedModelId("moonshotai/kimi-k4", known)).toBe("moonshotai/kimi-k4");
  });

  test("ambiguous alias (no native plain form) refuses to guess", () => {
    // Both `x/y/z` and `x/y-z` encode to `x-y-z`; no native `x-y-z` exists.
    const known = ["x/y/z", "x/y-z"];
    expect(decodeRoutedModelId("x-y-z", known)).toBe("x-y-z");
  });

  test("slugEquals / slugsEquivalent tolerate raw and encoded mixes", () => {
    expect(slugEquals("zenmux/moonshotai/kimi-k3-free", "zenmux", "moonshotai/kimi-k3-free")).toBe(true);
    expect(slugEquals("zenmux/moonshotai-kimi-k3-free", "zenmux", "moonshotai/kimi-k3-free")).toBe(true);
    expect(slugEquals("zenmux/moonshotai-kimi-k3", "zenmux", "moonshotai/kimi-k3-free")).toBe(false);
    expect(slugsEquivalent("zenmux/moonshotai/kimi-k3-free", "zenmux/moonshotai-kimi-k3-free")).toBe(true);
    expect(slugsEquivalent("a/b", "c/b")).toBe(false);
    expect(slugsEquivalent("gpt-5.5", "gpt-5.5")).toBe(true);
  });
});

describe("routeModel decode (proxy layer)", () => {
  test("encoded zenmux slug decodes to the native id via the registry seed (cold cache)", () => {
    const route = routeModel(zenmuxConfig(), "zenmux/moonshotai-kimi-k3-free");
    expect(route.providerName).toBe("zenmux");
    expect(route.modelId).toBe("moonshotai/kimi-k3-free");
  });

  test("raw full-slash selector keeps working (back-compat)", () => {
    const route = routeModel(zenmuxConfig(), "zenmux/moonshotai/kimi-k3-free");
    expect(route.modelId).toBe("moonshotai/kimi-k3-free");
  });

  test("unknown encoded-looking id passes through unchanged", () => {
    const route = routeModel(zenmuxConfig(), "zenmux/moonshotai-kimi-k9");
    expect(route.modelId).toBe("moonshotai-kimi-k9");
  });

  test("registry model-keyed hint maps seed the decode union (nvidia, no static models list)", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "nvidia",
      providers: {
        nvidia: { adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "k" },
      },
    };
    const route = routeModel(config, "nvidia/moonshotai-kimi-k2.6");
    expect(route.modelId).toBe("moonshotai/kimi-k2.6");
    // And the raw form still routes to the same native id.
    expect(routeModel(config, "nvidia/moonshotai/kimi-k2.6").modelId).toBe("moonshotai/kimi-k2.6");
  });

  test("defaultModel encoded fallback routes to the native id", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "other",
      providers: {
        other: { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "k", defaultModel: "vendor/m-1" },
      },
    };
    const route = routeModel(config, "vendor-m-1");
    expect(route.providerName).toBe("other");
    expect(route.modelId).toBe("vendor/m-1");
  });

  test("models-list encoded fallback routes to the native id", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "other",
      providers: {
        other: { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "k", models: ["vendor/m-2"] },
      },
    };
    const route = routeModel(config, "vendor-m-2");
    expect(route.providerName).toBe("other");
    expect(route.modelId).toBe("vendor/m-2");
  });

  test("knownModelIdsForProvider unions config, registry, and hint-map ids", () => {
    const ids = knownModelIdsForProvider("zenmux", zenmuxConfig().providers.zenmux!);
    expect(ids).toContain("moonshotai/kimi-k3-free");
    expect(ids).toContain("moonshotai/kimi-k3");
  });
});

describe("catalog emission (Codex-facing)", () => {
  test("slash-id models emit exactly one-slash slugs", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "zenmux", id: "moonshotai/kimi-k3-free" },
    ]);
    const routed = entries.find(e => typeof e.slug === "string" && e.slug.startsWith("zenmux/"));
    expect(routed?.slug).toBe("zenmux/moonshotai-kimi-k3-free");
    expect((routed?.slug as string).split("/")).toHaveLength(2);
    expect(routed?.display_name).toBe("zenmux/moonshotai-kimi-k3-free");
    // Identity text uses the NATIVE model name, not the encoded alias.
    expect(String(routed?.base_instructions)).toContain("moonshotai/kimi-k3-free");
  });

  test("jawcode metadata resolves on the native id (template + null-template)", () => {
    const meta = getJawcodeModelMetadata("openrouter", "anthropic/claude-sonnet-5");
    expect(meta?.contextWindow).toBe(1_000_000);
    const model = { provider: "openrouter", id: "anthropic/claude-sonnet-5" };

    const withTemplate = buildCatalogEntries(nativeTemplate(), [], [model]);
    const encoded = withTemplate.find(e => e.slug === "openrouter/anthropic-claude-sonnet-5");
    expect(encoded?.context_window).toBe(1_000_000);
    expect(encoded?.input_modalities).toEqual(["text", "image"]);

    const withoutTemplate = buildCatalogEntries(null, [], [model]);
    const encodedFallback = withoutTemplate.find(e => e.slug === "openrouter/anthropic-claude-sonnet-5");
    expect(encodedFallback?.context_window).toBe(1_000_000);
    expect(encodedFallback?.input_modalities).toEqual(["text", "image"]);
  });

  test("alias collision: plain-hyphen native wins the slot, loser dropped, one warning across builds", () => {
    resetCatalogRuntimeStateForTests();
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = [
        { provider: "p", id: "a/b" },
        { provider: "p", id: "a-b" },
      ];
      const first = buildCatalogEntries(nativeTemplate(), [], models);
      const slugs = first.map(e => e.slug);
      expect(slugs).toEqual(["p/a-b"]);
      expect(warning).toHaveBeenCalledTimes(1);
      // Second build: dedupe holds and the warning does not re-fire.
      const second = buildCatalogEntries(nativeTemplate(), [], models);
      expect(second.map(e => e.slug)).toEqual(["p/a-b"]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
      resetCatalogRuntimeStateForTests();
    }
  });

  test("featured rank honors both raw (legacy) and encoded stored picks", () => {
    const models = [
      { provider: "zenmux", id: "moonshotai/kimi-k3-free" },
      { provider: "zenmux", id: "moonshotai/kimi-k3" },
    ];
    const rawFeatured = buildCatalogEntries(nativeTemplate(), [], models, ["zenmux/moonshotai/kimi-k3"]);
    expect(rawFeatured.find(e => e.slug === "zenmux/moonshotai-kimi-k3")?.priority).toBe(0);
    const encodedFeatured = buildCatalogEntries(nativeTemplate(), [], models, ["zenmux/moonshotai-kimi-k3"]);
    expect(encodedFeatured.find(e => e.slug === "zenmux/moonshotai-kimi-k3")?.priority).toBe(0);
  });
});
