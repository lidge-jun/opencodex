import { describe, expect, test } from "bun:test";

import {
  applyOperatorDisplayLabels,
  isValidDisplayLabel,
  MAX_DISPLAY_LABEL_LENGTH,
  resolveModelDisplayLabel,
} from "../src/codex/catalog/display-labels";
import { COMBO_NAMESPACE } from "../src/combos/types";
import type { CatalogModel } from "../src/codex/catalog/parsing";
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
