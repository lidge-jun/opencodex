import { describe, expect, test } from "bun:test";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { XAI_MODELS } from "../../../src/providers/registry/model-seeds";
import type { ProviderRegistryEntry } from "../../../src/providers/registry/types";

// xAI documents Grok 4.7 Fast as "the same model served on faster infrastructure", listed for
// Cursor and Grok Build and not available on the public xAI API
// (docs.x.ai/developers/grok-4-7, fetched 2026-09-24). The discovered OAuth id inherits
// grok-4.7's documented facts; its wire pin and service tier stay unclaimed until probed.
const BASE = "grok-4.7";
const BUILD_FAST = "grok-4.7-build-fast";

function xai(): ProviderRegistryEntry {
  const entry = getProviderRegistryEntry("xai");
  if (!entry) throw new Error("xai registry entry missing");
  return entry;
}

// Each assertion reads the base value from the registry instead of restating it: a later
// grok-4.7 correction has to move the Fast row with it, and a restated literal would hide that.
const MAPS = [
  ["modelContextWindows", (entry: ProviderRegistryEntry) => entry.modelContextWindows],
  ["modelReasoningEfforts", (entry: ProviderRegistryEntry) => entry.modelReasoningEfforts],
  ["modelDefaultReasoningEfforts", (entry: ProviderRegistryEntry) => entry.modelDefaultReasoningEfforts],
  ["modelInputModalities", (entry: ProviderRegistryEntry) => entry.modelInputModalities],
] as const;

const LISTS = ["noStopModels", "noPenaltyModels", "preserveReasoningContentModels"] as const;

describe("xai grok-4.7-build-fast metadata", () => {
  for (const [field, read] of MAPS) {
    test(`${field} carries the grok-4.7 value`, () => {
      const map = read(xai());
      expect(map?.[BASE]).toBeDefined();
      expect(map?.[BUILD_FAST]).toEqual(map?.[BASE]);
    });
  }

  for (const field of LISTS) {
    test(`${field} seeds the id directly after grok-4.7`, () => {
      const list = xai()[field] ?? [];
      expect(list).toContain(BASE);
      expect(list.indexOf(BUILD_FAST)).toBe(list.indexOf(BASE) + 1);
    });
  }

  test("claims no lineup slot, wire pin or service tier", () => {
    const entry = xai();
    // Live discovery owns the lineup, so the seed lists stay free of a Cursor/Grok-Build-only id.
    expect(XAI_MODELS).toContain(BASE);
    expect(XAI_MODELS).not.toContain(BUILD_FAST);
    expect(entry.models ?? []).not.toContain(BUILD_FAST);
    // Non-vacuous negatives: both claims exist for grok-4.7, and only there.
    expect(entry.modelWireDefaults?.[BASE]).toBeDefined();
    expect(entry.modelWireDefaults?.[BUILD_FAST]).toBeUndefined();
    expect(entry.modelSupportsServiceTier?.[BASE]).toBe(true);
    expect(entry.modelSupportsServiceTier?.[BUILD_FAST]).toBeUndefined();
  });
});
