import { afterEach, expect, test } from "bun:test";
import type { AdapterEvent } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * #7148: a refusal that ends an iteration carrying a complete web_search call must end the turn.
 * Running the search and re-asking would send the refused context back to the model, the same
 * re-send the Responses bridge's terminal `response.failed` exists to prevent.
 */
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.each([true, false, undefined])("a refused web_search iteration stops with terminalRefusalAsFailed=%s", async terminalRefusalAsFailed => {
  let searchFetches = 0;
  globalThis.fetch = (async () => {
    searchFetches++;
    return Response.json({ results: [{ title: "Fixture", url: "https://example.test/r", content: "result" }] });
  }) as typeof fetch;
  let routedSends = 0;
  const adapter: ProviderAdapter = {
    name: "mock-refusal",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => { routedSends++; return new Response("ok", { status: 200 }); },
    async *parseStream() {
      yield { type: "tool_call_start", id: "search-1", name: "web_search" } satisfies AdapterEvent;
      yield { type: "tool_call_delta", arguments: JSON.stringify({ query: "fixture query" }) } satisfies AdapterEvent;
      yield { type: "tool_call_end" } satisfies AdapterEvent;
      yield {
        type: "incomplete", reason: "content_filter", retryable: false,
        message: 'upstream ended the turn with stop_reason "refusal"',
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      } satisfies AdapterEvent;
    },
    async parseResponse() { throw new Error("parseResponse must be unreachable"); },
  };

  const response = await runWithWebSearch({
    parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
    adapter,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    backend: "exa",
    exaApiKey: "synthetic-exa-key",
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers(),
    settings: { model: "exa-fixture-model", reasoning: "low", timeoutMs: 30_000 },
    maxSearches: 2,
    terminalRefusalAsFailed,
  });
  const text = await response.text();

  expect(routedSends).toBe(1);
  expect(searchFetches).toBe(0);
  expect(text).toContain(`event: response.${terminalRefusalAsFailed ? "failed" : "incomplete"}`);
  if (terminalRefusalAsFailed) expect(text).toContain('"code":"invalid_prompt"');
  else expect(text).toContain('"reason":"content_filter"');
  expect(text).not.toContain("event: response.completed");
});
