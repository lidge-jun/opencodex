import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../src/types";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Every routed-model iteration re-sends the full context, so the usage ledger (onUsage) must get the
// sum of all of them. The client-facing terminal keeps the last iteration's usage: Codex and Claude
// Code size the context window from it, and a sum would trigger early auto-compaction.
const usage = (input: number, output: number, extra: Partial<OcxUsage> = {}): OcxUsage =>
  ({ inputTokens: input, outputTokens: output, totalTokens: input + output, ...extra });
const search = (id: string, u: OcxUsage): AdapterEvent[] => [
  { type: "tool_call_start", id, name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query: id }) },
  { type: "tool_call_end" }, { type: "done", usage: u },
];
const answer = (u: OcxUsage): AdapterEvent[] => [{ type: "text_delta", text: "answer" }, { type: "done", usage: u }];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function drive(passes: AdapterEvent[][], refuseFrom = Infinity) {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const reported: (OcxUsage | undefined)[] = [];
  let events: AdapterEvent[] = [];
  let iteration = 0;
  const adapter: ProviderAdapter = {
    name: "fixture",
    buildRequest() {
      events = passes[iteration++]!;
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async () => iteration > refuseFrom ? new Response("refused", { status: 500 }) : new Response("wire"),
    async *parseStream() { yield* events; },
  };
  const parsed: OcxParsedRequest = {
    modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [buildWebSearchTool()] },
  };
  const response = await runWithWebSearch({
    parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: u => reported.push(u),
  });
  const text = await response.text();
  const terminal = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .find(frame => frame.type === "response.completed" || frame.type === "response.failed");
  return { reported, text, clientUsage: terminal?.response?.usage };
}

describe("web-search loop iteration usage", () => {
  test("search passes are added to the final answer's usage", async () => {
    const { reported, text, clientUsage } = await drive([
      search("first", usage(1000, 50, { cachedInputTokens: 0, cacheCreationInputTokens: 900, contextTotalTokens: 1050 })),
      answer(usage(1400, 80, { cachedInputTokens: 900, cacheReadInputTokens: 900, contextTotalTokens: 1480 })),
    ]);
    expect(text).toContain("response.completed");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      inputTokens: 2400, outputTokens: 130, totalTokens: 2530,
      cachedInputTokens: 900, cacheReadInputTokens: 900, cacheCreationInputTokens: 900,
      // An absolute context checkpoint is the last iteration's, never a sum.
      contextTotalTokens: 1480,
    });
    // Client wire derives input from the last checkpoint: 1480 - 80.
    expect(clientUsage).toMatchObject({ input_tokens: 1400, output_tokens: 80, total_tokens: 1480 });
  });

  test("the empty forced answer that was retried is counted too", async () => {
    const { reported, text, clientUsage } = await drive([
      search("first", usage(1000, 50)),
      [{ type: "done", usage: usage(1400, 5) }],
      answer(usage(1500, 80)),
    ]);
    expect(text).toContain("response.completed");
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 3900, outputTokens: 135, totalTokens: 4035 })]);
    expect(clientUsage).toMatchObject({ input_tokens: 1500, output_tokens: 80, total_tokens: 1580 });
  });

  test("an in-stream failure after a search still reports the iterations already sent", async () => {
    const { reported, text, clientUsage } = await drive([search("first", usage(1000, 50)), answer(usage(1, 1))], 1);
    expect(text).toContain("response.failed");
    expect(clientUsage).toBeFalsy();
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 50 })]);
  });

  test("a translator-budget failure after a search still reports the iterations already sent", async () => {
    const { reported, text } = await drive([
      search("first", usage(1000, 50)),
      [{ type: "error", status: 502, code: "translation_buffer_limit", message: "over budget" }],
    ]);
    expect(text).toContain("translation_buffer_limit");
    expect(reported).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 50 })]);
  });

  test("an earlier iteration's checkpoint and raw usage never stand in for the final terminal's", async () => {
    const { reported } = await drive([
      search("first", usage(1000, 50, { contextTotalTokens: 1050, rawUsage: { iteration: 1 } })),
      answer(usage(1400, 80)),
    ]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ inputTokens: 2400, outputTokens: 130 });
    expect(reported[0]?.contextTotalTokens).toBeUndefined();
    expect(reported[0]?.rawUsage).toBeUndefined();
  });
});
