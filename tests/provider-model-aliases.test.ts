import { describe, expect, test } from "bun:test";
import { effectiveModelAliases } from "../src/providers/default-aliases";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alpha",
    providers: {
      alpha: { adapter: "openai-chat", baseUrl: "https://alpha.test/v1", alias: "a", models: ["native", "vendor/claude-opus-5-202608"] , modelAliases: { native: "tiny" } },
      beta: { adapter: "openai-chat", baseUrl: "https://beta.test/v1", alias: "b", models: ["other"] },
    },
  };
}

describe("provider and model aliases", () => {
  test("qualified provider and model aliases resolve to the native upstream id", () => {
    expect(routeModel(config(), "a/tiny")).toMatchObject({ providerName: "alpha", modelId: "native" });
  });

  test("qualified canonical provider and native model win before aliases", () => {
    const c = config();
    c.providers.alpha.modelAliases = { other: "native" };
    expect(routeModel(c, "alpha/native")).toMatchObject({ providerName: "alpha", modelId: "native" });
  });

  test("bare alias wins only immediately before defaultProvider fallback", () => {
    expect(routeModel(config(), "tiny")).toMatchObject({ providerName: "alpha", modelId: "native", routeReason: "model-alias" });
    const absent = config();
    delete absent.providers.alpha.modelAliases;
    expect(routeModel(absent, "tiny")).toMatchObject({ providerName: "alpha", modelId: "tiny", routeReason: "default-provider" });
  });

  test("native family and configured native model steps cannot be shadowed", () => {
    const c = config();
    c.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" };
    c.providers.alpha.modelAliases = { native: "gpt-5.6-sol", "vendor/claude-opus-5-202608": "other" };
    expect(routeModel(c, "gpt-5.6-sol").providerName).toBe("openai");
    expect(routeModel(c, "other")).toMatchObject({ providerName: "beta", modelId: "other" });
  });

  test("bare ambiguity is deterministic and qualified aliases remain usable", () => {
    const c = config();
    c.providers.beta.modelAliases = { other: "tiny" };
    expect(() => routeModel(c, "tiny")).toThrow("model alias 'tiny' is ambiguous: a/tiny, b/tiny");
    expect(routeModel(c, "b/tiny")).toMatchObject({ providerName: "beta", modelId: "other" });
  });

  test("a built-in alias is disabled when multiple ids in one provider claim it", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://x.test", defaultAliases: true, models: ["anthropic/claude-opus-5-a", "anthropic/claude-opus-5-b"] };
    expect([...effectiveModelAliases({ defaultModelAliases: false }, provider, provider.models)]).toEqual([]);
  });

  test("an unambiguous aggregator tail receives its built-in alias", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://x.test", defaultAliases: true, models: ["anthropic/claude-opus-5-a"] };
    expect([...effectiveModelAliases({ defaultModelAliases: false }, provider, provider.models)]).toEqual([
      ["anthropic/claude-opus-5-a", { alias: "opus", source: "builtin" }],
    ]);
  });
});
