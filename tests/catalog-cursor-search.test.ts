import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, normalizeRoutedCatalogEntry } from "../src/codex/catalog";

describe("routed catalog search advertising", () => {
  test("cursor entries enable deferred discovery without advertising hosted web search", () => {
    const entry = normalizeRoutedCatalogEntry({
      slug: "cursor/auto",
      web_search_tool_type: "text_and_image",
    } as never) as Record<string, unknown>;
    expect(entry.tool_mode).toBe("code_mode_only");
    expect(entry.supports_search_tool).toBe(true);
    expect(entry.web_search_tool_type).toBeUndefined();
    expect(entry.supports_parallel_tool_calls).toBe(true);
  });

  test("non-cursor routed entries advertise deferred discovery alongside hosted web search", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "opencode-go/glm-5.2" } as never) as Record<string, unknown>;
    expect(entry.supports_search_tool).toBe(true);
    expect(entry.web_search_tool_type).toBe("text_and_image");
    expect(entry.supports_parallel_tool_calls).toBe(false);
  });

  // Pair fence: code_mode_only + supports_search_tool=true must move together. Deferral is only
  // safe BECAUSE code mode keeps deferred MCP callable via exec/ALL_TOOLS (live canary 2026-08-13),
  // and search=false under code mode inflates exec.description 17K → 176K chars — a measured 2.7x
  // turn-1 payload regression (devlog/_plan/260813_tool_catalog_deferral/010). Neither field may
  // regress independently.
  test("non-cursor routed entries pin the code-mode + deferred-discovery pair (template path)", () => {
    const entry = normalizeRoutedCatalogEntry({ slug: "opencode-go/glm-5.2" } as never) as Record<string, unknown>;
    expect(entry.tool_mode).toBe("code_mode_only");
    expect(entry.supports_search_tool).toBe(true);
  });

  test("template-less fallback rows pin the same pair (deriveEntry path)", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "local", id: "qwen3-coder" },
    ]) as Array<Record<string, unknown>>;
    const routed = entries.find(e => e.slug === "local/qwen3-coder");
    expect(routed?.tool_mode).toBe("code_mode_only");
    expect(routed?.supports_search_tool).toBe(true);
    expect(routed?.web_search_tool_type).toBe("text_and_image");
  });

  test("cursor template-less fallback rows keep deferred discovery without hosted search", () => {
    const entries = buildCatalogEntries(null, [], [
      { provider: "cursor", id: "auto" },
    ]) as Array<Record<string, unknown>>;
    const routed = entries.find(e => typeof e.slug === "string" && (e.slug as string).startsWith("cursor/"));
    expect(routed).toBeDefined();
    expect(routed?.tool_mode).toBe("code_mode_only");
    expect(routed?.supports_search_tool).toBe(true);
    expect(routed?.web_search_tool_type).toBeUndefined();
  });
});
