import { afterEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { PROVIDER_INPUT_TOO_LARGE_MESSAGE } from "../../src/server/responses/context-overflow";

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

// #7316: once the turn is streaming, a later iteration's provider overflow must still end as the
// main path's terminal context_length_exceeded rather than a generic upstream failure.
for (const [label, second] of [
  ["an HTTP 413", { response: () => new Response("Request body exceeds the 8 MiB limit", { status: 413 }), events: [] }],
  ["an adapter-classified overflow", {
    response: () => new Response("wire"),
    events: [{ type: "error", status: 400, code: "context_length_exceeded", message: "adapter overflow" }],
  }],
] as const) {
  test(`a later iteration's ${label} ends as a terminal context_length_exceeded`, async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
    const passes: AdapterEvent[][] = [[
      { type: "tool_call_start", id: "ws1", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
      { type: "tool_call_end" },
      { type: "done" },
    ], [...second.events]];
    let sends = 0;
    const adapter: ProviderAdapter = {
      name: "overflowing-iteration",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => (sends++ === 0 ? new Response("wire") : second.response()),
      async *parseStream() { yield* passes.shift()!; },
    };
    const parsed: OcxParsedRequest = {
      modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] },
    };
    const response = await runWithWebSearch({
      parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
      settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("response.failed");
    expect(text).toContain('"code":"context_length_exceeded"');
    expect(text).toContain(PROVIDER_INPUT_TOO_LARGE_MESSAGE);
    expect(sends).toBe(2);
  });
}
