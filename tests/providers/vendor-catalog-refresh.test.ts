import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";

// Vendor catalog refresh, 2026-11-26. Each block pins one provider family to the vendor page it
// was read from, so a later edit that drifts from the source has to change a cited assertion.

describe("Google Gemini API preset (ai.google.dev models, deprecations and pricing, 2026-11-26)", () => {
  const google = getProviderRegistryEntry("google")!;

  test("defaults to the replacement Google names for the retired 3.5 Flash endpoint", () => {
    // gemini-3.5-flash is no longer offered in AI Studio; its endpoint routes to gemini-3.6-flash.
    expect(google.defaultModel).toBe("gemini-3.6-flash");
  });

  test("seeds every GA Gemini 4 model and drops the two redirected Flash ids from the picker", () => {
    for (const id of ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon"]) {
      expect(google.models).toContain(id);
      expect(google.modelContextWindows?.[id]).toBe(1_048_576);
      expect(google.modelInputModalities?.[id]).toEqual(["text", "image"]);
      expect(google.modelReasoningEfforts?.[id]?.length).toBeGreaterThan(0);
    }
    expect(google.models).not.toContain("gemini-3.5-flash");
    expect(google.models).not.toContain("gemini-3.7-flash");
    // Saved selections of the redirected ids keep their metadata.
    expect(google.modelContextWindows?.["gemini-3.5-flash"]).toBeDefined();
    expect(google.modelContextWindows?.["gemini-3.7-flash"]).toBeDefined();
  });

  test("prices Gemini 4 Argon and Carbon at the durable list rate, not the introductory one", () => {
    const list = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
    for (const [provider, modelId] of [
      ["google", "gemini-4-argon"],
      ["google", "gemini-4-carbon"],
      ["google-antigravity", "gemini-4-argon"],
      ["google-antigravity", "gemini-4-argon-low"],
      ["google-antigravity", "gemini-4-argon-medium"],
      ["google-antigravity", "gemini-4-argon-high"],
    ] as const) {
      const row = findExpectedPriceOverlay(provider, modelId);
      expect(row?.cost4).toEqual(list);
      expect(row?.source).toContain("through 2026-11-30");
    }
  });
});
