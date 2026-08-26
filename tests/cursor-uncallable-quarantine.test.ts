import { describe, expect, test } from "bun:test";
import {
  CURSOR_KNOWN_UNCALLABLE_MODEL_IDS,
  CURSOR_STATIC_MODELS,
  filterCursorConfiguredModelsByLiveDiscovery,
} from "../src/adapters/cursor/discovery";

describe("cursor uncallable-model quarantine (devlog 260826 060)", () => {
  test("static seed no longer carries bare claude-opus-5", () => {
    expect(CURSOR_STATIC_MODELS.some(model => model.id === "claude-opus-5")).toBe(false);
  });

  test("siblings from other wire families survive", () => {
    expect(CURSOR_STATIC_MODELS.some(model => model.id === "claude-opus-5-fast")).toBe(true);
  });

  test("live filter drops quarantined ids even when GetUsableModels lists them", () => {
    const configured = [{ id: "claude-opus-5" }, { id: "claude-opus-5-fast" }, { id: "grok-4.6" }];
    const live = ["claude-opus-5-high", "claude-opus-5-high-fast", "grok-4.6-high"];
    const filtered = filterCursorConfiguredModelsByLiveDiscovery(configured, live);
    expect(filtered.map(model => model.id)).toEqual(["claude-opus-5-fast", "grok-4.6"]);
  });

  test("quarantine applies with an empty live list too (stale/static degradation path)", () => {
    const configured = [{ id: "claude-opus-5" }, { id: "auto" }];
    const filtered = filterCursorConfiguredModelsByLiveDiscovery(configured, []);
    expect(filtered.some(model => model.id === "claude-opus-5")).toBe(false);
  });

  test("quarantine set stays narrow", () => {
    expect([...CURSOR_KNOWN_UNCALLABLE_MODEL_IDS]).toEqual(["claude-opus-5"]);
  });
});
