import { describe, expect, test } from "bun:test";
import {
  hasModelPreset,
  markModelPresetDiverged,
  materializeModelPreset,
  modelPresetFor,
  MODEL_PRESETS,
} from "../src/providers/model-presets";
import type { OcxProviderConfig } from "../src/types";

describe("#2465 model presets", () => {
  test("rules match vendor snapshot suffixes, not just bare ids", () => {
    // The whole point of patterns over literal lists: a dated snapshot must not stale the
    // preset between releases.
    const ids = ["claude-opus-5", "claude-opus-5-20260814", "claude-3-opus-20240229"];
    const matched = materializeModelPreset("anthropic", ids);
    expect(matched).toContain("claude-opus-5");
    expect(matched).toContain("claude-opus-5-20260814");
    // A historical snapshot outside the rules stays out — that is the curation.
    expect(matched).not.toContain("claude-3-opus-20240229");
  });

  test("an aggregator preset narrows a large catalog to flagships", () => {
    const catalog = [
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
      "x-ai/grok-4.6",
      "meta-llama/llama-2-7b",
      "some-vendor/ancient-model-v1",
      "google/gemini-3.1-pro",
    ];
    const matched = materializeModelPreset("openrouter", catalog);
    expect(matched).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
      "x-ai/grok-4.6",
      "google/gemini-3.1-pro",
    ]);
  });

  test("input order is preserved and duplicates collapse", () => {
    // Order matters so the preview lists models the way the picker will.
    const matched = materializeModelPreset("anthropic", ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-5"]);
    expect(matched).toEqual(["claude-sonnet-5", "claude-opus-5"]);
  });

  test("a provider without a shipped preset matches nothing", () => {
    expect(hasModelPreset("groq")).toBe(false);
    expect(materializeModelPreset("groq", ["llama-3.3-70b"])).toEqual([]);
  });

  test("no rule uses a global or sticky flag", () => {
    // A /g or /y pattern carries lastIndex between .test() calls and would skip rows
    // non-deterministically depending on catalog order.
    for (const [provider, preset] of Object.entries(MODEL_PRESETS)) {
      for (const rule of preset.rules) {
        // Assert the FLAGS, not a label containing them — "anthropic-apikey" has a "y" in it.
        expect({ provider, flags: rule.pattern.flags }).toEqual({ provider, flags: "" });
      }
    }
  });

  test("every shipped preset carries a version", () => {
    for (const preset of Object.values(MODEL_PRESETS)) {
      expect(preset.version).toBeGreaterThan(0);
      expect(preset.rules.length).toBeGreaterThan(0);
    }
  });

  describe("divergence is detected at the write path", () => {
    test("an edit while in preset mode flips to custom and keeps the applied version", () => {
      const provider = {
        modelPreset: { mode: "preset" as const, appliedVersion: 1, appliedAt: "2026-08-26T00:00:00Z" },
      } as OcxProviderConfig;
      markModelPresetDiverged(provider);
      expect(provider.modelPreset?.mode).toBe("custom");
      // Retained so the GUI can still offer "a newer preset is available".
      expect(provider.modelPreset?.appliedVersion).toBe(1);
    });

    test("custom is terminal and all has nothing to flip", () => {
      const custom = { modelPreset: { mode: "custom" as const } } as OcxProviderConfig;
      markModelPresetDiverged(custom);
      expect(custom.modelPreset?.mode).toBe("custom");

      const none = {} as OcxProviderConfig;
      markModelPresetDiverged(none);
      // Absent marker means "all", exactly today's semantics — no marker is invented.
      expect(none.modelPreset).toBeUndefined();
    });
  });

  test("the anthropic OAuth and API-key rows share one curation", () => {
    // They expose the same vendor catalog; diverging them would curate the same models twice.
    expect(modelPresetFor("anthropic")?.rules.length).toBe(modelPresetFor("anthropic-apikey")?.rules.length);
  });
});
