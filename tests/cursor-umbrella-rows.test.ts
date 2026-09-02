import { describe, expect, test } from "bun:test";
import {
  cursorUmbrellaRows,
  liveCursorClaudeWireIdentitiesForTests,
  recordLiveCursorClaudeModels,
  recordLiveCursorMaxModeModels,
  resetLiveCursorClaudeWireIdentitiesForTests,
  resolveCursorSelection,
} from "../src/adapters/cursor/catalog";
import {
  CURSOR_PRODUCT_MODELS,
  CURSOR_REAL_ID_EXCEPTIONS,
  CURSOR_ROUTER_MODEL_IDS,
  CURSOR_STATIC_MODELS,
  cursorModelDisplayNames,
  cursorModelReasoningEfforts,
} from "../src/adapters/cursor/discovery";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import type { OcxParsedRequest } from "../src/types";

function parsedFor(modelId: string, reasoning?: string): OcxParsedRequest {
  return {
    modelId,
    context: { systemPrompt: [], messages: [{ role: "user", content: "hi" }] },
    options: reasoning ? { reasoning } : {},
  } as OcxParsedRequest;
}

describe("cursor umbrella picker rows (devlog 260828_cursor_umbrella_catalog)", () => {
  test("the seed collapsed: no thinking, no fast-duplicate, no -1m rows remain", () => {
    const ids = CURSOR_STATIC_MODELS.map(model => model.id);
    expect(ids.filter(id => id.includes("-thinking"))).toEqual([]);
    expect(ids).not.toContain("kimi-k3-1m");
    expect(ids).not.toContain("claude-opus-4-7-fast");
    expect(ids).not.toContain("claude-opus-4-8-fast");
    expect(ids).not.toContain("claude-opus-5-fast");
    expect(ids).not.toContain("grok-4.5-fast");
    expect(ids).not.toContain("grok-4.6-fast");
    expect(ids).not.toContain("claude-fable-5.1");
    expect(ids).not.toContain("claude-5.1-fable");
    expect(ids.filter(id => id === "claude-fable-5-1")).toHaveLength(1);
    // composer-2.5-fast has no umbrella base with effort dimensions; it stays.
    expect(ids).toContain("composer-2.5-fast");
  });

  test("the quarantined opus-5 base returns to the seed under its thinking umbrella", () => {
    expect(CURSOR_STATIC_MODELS.some(model => model.id === "claude-opus-5")).toBe(true);
  });

  test("the seed is composed of routers + umbrella bases + declared product ids", () => {
    // 4 routers + 32 umbrella bases + 13 product ids + 3 real-id exceptions.
    // Derived, not frozen: the hard-coded count drifted twice already (51 -> 54 when
    // #3211 pre-seeded Claude Fable 5.1 under three spellings), so the expectation now
    // comes from the same capability table the seed is built from.
    expect(CURSOR_STATIC_MODELS.length).toBe(
      CURSOR_ROUTER_MODEL_IDS.length
      + cursorUmbrellaRows().length
      + CURSOR_PRODUCT_MODELS.length
      + CURSOR_REAL_ID_EXCEPTIONS.length,
    );
  });

  test("every umbrella row is published, and no product id shadows a capability base", () => {
    const ids = CURSOR_STATIC_MODELS.map(model => model.id);
    for (const row of cursorUmbrellaRows()) expect(ids).toContain(row.id);
    // normalizeCursorModels dedupes silently, so a collision would drop a row unnoticed.
    expect(ids.length).toBe(new Set(ids).size);
    const capabilityIds = new Set(cursorUmbrellaRows().map(row => row.id));
    for (const product of [...CURSOR_PRODUCT_MODELS, ...CURSOR_REAL_ID_EXCEPTIONS]) {
      expect(capabilityIds.has(product.id)).toBe(false);
    }
  });

  test("seed windows are the capability windows, not a second opinion", () => {
    const seeded = new Map(CURSOR_STATIC_MODELS.map(model => [model.id, model.contextWindow]));
    for (const row of cursorUmbrellaRows()) expect(seeded.get(row.id)).toBe(row.window);
  });

  test("umbrella rows and seed efforts agree for every cataloged base", () => {
    const efforts = cursorModelReasoningEfforts();
    for (const row of cursorUmbrellaRows()) {
      const seeded = efforts[row.id];
      if (seeded === undefined) continue; // bases not in the static seed (yet)
      if (seeded.length === 0) continue;  // seed marks it non-effort
      expect({ id: row.id, efforts: seeded }).toEqual({ id: row.id, efforts: [...row.efforts] });
    }
  });

  describe("pinned-session survival: removed picker slugs still route byte-identically", () => {
    const removedSlugs: Array<[string, string | undefined, string]> = [
      ["cursor/claude-opus-5-thinking", "high", "claude-opus-5-thinking-high"],
      ["cursor/claude-opus-4-8-thinking-fast", "max", "claude-opus-4-8-thinking-max-fast"],
      ["cursor/claude-opus-4-7-fast", "high", "claude-opus-4-7-high-fast"],
      ["cursor/claude-4.6-sonnet-thinking", "high", "claude-4.6-sonnet-medium-thinking"],
      ["cursor/claude-4-sonnet-thinking", undefined, "claude-4-sonnet-thinking"],
      ["cursor/kimi-k3-1m", "max", "kimi-k3-max"],
    ];
    for (const [slug, effort, wire] of removedSlugs) {
      test(`${slug} still resolves to ${wire}`, () => {
        const request = createCursorRequest(parsedFor(slug, effort));
        expect(request.modelId).toBe(wire);
      });
    }

    test("removed grok fast slug keeps its parameterized wire shape", () => {
      const request = createCursorRequest(parsedFor("cursor/grok-4.6-fast", "high"));
      expect(request.modelId).toBe("grok-4.6");
      expect(request.requestedModelParameters).toEqual([
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ]);
    });

    test("kimi-k3-1m alias still arms Max Mode", () => {
      const request = createCursorRequest(parsedFor("cursor/kimi-k3-1m", "max"));
      expect(request.maxMode).toBe(true);
    });
  });

  describe("live Max-Mode evidence generalizes ultra", () => {
    test("recorded live maxModeModels arm ultra for their bases and reset cleanly", () => {
      recordLiveCursorMaxModeModels(["claude-opus-4-8-high-fast"]);
      try {
        expect(resolveCursorSelection("claude-opus-4-8", "ultra").maxMode).toBe(true);
        expect(resolveCursorSelection("claude-opus-4-7", "ultra").maxMode).toBe(false);
      } finally {
        recordLiveCursorMaxModeModels([]);
      }
      expect(resolveCursorSelection("claude-opus-4-8", "ultra").maxMode).toBe(false);
      // Static evidence survives the reset.
      expect(resolveCursorSelection("kimi-k3", "ultra").maxMode).toBe(true);
    });
  });

  describe("live Claude wire identity", () => {
    test("each successful roster replaces the spelling map atomically and reset clears it", () => {
      resetLiveCursorClaudeWireIdentitiesForTests();
      recordLiveCursorClaudeModels([
        "claude-5.1-fable-high-thinking",
        "claude-opus-5-thinking-high",
      ]);
      expect([...liveCursorClaudeWireIdentitiesForTests().entries()]).toEqual([
        ["claude-fable-5-1", { sourceBaseId: "claude-5.1-fable", spelling: "version-first" }],
        ["claude-opus-5", { sourceBaseId: "claude-opus-5", spelling: "anthropic" }],
      ]);

      recordLiveCursorClaudeModels(["claude-fable-5.1-thinking-xhigh"]);
      expect([...liveCursorClaudeWireIdentitiesForTests().entries()]).toEqual([
        ["claude-fable-5-1", { sourceBaseId: "claude-fable-5.1", spelling: "anthropic" }],
      ]);

      resetLiveCursorClaudeWireIdentitiesForTests();
      expect(liveCursorClaudeWireIdentitiesForTests().size).toBe(0);
    });
  });
});
