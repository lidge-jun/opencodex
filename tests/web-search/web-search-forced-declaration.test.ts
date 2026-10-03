import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import type { SidecarPlan } from "../../src/web-search";
import { runWithWebSearch } from "../../src/web-search/loop";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const done: AdapterEvent = { type: "done" };
const answer: AdapterEvent[] = [{ type: "text_delta", text: "answer" }, done];
const search = (id: string): AdapterEvent[] => [
  { type: "tool_call_start", id, name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query: id }) },
  { type: "tool_call_end" }, done,
];
const plan: SidecarPlan = {
  backend: "exa", hostedTool: { type: "web_search" }, maxSearches: 1,
  settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 },
  routedModelStallTimeoutMs: 1000, stallTimeoutSec: 2, streamRoutedModelOutput: false,
};
const parsed: OcxParsedRequest = {
  modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [
    { name: "shell", description: "fixture", parameters: { type: "object", properties: {} } },
  ] },
};
async function* stream(events: AdapterEvent[]) { yield* events; }
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const transport of ["runTurn", "fetch"] as const) {
  describe(`${transport} forced search declaration`, () => {
    async function drive(passes: AdapterEvent[][], controller?: AbortController, failAfterSearch = false) {
      const seen: OcxParsedRequest[] = [];
      const providerSends: number[] = [];
      const output: AdapterEvent[] = [];
      let iteration = 0;
      const next = (request: OcxParsedRequest) => {
        seen.push(structuredClone(request));
        if (controller && seen.length === 2) controller.abort();
        return passes[Math.min(iteration++, passes.length - 1)]!;
      };
      if (transport === "runTurn") {
        seen.push(structuredClone(parsed));
        iteration++;
        for await (const event of runTurnWebSearchLoop(stream(passes[0]!), {
          parsed, plan, exaApiKey: "fixture", abortSignal: controller?.signal,
          dispatch: request => stream(next(request)),
        })) output.push(event);
        return { seen, providerSends, failed: output.some(e => e.type === "error"), output, text: JSON.stringify(output) };
      }
      let events: AdapterEvent[] = [];
      const adapter: ProviderAdapter = {
        name: "fixture",
        buildRequest(request) {
          events = next(request);
          return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
        },
        fetchResponse: async () => {
          providerSends.push(seen.length);
          return failAfterSearch && seen.length > 1
            ? new Response("refused", { status: 429 }) : new Response("wire");
        },
        async *parseStream() { yield* events; },
      };
      const response = await runWithWebSearch({
        parsed: { ...parsed, context: { ...parsed.context, tools: [...parsed.context.tools!, buildWebSearchTool()] } },
        adapter, backend: "exa", exaApiKey: "fixture", hostedTool: plan.hostedTool,
        settings: plan.settings, maxSearches: 1, abortSignal: controller?.signal,
        incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      });
      const text = await response.text();
      return { seen, providerSends, failed: text.includes('"type":"response.failed"'), output, text };
    }

    test("over-budget calls retain the declaration and receive paired limit results without another search", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
      const result = await drive([search("first"), search("over-budget"), answer]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(3);
      for (const request of result.seen.slice(1)) expect(request.context.tools?.some(t => t.webSearch)).toBe(true);
      expect(result.seen[2]!.context.messages).toContainEqual(expect.objectContaining({
        role: "toolResult", toolCallId: "over-budget", isError: true,
        content: expect.stringContaining("web search limit reached for this turn"),
      }));
      expect(result.failed).toBe(false);
      expect(result.text).toContain("answer");
    });

    test("repeated over-budget calls fail at the iteration ceiling", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ results: [] }));
      const result = await drive([search("first"), search("again")]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(plan.maxSearches + 3);
      expect(result.failed).toBe(true);
      expect(result.text).toContain("iteration cap");
    });

    test("ordinary caller tools remain terminal after search commitment", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
      const shell: AdapterEvent[] = [{ type: "tool_call_start", id: "shell-1", name: "shell" },
        { type: "tool_call_delta", arguments: "{}" }, { type: "tool_call_end" }, done];
      const result = await drive([search("first"), shell]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(2);
      expect(result.failed).toBe(false);
      expect(result.text).toContain("shell");
    });

    test("an empty answer at the ceiling cannot dispatch an unused recovery", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
      const result = await drive([search("first"), search("second"), search("third"), [done]]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(plan.maxSearches + 3);
      expect(result.failed).toBe(true);
      expect(result.text).toContain("iteration cap");
    });

    test("empty-answer recovery can use the last remaining iteration", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
      const result = await drive([search("first"), search("second"), [done], answer]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(plan.maxSearches + 3);
      expect(result.seen.at(-1)!.context.tools).toEqual([]);
      expect(result.seen.at(-1)!.context.messages).toContainEqual(expect.objectContaining({
        role: "toolResult", toolCallId: "second", isError: true,
        content: expect.stringContaining("web search limit reached for this turn"),
      }));
      expect(result.failed).toBe(false);
      expect(result.text).toContain("answer");
    });

    test("cancellation prevents another forced-pass dispatch or physical search", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
      const result = await drive([search("first"), search("again")], new AbortController());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(2);
      expect(result.failed).toBe(true);
    });

    if (transport === "fetch") test("post-search refusal without retry opt-in does not resend committed work", async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
      const result = await drive([search("first"), answer], undefined, true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.seen).toHaveLength(2);
      expect(result.providerSends).toEqual([1, 2]);
      expect(result.failed).toBe(true);
    });
  });
}
