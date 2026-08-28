import { describe, expect, test } from "bun:test";
import {
  CURSOR_KNOWN_UNCALLABLE_MODEL_IDS,
  CURSOR_STATIC_MODELS,
  filterCursorConfiguredModelsByLiveDiscovery,
} from "../src/adapters/cursor/discovery";

describe("cursor uncallable-model quarantine (devlog 260826 060)", () => {
  // Umbrella merge (devlog 260828): the base row RETURNED to the seed because
  // its umbrella defaults to the healthy THINKING variant; the quarantined
  // regular wire id is still never sent for the bare slug (resolver-level).
  test("static seed carries claude-opus-5 under its thinking umbrella", () => {
    expect(CURSOR_STATIC_MODELS.some(model => model.id === "claude-opus-5")).toBe(true);
  });

  test("fast siblings folded into the umbrella (no separate seed rows)", () => {
    expect(CURSOR_STATIC_MODELS.some(model => model.id === "claude-opus-5-fast")).toBe(false);
  });

  test("the quarantined REGULAR variant is never sent for the bare slug (resolver-level quarantine)", async () => {
    const { resolveCursorSelection, CURSOR_CAPABILITIES } = await import("../src/adapters/cursor/catalog");
    expect(CURSOR_CAPABILITIES["claude-opus-5"]!.variants.regular?.quarantined).toBe(true);
    // The bare slug routes the healthy thinking family, never claude-opus-5-<effort>.
    expect(resolveCursorSelection("claude-opus-5", "high").wireId).toBe("claude-opus-5-thinking-high");
  });

  test("row-level quarantine set is empty (mechanism retained for whole-base cases)", () => {
    expect([...CURSOR_KNOWN_UNCALLABLE_MODEL_IDS]).toEqual([]);
    // Live thinking wire ids prove the base under the umbrella matcher.
    const configured = [{ id: "claude-opus-5" }, { id: "auto" }];
    const filtered = filterCursorConfiguredModelsByLiveDiscovery(configured, ["claude-opus-5-thinking-high"]);
    expect(filtered.some(model => model.id === "claude-opus-5")).toBe(true);
  });
});
