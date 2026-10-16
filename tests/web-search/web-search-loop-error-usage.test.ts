import { afterEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// A pass that ends in an adapter error was billed; the request log must meter it, and the turn
// must still fail with the same error.
test("an errored iteration's usage reaches the request log beside the search pass", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const passes: AdapterEvent[][] = [
    [
      { type: "tool_call_start", id: "ws1", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 1000, outputTokens: 50 } },
    ],
    [{ type: "text_delta", text: "partial" }, { type: "error", message: "provider blew up", usage: { inputTokens: 1400, outputTokens: 30 } }],
  ];
  const adapter: ProviderAdapter = {
    name: "errored-iteration",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => new Response("wire"),
    async *parseStream() { yield* passes.shift()!; },
  };
  const parsed: OcxParsedRequest = {
    modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] },
  };
  const reported: unknown[] = [];
  const response = await runWithWebSearch({
    parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: usage => reported.push(usage),
  });
  const text = await response.text();
  expect(text).toContain("response.failed");
  expect(text).toContain("Provider stream error: provider blew up");
  expect(reported).toEqual([expect.objectContaining({ inputTokens: 2400, outputTokens: 80 })]);
});
