import { afterEach, expect, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../src/types";
import { runWithWebSearch } from "../../src/web-search/loop";
import { createAdvisorSidecarStep } from "../../src/server/responses/advisor-slot";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const usage = (n: number): OcxUsage => ({ inputTokens: n, outputTokens: 1, totalTokens: n + 1 });
const call = (name: string, id: string, incomplete = false): AdapterEvent[] => [
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", arguments: JSON.stringify(name === "advisor" ? { question: id } : { query: id }) },
  { type: "tool_call_end", ...(incomplete ? { incomplete: true } : {}) },
];
const answer: AdapterEvent[] = [{ type: "text_delta", text: "Final answer" }, { type: "done", usage: usage(30) }];

async function drive(passes: AdapterEvent[][], maxSearches = 1) {
  const consultations: string[] = [];
  const searches: string[] = [];
  const requests: OcxParsedRequest[] = [];
  const reported: (OcxUsage | undefined)[] = [];
  const advisor = createAdvisorSidecarStep({
    consult: async (_parsed, _reason, question) => {
      consultations.push(question!);
      return { ok: true, isError: false, content: `advice for ${question}` };
    },
    formatUnavailable: () => "Advisor unavailable: request limit",
  });
  globalThis.fetch = (async (_url, init) => {
    searches.push(String(init?.body));
    return Response.json({ results: [] });
  }) as typeof fetch;
  let events: AdapterEvent[] = [];
  const adapter: ProviderAdapter = {
    name: "fixture",
    buildRequest(parsed) {
      requests.push(structuredClone(parsed));
      events = passes[Math.min(requests.length - 1, passes.length - 1)]!;
      return { url: "https://worker.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async () => new Response("fixture"),
    async *parseStream() { yield* events; },
  };
  const response = await runWithWebSearch({
    parsed: { modelId: "fixture", stream: true, options: {}, context: {
      messages: [], tools: [
        { name: "web_search", description: "Search", parameters: {} },
        { name: "advisor", description: "Advisor", parameters: {}, advisor: true },
        { name: "write", description: "Write", parameters: {} },
      ],
    } },
    adapter, advisor, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    onUsage: value => reported.push(value),
  });
  const text = await response.text();
  const frames = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const terminal = frames.find(frame => frame.type === "response.completed" || frame.type === "response.failed");
  return { consultations, searches, requests, reported, text, terminal };
}

test("Advisor limit reports every billed worker leg once", async () => {
  const result = await drive(Array.from({ length: 5 }, (_, i) => [
    ...call("advisor", `advisor-${i}`), { type: "done", usage: usage(10) },
  ]));
  expect(result.consultations).toHaveLength(3);
  expect(result.requests).toHaveLength(5);
  expect(result.text).toContain("advisor_continuation_limit");
  expect(result.text).not.toContain("advisor-0");
  expect(result.reported).toEqual([expect.objectContaining({ inputTokens: 50, outputTokens: 5, totalTokens: 55 })]);
  expect(result.requests[3]!.context.tools!.some(tool => tool.advisor)).toBe(false);
});

test("Advisor and search preserve separate allowances and worker usage", async () => {
  const result = await drive([
    [...call("advisor", "private-question-1"), { type: "done", usage: usage(10) }],
    [...call("web_search", "search-1"), { type: "done", usage: usage(20) }],
    [...call("advisor", "private-question-2"), { type: "done", usage: usage(25) }],
    answer,
  ]);
  expect(result.consultations).toEqual(["private-question-1", "private-question-2"]);
  expect(result.searches).toHaveLength(1);
  expect(result.requests).toHaveLength(4);
  expect(result.text).not.toContain("private-question");
  expect(result.text).toContain("Final answer");
  expect(result.reported).toEqual([expect.objectContaining({ inputTokens: 85, outputTokens: 4 })]);
  expect(result.terminal.response.usage).toMatchObject({ input_tokens: 30, output_tokens: 1 });
});

test.each([true, false])("real client tools take precedence in either order (advisor first=%s)", async first => {
  const advisor = call("advisor", "private-call");
  const real = call("write", "client-call");
  const result = await drive([[...(first ? [...advisor, ...real] : [...real, ...advisor]), { type: "done", usage: usage(10) }]]);
  expect(result.consultations).toHaveLength(0);
  expect(result.searches).toHaveLength(0);
  expect(result.requests).toHaveLength(1);
  expect(result.text).toContain("client-call");
  expect(result.text).not.toContain("private-call");
});

test("incomplete Advisor calls suppress consultation and search execution", async () => {
  const result = await drive([[
    ...call("web_search", "search-1"), ...call("advisor", "private-incomplete", true),
    { type: "done", stopReason: "max_tokens", usage: usage(10) },
  ]]);
  expect(result.consultations).toHaveLength(0);
  expect(result.searches).toHaveLength(0);
  expect(result.requests).toHaveLength(1);
  expect(result.text).not.toContain("private-incomplete");
  expect(result.reported).toEqual([expect.objectContaining({ inputTokens: 10, outputTokens: 1 })]);
});
