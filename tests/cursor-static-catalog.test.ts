import { afterEach, describe, expect, test } from "bun:test";
import { buildCatalogEntries, gatherRoutedModels } from "../src/codex/catalog";
import {
  CURSOR_STATIC_MODELS,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../src/adapters/cursor/discovery";
import { cursorModelHasEffortTiers } from "../src/adapters/cursor/effort-map";
import { clearModelCache } from "../src/codex/model-cache";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("cursor");
});

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    base_instructions: "You are Codex.",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
    ],
  };
}

describe("Cursor static Codex catalog", () => {
  test("reasoning metadata and explicit effort tiers agree bidirectionally", () => {
    for (const model of CURSOR_STATIC_MODELS) {
      expect(
        model.supportsReasoningEffort === true,
        `Cursor model ${model.id} metadata and effort-map must agree`,
      ).toBe(cursorModelHasEffortTiers(model.id));
    }
  });

  test("expanded Cursor static metadata reaches routed models and catalog without live fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    const models = await gatherRoutedModels({
      providers: {
        cursor: {
          baseUrl: "https://api2.cursor.sh",
          adapter: "cursor",
          liveModels: false,
          models: cursorModelIds(CURSOR_STATIC_MODELS),
          defaultModel: "auto",
          modelContextWindows: cursorModelContextWindows(CURSOR_STATIC_MODELS),
          modelInputModalities: cursorModelInputModalities(CURSOR_STATIC_MODELS),
          modelReasoningEfforts: cursorModelReasoningEfforts(CURSOR_STATIC_MODELS),
        },
      },
    });

    expect(fetchCalls).toBe(0);
    const namespaced = models.map(model => `${model.provider}/${model.id}`);
    expect(namespaced.length).toBe(cursorModelIds(CURSOR_STATIC_MODELS).length);
    expect(namespaced).toContain("cursor/claude-sonnet-5");
    expect(namespaced).toContain("cursor/composer-2.5");
    expect(namespaced).toContain("cursor/gemini-2.5-flash");
    expect(namespaced).toContain("cursor/gemini-3-pro");
    expect(namespaced).toContain("cursor/gemini-3-pro-image-preview");
    expect(namespaced).toContain("cursor/gemini-3.5-flash");
    expect(namespaced).toContain("cursor/gpt-5-codex");
    expect(namespaced).toContain("cursor/gpt-5.6-sol");
    expect(namespaced).toContain("cursor/gpt-5.6-terra");
    expect(namespaced).toContain("cursor/gpt-5.6-luna");
    expect(namespaced).toContain("cursor/glm-5.2");
    expect(namespaced).toContain("cursor/kimi-k2.7-code");
    expect(namespaced).not.toContain("cursor/grok-4.20");
    expect(namespaced).not.toContain("cursor/grok-4.3");

    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    expect(entries.find(item => item.slug === "cursor/claude-sonnet-5")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/composer-2.5")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/composer-2.5-fast")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/gemini-2.5-flash")?.context_window).toBe(1_048_576);
    expect(entries.find(item => item.slug === "cursor/gemini-3-pro")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/gemini-3-pro-image-preview")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/gemini-3-pro")?.context_window).toBe(1_048_576);
    expect(entries.find(item => item.slug === "cursor/gemini-3.5-flash")?.context_window).toBe(200_000);
    expect(entries.find(item => item.slug === "cursor/gpt-5-codex")?.context_window).toBe(272_000);
    expect(entries.find(item => item.slug === "cursor/gpt-5.6-sol")?.context_window).toBe(1_000_000);
    expect(entries.find(item => item.slug === "cursor/gpt-5.6-terra")?.context_window).toBe(1_000_000);
    expect(entries.find(item => item.slug === "cursor/gpt-5.6-luna")?.context_window).toBe(1_000_000);
    expect(entries.find(item => item.slug === "cursor/glm-5.2")?.context_window).toBe(1_000_000);
    expect(entries.find(item => item.slug === "cursor/composer-2.5-fast")?.context_window).toBe(200_000);
    expect(entries.find(item => item.slug === "cursor/gpt-5.5")?.supported_reasoning_levels)
      .toMatchObject([{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "max" }, { effort: "ultra" }]);
    expect(entries.find(item => item.slug === "cursor/gpt-5.6-sol")?.supported_reasoning_levels)
      .toMatchObject([{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }]);
    expect(entries.find(item => item.slug === "cursor/claude-opus-4-8")?.supported_reasoning_levels)
      .toMatchObject([
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ]);
    expect(entries.find(item => item.slug === "cursor/glm-5.2")?.supported_reasoning_levels)
      .toMatchObject([{ effort: "high" }, { effort: "max" }, { effort: "ultra" }]);

    for (const modelId of ["auto", "composer-2.5", "gpt-5.5", "gemini-3-pro"]) {
      expect(
        entries.find(item => item.slug === `cursor/${modelId}`)?.input_modalities,
        `cursor/${modelId} should advertise image input`,
      ).toEqual(["text", "image"]);
    }
  });
});

describe("Opus Fast catalog families (devlog 300, live-verified 260822)", () => {
  // Umbrella merge (devlog 260828): the -fast rows folded into their bases.
  // The alias path still resolves them with the exact live-verified ladders.
  test("fast rows folded into bases; aliases keep resolving with tier semantics", async () => {
    const { CURSOR_STATIC_MODELS } = await import("../src/adapters/cursor/discovery");
    const { resolveCursorSelection } = await import("../src/adapters/cursor/catalog");
    for (const id of ["claude-opus-4-7-fast", "claude-opus-4-8-fast", "claude-opus-5-fast"]) {
      expect(CURSOR_STATIC_MODELS.some(model => model.id === id)).toBe(false);
      // Alias never sends a bare -fast id (not_found on the wire).
      expect(resolveCursorSelection(id, undefined).wireId.endsWith("-fast")).toBe(true);
      expect(resolveCursorSelection(id, undefined).wireId).not.toBe(id);
    }
  });

  test("tier ladders match the 260822 GetUsableModels dump", async () => {
    const { cursorModelEffortLadder } = await import("../src/adapters/cursor/effort-map");
    expect(cursorModelEffortLadder("claude-opus-4-7-fast")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cursorModelEffortLadder("claude-opus-4-8-fast")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cursorModelEffortLadder("claude-opus-5-fast")).toEqual(["low", "medium", "high"]);
  });

  test("wire-id derivation produces the live-verified suffixed forms and never a bare -fast id", async () => {
    const { cursorWireModelIdWithEffort, cursorEffortSuffix } = await import("../src/adapters/cursor/effort-map");
    expect(cursorWireModelIdWithEffort("claude-opus-4-8-fast", "high")).toBe("claude-opus-4-8-high-fast");
    expect(cursorWireModelIdWithEffort("claude-opus-5-fast", "medium")).toBe("claude-opus-5-medium-fast");
    expect(cursorWireModelIdWithEffort("claude-opus-4-7-fast", "max")).toBe("claude-opus-4-7-max-fast");
    // No-effort requests must still resolve to a suffix (bare id is not_found on the wire).
    for (const id of ["claude-opus-4-7-fast", "claude-opus-4-8-fast", "claude-opus-5-fast"]) {
      expect(cursorEffortSuffix(id, undefined), `${id} must never send bare`).toBeTruthy();
    }
    // Out-of-ladder effort clamps within the family ladder (opus-5-fast has no xhigh).
    expect(cursorEffortSuffix("claude-opus-5-fast", "xhigh")).toBe("high");
  });
});
