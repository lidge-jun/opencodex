import { describe, expect, test } from "bun:test";
import { normalizeXaiResponsesWebSearch } from "../../../src/adapters/xai-web-search";

const XAI_PROVIDER = { baseUrl: "https://api.x.ai/v1" };

function normalize(body: Record<string, unknown>): Record<string, unknown> {
  return normalizeXaiResponsesWebSearch(body, XAI_PROVIDER) as Record<string, unknown>;
}

describe("xAI Responses selectors after tool normalization", () => {
  test("a catalog emptied by normalization drops the selector that has nothing left to select", () => {
    // The cached-only declaration is omitted above rather than widened to live search, which
    // leaves the request selecting from a catalog it no longer has; xAI answers 400.
    const body = normalize({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{ type: "web_search", external_web_access: false }],
      tool_choice: "auto",
    });

    expect(Object.hasOwn(body, "tools")).toBe(false);
    expect(Object.hasOwn(body, "tool_choice")).toBe(false);
  });

  test("an explicitly empty catalog carries no selector either", () => {
    for (const choice of ["auto", "none"]) {
      const body = normalize({ model: "grok-4.6", input: "hi", tools: [], tool_choice: choice });
      expect(Object.hasOwn(body, "tool_choice")).toBe(false);
    }
  });

  test("a selector that still has a tool to select is left alone", () => {
    const body = normalize({
      model: "grok-4.6",
      input: "hi",
      tools: [{ type: "function", name: "read_file" }],
      tool_choice: "auto",
    });

    expect(body.tool_choice).toBe("auto");
  });

  test("a forced function selector survives an empty catalog as a client input error", () => {
    // Dropping it would silently turn "call this tool" into "answer however you like"; the
    // request-build path answers a selector this proxy cannot honor with a 400 instead.
    const body = normalize({
      model: "grok-4.6",
      input: "hi",
      tools: [],
      tool_choice: { type: "function", name: "read_file" },
    });

    expect(body.tool_choice).toEqual({ type: "function", name: "read_file" });
  });
});
