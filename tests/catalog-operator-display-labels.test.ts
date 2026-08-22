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

  test("ordinary ASCII whitespace at the edges is normalised, not rejected", () => {
    // Deliberately forgiving, and only for this class: a stray space, tab, newline
    // or CR in a hand-edited config is plausible slop, and on the load path a
    // rejection means silently losing the operator's label. `"Label\n"` therefore
    // stores as `"Label"` rather than disappearing.
    for (const edge of ["\u0020", "\u0009", "\u000a", "\u000d"]) {
      expect(isValidDisplayLabel(`Label${edge}`)).toBe(true);
      expect(isValidDisplayLabel(`${edge}Label`)).toBe(true);
      expect(resolveModelDisplayLabel(
        configWith({ nvidia: { modelDisplayNames: { [NVIDIA.id]: `Label${edge}` } } }),
        NVIDIA,
      )).toBe("Label");
    }
    // Mid-label, the same characters are rejected: a label is single-line.
    expect(isValidDisplayLabel("La\u000abel")).toBe(false);
    expect(isValidDisplayLabel("La\u0009bel")).toBe(false);
  });

  test("no control character reaches a stored label — C0, DEL, C1, and the line separators", () => {
    // The class was originally C0 + DEL only. C1 (U+0080-U+009F) and U+2028/U+2029
    // leaked: `Label<U+0085>More` and `Label<U+2028>More` were reported valid and
    // stored verbatim, and both are line breaks, so the "single-line" guarantee did
    // not hold.
    //
    // The invariant is about what is STORED, not what is rejected — an edge TAB or
    // newline is accepted and normalised away, which is deliberate. So this walks the
    // ranges and, for every candidate the validator accepts, checks the value that
    // actually lands on the row. Enumerated rather than sampled so a future narrowing
    // of the regex cannot slip past this test.
    const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
    const leaked: string[] = [];
    for (const code of [
      ...Array.from({ length: 0x20 }, (_, i) => i),          // C0
      0x7f,                                                   // DEL
      ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),    // C1
      0x2028, 0x2029,                                         // LINE / PARAGRAPH SEPARATOR
    ]) {
      const ch = String.fromCharCode(code);
      const hex = `U+${code.toString(16).padStart(4, "0").toUpperCase()}`;
      for (const candidate of [`La${ch}bel`, `Label${ch}`, `${ch}Label`, ch]) {
        if (!isValidDisplayLabel(candidate)) continue;
        const stored = resolveModelDisplayLabel(
          configWith({ nvidia: { modelDisplayNames: { [NVIDIA.id]: candidate } } }),
          NVIDIA,
        );
        if (stored !== undefined && CONTROL.test(stored)) {
          leaked.push(`${hex} stored as ${JSON.stringify(stored)}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  test("a C1 control or line separator is rejected outright, not normalised", () => {
    // The distinction from the whitespace class above: these are never plausible slop
    // in a display label, and U+2028/U+2029 are in JS's whitespace set, so trimming
    // first would have quietly accepted a trailing one.
    for (const code of [0x85, 0x80, 0x9f, 0x2028, 0x2029]) {
      const ch = String.fromCharCode(code);
      expect(isValidDisplayLabel(`La${ch}bel`)).toBe(false);
      expect(isValidDisplayLabel(`Label${ch}`)).toBe(false);
      expect(isValidDisplayLabel(`${ch}Label`)).toBe(false);
    }
  });

  test("the label characters that must keep working are not caught by that class", () => {
    // The C1 range sits just above Latin-1 punctuation, so an over-wide regex would
    // quietly break ordinary labels. These are the neighbours worth pinning.
    for (const label of ["DeepSeek V4 Flash", "Qwen3-Max", "Llama_3.1", "GLM 4.6 (free)",
                         "Café Model", "モデル", "Ω-preview", "model@v2", "a^b", "x~y"]) {
      expect(isValidDisplayLabel(label)).toBe(true);
    }
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
