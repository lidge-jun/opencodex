import { describe, expect, test } from "bun:test";
import { normalizeRoutedCatalogEntry } from "../src/codex/catalog";

describe("routed catalog search advertising", () => {
  test("cursor entries do not advertise the hosted search tool (runTurn bypasses the sidecar)", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "cursor/auto" } as never) as Record<string, unknown>;
    expect(entry.supports_search_tool).toBe(false);
    expect(entry.web_search_tool_type).toBeUndefined();
    expect(entry.supports_parallel_tool_calls).toBe(true);
  });

  test("non-cursor routed entries keep hosted web search without opting into deferred discovery", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "opencode-go/glm-5.2" } as never) as Record<string, unknown>;
    expect(entry.supports_search_tool).toBe(false);
    expect(entry.web_search_tool_type).toBe("text_and_image");
    expect(entry.supports_parallel_tool_calls).toBe(false);
  });
});
