import { afterEach, describe, expect, test } from "bun:test";
import { buildCatalogEntries, gatherRoutedModels } from "../src/codex-catalog";
import {
  CURSOR_STATIC_MODELS,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
} from "../src/adapters/cursor/discovery";
import { clearModelCache } from "../src/model-cache";

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
    expect(namespaced).toContain("cursor/composer-2.5");
    expect(namespaced).toContain("cursor/gemini-3-pro");
    expect(namespaced).toContain("cursor/gemini-3.5-flash");
    expect(namespaced).toContain("cursor/grok-4.3");

    const entries = buildCatalogEntries(nativeTemplate(), [], models);
    expect(entries.find(item => item.slug === "cursor/composer-2.5")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/gemini-3-pro")).toBeTruthy();
    expect(entries.find(item => item.slug === "cursor/gemini-3.5-flash")?.context_window).toBe(1_000_000);
    expect(entries.find(item => item.slug === "cursor/grok-4.3")?.supported_reasoning_levels)
      .toMatchObject([{ effort: "low" }, { effort: "medium" }, { effort: "high" }]);
  });
});
