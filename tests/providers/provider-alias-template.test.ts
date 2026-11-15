/**
 * #7705: an opt-in, per-provider alias template derived at resolution time. Manual aliases win,
 * then built-in ones, then the template; a generated name that would collide with anything already
 * claimed is skipped on both sides rather than renamed, so the result does not depend on roster
 * order. Nothing here writes configuration.
 */
import { describe, expect, test } from "bun:test";
import { aliasTemplateError, expandAliasTemplate, modelBasename } from "../../src/providers/alias-template";
import { effectiveModelAliases, templateAliasPlan } from "../../src/providers/default-aliases";
import { routeModel } from "../../src/router";
import { sanitizeAliasesForLoad } from "../../src/config/load-degrade";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const TEMPLATE = "{providerAlias}-{modelBasename}";

function config(models: string[], extra: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "other",
    providers: {
      cc: { adapter: "openai-chat", baseUrl: "https://cc.test/v1", alias: "CC", aliasTemplate: TEMPLATE, models, ...extra },
      other: { adapter: "openai-chat", baseUrl: "https://other.test/v1", models: ["o1-mini-x"] },
    },
  };
}

function aliases(c: OcxConfig, ids = c.providers.cc!.models as string[]) {
  return Object.fromEntries([...effectiveModelAliases(c, c.providers.cc!, ids, "cc")]
    .map(([id, value]) => [id, `${value.alias}:${value.source}`]));
}

describe("alias template grammar", () => {
  test("only the two literal placeholders are accepted, and the basename is required", () => {
    expect(aliasTemplateError(TEMPLATE)).toBeNull();
    expect(aliasTemplateError("{modelBasename}")).toBeNull();
    expect(aliasTemplateError("")).not.toBeNull();
    expect(aliasTemplateError("{providerAlias}")).not.toBeNull();
    expect(aliasTemplateError("{vendor}-{modelBasename}")).not.toBeNull();
    expect(aliasTemplateError("x-{modelBasename")).not.toBeNull();
    expect(aliasTemplateError("{model${1+1}}")).not.toBeNull();
  });

  test("the basename is the last path segment with colons as hyphens", () => {
    expect(modelBasename("command-code/reflection/beam:free")).toBe("beam-free");
    expect(modelBasename("plain")).toBe("plain");
    expect(expandAliasTemplate(TEMPLATE, "CC", "command-code/reflection/beam:free")).toEqual({ alias: "CC-beam-free" });
  });

  test("a missing provider alias or an output that is not a valid alias is skipped, never repaired", () => {
    expect(expandAliasTemplate(TEMPLATE, undefined, "x/y")).toEqual({ skip: "no_provider_alias" });
    expect(expandAliasTemplate(TEMPLATE, "CC", "vendor/has space")).toEqual({ skip: "invalid_alias" });
    expect(expandAliasTemplate("{modelBasename}", undefined, "gpt-5.9")).toEqual({ skip: "reserved_prefix" });
  });
});

describe("template aliases in the effective alias view", () => {
  test("every unaliased model gets a template alias with its own source", () => {
    expect(aliases(config(["reflection/beam:free", "reflection/ray"]))).toEqual({
      "reflection/beam:free": "CC-beam-free:template",
      "reflection/ray": "CC-ray:template",
    });
  });

  test("a manual alias wins, and its name is reserved against the template", () => {
    const c = config(["a/one", "b/two"], { modelAliases: { "a/one": "CC-two" } });
    expect(aliases(c)).toEqual({ "a/one": "CC-two:user" });
  });

  test("a built-in alias wins over the template", () => {
    const c = config(["anthropic/claude-opus-5-1", "x/plain"], { defaultAliases: true });
    expect(aliases(c)).toEqual({ "anthropic/claude-opus-5-1": "opus:builtin", "x/plain": "CC-plain:template" });
  });

  test("two ids with the same candidate are both skipped, whatever the roster order", () => {
    const ids = ["a/x:free", "b/x-free", "c/solo"];
    const c = config(ids);
    expect(aliases(c, ids)).toEqual({ "c/solo": "CC-solo:template" });
    expect(aliases(c, [...ids].reverse())).toEqual({ "c/solo": "CC-solo:template" });
  });

  test("a candidate that equals a native id, a built-in alias name or another provider's alias is skipped", () => {
    const c = config(["CC-native", "v/native", "v/opus", "v/sel"], { aliasTemplate: "{modelBasename}" });
    c.providers.other!.modelAliases = { "o1-mini-x": "sel" };
    // The basename template would name "CC-native" after itself (a native id), "v/opus" after a
    // built-in alias name and "v/sel" after other's manual alias; all three are skipped.
    expect(aliases(c)).toEqual({ "v/native": "native:template" });
  });

  test("a combo id is reserved too", () => {
    const c = config(["v/fast"], { aliasTemplate: "{modelBasename}" });
    c.combos = { fast: { targets: [] } } as never;
    expect(aliases(c)).toEqual({});
  });

  test("without a provider name the view is exactly what it was before templates", () => {
    const c = config(["x/plain"]);
    expect([...effectiveModelAliases(c, c.providers.cc!, ["x/plain"])]).toEqual([]);
  });

  test("the plan reports why a candidate was skipped", () => {
    const c = config(["a/x:free", "b/x-free", "bad id"]);
    const plan = templateAliasPlan(c, c.providers.cc!, "cc", c.providers.cc!.models as string[], new Map());
    expect(plan.accepted.size).toBe(0);
    expect(plan.skipped).toEqual([
      { id: "a/x:free", candidate: "CC-x-free", reason: "collision" },
      { id: "b/x-free", candidate: "CC-x-free", reason: "collision" },
      { id: "bad id", reason: "invalid_alias" },
    ]);
  });
});

describe("routing a template alias", () => {
  test("a bare template alias routes to its native id, and so does the provider-qualified one", () => {
    const c = config(["reflection/beam:free"]);
    expect(routeModel(c, "CC-beam-free")).toMatchObject({ providerName: "cc", modelId: "reflection/beam:free", routeReason: "model-alias" });
    expect(routeModel(c, "CC/CC-beam-free")).toMatchObject({ providerName: "cc", modelId: "reflection/beam:free" });
  });

  test("removing the template removes the alias at once", () => {
    const c = config(["reflection/beam:free"]);
    delete c.providers.cc!.aliasTemplate;
    expect(routeModel(c, "CC-beam-free")).toMatchObject({ providerName: "other", routeReason: "default-provider" });
  });

  test("two providers whose templates produce the same name: neither wins the bare name, each keeps its qualified one", () => {
    const c = config(["reflection/beam"], { aliasTemplate: "{modelBasename}-t" });
    c.providers.dd = { adapter: "openai-chat", baseUrl: "https://dd.test/v1", aliasTemplate: "{modelBasename}-t", models: ["vendor/beam"] };
    expect(() => routeModel(c, "beam-t")).toThrow("model alias 'beam-t' is ambiguous: CC/beam-t, dd/beam-t");
    expect(routeModel(c, "CC/beam-t")).toMatchObject({ providerName: "cc", modelId: "reflection/beam" });
    expect(routeModel(c, "dd/beam-t")).toMatchObject({ providerName: "dd", modelId: "vendor/beam" });
  });
});

describe("loading a hand-edited alias template", () => {
  test("an invalid template is dropped with a warning; a valid one is kept", () => {
    const warnings: string[] = [];
    const raw = { providers: {
      cc: { adapter: "openai-chat", baseUrl: "https://cc.test", aliasTemplate: "{vendor}-{modelBasename}" },
      ok: { adapter: "openai-chat", baseUrl: "https://ok.test", aliasTemplate: "{modelBasename}" },
      odd: { adapter: "openai-chat", baseUrl: "https://odd.test", aliasTemplate: 42 },
    } };
    sanitizeAliasesForLoad(raw, message => warnings.push(message));
    expect("aliasTemplate" in raw.providers.cc).toBe(false);
    expect(raw.providers.ok.aliasTemplate).toBe("{modelBasename}");
    expect("aliasTemplate" in raw.providers.odd).toBe(false);
    expect(warnings).toEqual([
      "Ignoring invalid alias template for provider cc in config.json",
      "Ignoring invalid alias template for provider odd in config.json",
    ]);
  });
});

describe("registry provider aliases", () => {
  test("a provider's registry alias is reserved even when it sets none of its own", () => {
    const c = config(["vendor/agy", "vendor/beam"], { aliasTemplate: "{modelBasename}" });
    c.providers["google-antigravity"] = { adapter: "google-antigravity", baseUrl: "https://agy.test/v1" } as OcxProviderConfig;
    const plan = templateAliasPlan(c, c.providers.cc!, "cc", ["vendor/agy", "vendor/beam"], new Map());
    expect([...plan.accepted]).toEqual([["vendor/beam", "beam"]]);
    expect(plan.skipped).toEqual([{ id: "vendor/agy", candidate: "agy", reason: "reserved" }]);
  });
});
