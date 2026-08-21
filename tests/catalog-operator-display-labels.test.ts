import { describe, expect, test } from "bun:test";

import {
  applyOperatorDisplayLabels,
  isValidDisplayLabel,
  MAX_DISPLAY_LABEL_LENGTH,
  resolveModelDisplayLabel,
} from "../src/codex/catalog/display-labels";
import { COMBO_NAMESPACE } from "../src/combos/types";
import {
  CODEX_CUSTOM_MODEL_CATALOG_KIND,
  CODEX_PROVIDER_MODEL_CATALOG_KIND,
} from "../src/codex/catalog/parsing";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import { MAX_MODEL_DISPLAY_NAMES, validateConfigCandidate } from "../src/config";
import { providerDisplayNamesConfigError } from "../src/server/management/provider-capability-config";
import type { OcxConfig } from "../src/types/config";

/** The reported case: a discovered NVIDIA NIM row whose label is its routed slug. */
const NVIDIA: CatalogModel = {
  provider: "nvidia",
  id: "deepseek-ai/deepseek-v4-flash-0731",
  owned_by: "nvidia",
};

function configWith(providers: Record<string, unknown>): OcxConfig {
  return { providers } as unknown as OcxConfig;
}

describe("isValidDisplayLabel", () => {
  test("accepts a normal single-line label", () => {
    expect(isValidDisplayLabel("DeepSeek V4 Flash")).toBe(true);
  });

  test("rejects a label containing a slash, which would read as a routed slug", () => {
    expect(isValidDisplayLabel("nvidia/deepseek")).toBe(false);
  });

  test("rejects blank, non-string and over-long labels", () => {
    expect(isValidDisplayLabel("   ")).toBe(false);
    expect(isValidDisplayLabel(undefined)).toBe(false);
    expect(isValidDisplayLabel(42)).toBe(false);
    expect(isValidDisplayLabel("x".repeat(MAX_DISPLAY_LABEL_LENGTH + 1))).toBe(false);
  });

  test("accepts a label exactly at the bound", () => {
    expect(isValidDisplayLabel("x".repeat(MAX_DISPLAY_LABEL_LENGTH))).toBe(true);
  });

  test("rejects a label carrying a control character", () => {
    expect(isValidDisplayLabel("DeepSeek\u0007V4")).toBe(false);
  });

  test("no control character can reach the stored label, whichever side of trim it falls on", () => {
    // The check runs on the trimmed value, so the whitespace-class controls are
    // normalised away rather than rejected: `"Label\n"` stores as `"Label"`. Every
    // other control character is rejected wherever it sits. Pinned explicitly
    // because the outcome depends on trim() and the class overlapping, which is
    // not obvious from either line on its own.
    for (const edge of ["\u000a", "\u0009", "\u000d"]) {
      expect(isValidDisplayLabel(`Label${edge}`)).toBe(true);
      expect(isValidDisplayLabel(`${edge}Label`)).toBe(true);
      expect(resolveModelDisplayLabel(
        configWith({ nvidia: { modelDisplayNames: { [NVIDIA.id]: `Label${edge}` } } }),
        NVIDIA,
      )).toBe("Label");
    }
    for (const inner of ["\u0000", "\u0007", "\u001f", "\u007f"]) {
      expect(isValidDisplayLabel(`Label${inner}`)).toBe(false);
      expect(isValidDisplayLabel(`La${inner}bel`)).toBe(false);
    }
    // A control character mid-label is rejected even from the whitespace class,
    // because a label is single-line by definition.
    expect(isValidDisplayLabel("La\u000abel")).toBe(false);
  });
});

describe("resolveModelDisplayLabel precedence", () => {
  test("an operator override wins and is trimmed", () => {
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "  DeepSeek V4 Flash  " } },
    });
    expect(resolveModelDisplayLabel(config, NVIDIA)).toBe("DeepSeek V4 Flash");
  });

  test("discovery metadata is used when no override exists", () => {
    const config = configWith({ nvidia: {} });
    const discovered = { ...NVIDIA, displayName: "DeepSeek V4 Flash (upstream)" };
    expect(resolveModelDisplayLabel(config, discovered)).toBe("DeepSeek V4 Flash (upstream)");
  });

  test("an operator override outranks discovery metadata", () => {
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "Operator Label" } },
    });
    const discovered = { ...NVIDIA, displayName: "Upstream Label" };
    expect(resolveModelDisplayLabel(config, discovered)).toBe("Operator Label");
  });

  test("an invalid override falls through rather than taking effect", () => {
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "bad/label" } },
    });
    const discovered = { ...NVIDIA, displayName: "Upstream Label" };
    expect(resolveModelDisplayLabel(config, discovered)).toBe("Upstream Label");
    expect(resolveModelDisplayLabel(config, NVIDIA)).toBeUndefined();
  });

  test("no override and no metadata leaves the caller on its derived slug", () => {
    expect(resolveModelDisplayLabel(configWith({ nvidia: {} }), NVIDIA)).toBeUndefined();
    expect(resolveModelDisplayLabel(configWith({}), NVIDIA)).toBeUndefined();
  });

  test("an override keyed on the routed slug rather than the native id does not apply", () => {
    // The key space is the native model id, the same as `modelAdapters`.
    const config = configWith({
      nvidia: { modelDisplayNames: { "nvidia/deepseek-ai-deepseek-v4-flash-0731": "Wrong Key" } },
    });
    expect(resolveModelDisplayLabel(config, NVIDIA)).toBeUndefined();
  });

  test("an explicit custom-model row keeps the label the operator already typed", () => {
    // #2201's migration rule. Matching on catalogKind rather than provider name is
    // what makes this hold: a custom model shares its provider with the discovered
    // rows this feature exists to relabel, so the provider name cannot separate them.
    const custom = {
      provider: "nvidia",
      id: "deepseek-ai/deepseek-v4-flash-0731",
      displayName: "My Existing Custom Label",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
    } as CatalogModel;
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "Provider Map Value" } },
    });
    expect(resolveModelDisplayLabel(config, custom)).toBe("My Existing Custom Label");
  });

  test("a discovered row on the same provider is still relabelled", () => {
    // The guard above must not be so broad that it disables the feature.
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "Provider Map Value" } },
    });
    expect(resolveModelDisplayLabel(config, NVIDIA)).toBe("Provider Map Value");
    expect(resolveModelDisplayLabel(config, { ...NVIDIA, catalogKind: CODEX_PROVIDER_MODEL_CATALOG_KIND }))
      .toBe("Provider Map Value");
  });

  test("a combo row keeps its own label and cannot be relabelled from provider config", () => {
    const combo: CatalogModel = {
      provider: COMBO_NAMESPACE,
      id: "my-combo",
      displayName: "My Combo",
    };
    const config = configWith({
      [COMBO_NAMESPACE]: { modelDisplayNames: { "my-combo": "Hijacked" } },
    });
    expect(resolveModelDisplayLabel(config, combo)).toBe("My Combo");
  });
});

describe("applyOperatorDisplayLabels", () => {
  test("labels only the matching row and never mutates the input", () => {
    const other: CatalogModel = { provider: "nvidia", id: "moonshotai/kimi-k3" };
    const models = [NVIDIA, other];
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "DeepSeek V4 Flash" } },
    });

    const labeled = applyOperatorDisplayLabels(models, config);

    expect(labeled[0]?.displayName).toBe("DeepSeek V4 Flash");
    expect(labeled[1]?.displayName).toBeUndefined();
    expect(NVIDIA.displayName).toBeUndefined();
    expect(models[0]).toBe(NVIDIA);
  });

  test("routing identity is untouched by relabelling", () => {
    const config = configWith({
      nvidia: { modelDisplayNames: { "deepseek-ai/deepseek-v4-flash-0731": "DeepSeek V4 Flash" } },
    });
    const [labeled] = applyOperatorDisplayLabels([NVIDIA], config);
    expect(labeled?.provider).toBe("nvidia");
    expect(labeled?.id).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(labeled?.owned_by).toBe("nvidia");
  });

  test("returns the identical array when nothing resolves", () => {
    const models = [NVIDIA];
    expect(applyOperatorDisplayLabels(models, configWith({ nvidia: {} }))).toBe(models);
  });
});

describe("modelDisplayNames config contract", () => {
  const load = (modelDisplayNames: unknown) =>
    validateConfigCandidate({
      defaultProvider: "nvidia",
      providers: { nvidia: { adapter: "openai", baseUrl: "https://nim.example/v1", modelDisplayNames } },
    });
  const kept = (modelDisplayNames: unknown) => {
    const result = load(modelDisplayNames);
    if (!result.ok) throw new Error(`unexpectedly rejected: ${result.error}`);
    return result.config.providers.nvidia?.modelDisplayNames;
  };
  const writeError = (modelDisplayNames: unknown) =>
    providerDisplayNamesConfigError("nvidia", {
      adapter: "openai", baseUrl: "https://nim.example/v1", modelDisplayNames,
    });

  // The two paths answer different questions, so they are allowed to differ:
  // "can this file still be served?" versus "is this a valid edit?".
  test("load keeps a well-formed map, trimming the label", () => {
    expect(kept({ m: "  DeepSeek V4 Flash  " })).toEqual({ m: "DeepSeek V4 Flash" });
    expect(writeError({ m: "DeepSeek V4 Flash" })).toBeNull();
  });

  test("load drops an unusable entry instead of failing the whole config", () => {
    for (const bad of [["array"], { m: "bad/label" }, { m: 42 }, { "": "blank key" }, "string"]) {
      expect(load(bad).ok).toBe(true);
      expect(kept(bad)).toBeUndefined();
    }
  });

  test("a write of the same values is refused, so a bad label never lands silently", () => {
    expect(writeError(["array"])).toMatch(/must be a plain object/);
    expect(writeError({ m: "bad/label" })).toMatch(/must not contain '\/'/);
    expect(writeError({ m: 42 })).toMatch(/must be a string/);
    expect(writeError({ "": "blank key" })).toMatch(/nonblank model ids/);
  });

  test("one bad neighbour does not evict the operator's other labels", () => {
    expect(kept({ bad: "a/b", good: "Kimi K3" })).toEqual({ good: "Kimi K3" });
  });

  test("null is an explicit clear on both paths", () => {
    expect(kept({ m: null })).toBeUndefined();
    expect(writeError({ m: null })).toBeNull();
  });

  test("the map is bounded, and the bound is a write error rather than silent truncation", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: MAX_MODEL_DISPLAY_NAMES + 1 }, (_, i) => [`m${i}`, `L${i}`]),
    );
    expect(Object.keys(kept(oversized) ?? {}).length).toBe(MAX_MODEL_DISPLAY_NAMES);
    expect(writeError(oversized)).toMatch(/at most 512 entries/);
  });

  test("a prototype key is not a usable label source", () => {
    // `{}.constructor` is a function, not a string, so the lookup in
    // resolveModelDisplayLabel cannot promote it to a label.
    const config = configWith({ nvidia: { modelDisplayNames: {} } });
    expect(resolveModelDisplayLabel(config, { provider: "nvidia", id: "constructor" } as CatalogModel))
      .toBeUndefined();
  });
});
