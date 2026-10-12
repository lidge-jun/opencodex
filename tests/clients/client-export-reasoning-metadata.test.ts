import { describe, expect, test } from "bun:test";
import { exportDefaultReasoningEffort, exportReasoningEfforts } from "../../src/clients/config-export/reasoning-metadata";
import { inputBudgetFor } from "../../src/clients/config-export/model-metadata";
import type { OpencodeCatalogModel } from "../../src/clients/config-export";

const model: OpencodeCatalogModel = { namespaced: "mock/model" };

describe("client export reasoning metadata", () => {
  test("unknown ladders remain unknown and explicit empty ladders remain empty", () => {
    expect(exportReasoningEfforts(model)).toBeUndefined();
    expect(exportReasoningEfforts({ ...model, reasoningEfforts: [] })).toEqual([]);
  });
  test("canonicalizes only supported values, including explicit off", () => {
    expect(exportReasoningEfforts({ ...model, reasoningEfforts: ["high", "none", "turbo", "low", "high", "minimal"] }))
      .toEqual(["none", "minimal", "low", "high"]);
  });
  test("does not synthesize a default or revive an explicitly cleared ladder", () => {
    expect(exportDefaultReasoningEffort({ ...model, reasoningEfforts: ["low", "high"] })).toBeUndefined();
    expect(exportDefaultReasoningEffort({ ...model, defaultReasoningEffort: "high", reasoningEfforts: [] })).toBeUndefined();
    expect(exportDefaultReasoningEffort({ ...model, defaultReasoningEffort: "medium", reasoningEfforts: ["high"] })).toBeUndefined();
    expect(exportDefaultReasoningEffort({ ...model, defaultReasoningEffort: "turbo" })).toBeUndefined();
  });
  test("carries known defaults including none without requiring a fabricated ladder", () => {
    expect(exportDefaultReasoningEffort({ ...model, defaultReasoningEffort: "high" })).toBe("high");
    expect(exportDefaultReasoningEffort({ ...model, defaultReasoningEffort: "none", reasoningEfforts: ["none", "high"] })).toBe("none");
  });
  test("input budgets are authoritative, finite integers and cannot exceed context", () => {
    expect(inputBudgetFor(10_000, model)).toBeUndefined();
    for (const maxInputTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(inputBudgetFor(10_000, { ...model, maxInputTokens })).toBeUndefined();
    }
    expect(inputBudgetFor(10_000, { ...model, maxInputTokens: 8_192.5 })).toBe(8_192);
    expect(inputBudgetFor(10_000, { ...model, maxInputTokens: 12_000 })).toBe(10_000);
  });
});
