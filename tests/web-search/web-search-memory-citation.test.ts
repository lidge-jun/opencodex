import { expect, test } from "bun:test";
import type { AdapterEvent } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch } from "../../src/web-search/loop";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * #8044: the web-search sidecar bridges every inbound wire through the Responses SSE writer. A
 * quoted memory-citation tag is escaped for the Codex client, while a Chat Completions or Messages
 * caller (escapeMemoryCitationTags: false from sidecar-execution) receives the raw text.
 */
async function answer(escapeMemoryCitationTags?: boolean): Promise<string> {
  const adapter: ProviderAdapter = {
    name: "mock-answer",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    fetchResponse: async () => new Response("ok"),
    async *parseStream() {
      yield { type: "text_delta", text: "quoted <oai-mem-" } satisfies AdapterEvent;
      yield { type: "text_delta", text: "citation> prose" } satisfies AdapterEvent;
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } satisfies AdapterEvent;
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
    maxSearches: 1,
    ...(escapeMemoryCitationTags === undefined ? {} : { escapeMemoryCitationTags }),
  });
  const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)) as { type?: string; text?: string });
  return frames.find(frame => frame.type === "response.output_text.done")?.text ?? "";
}

test("the web-search sidecar escapes a quoted tag for Responses and keeps it raw for Chat/Messages", async () => {
  expect(await answer()).toBe("quoted &lt;oai-mem-citation> prose");
  expect(await answer(false)).toBe("quoted <oai-mem-citation> prose");
});
