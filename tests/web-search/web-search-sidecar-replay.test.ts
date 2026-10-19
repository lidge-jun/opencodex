import { afterEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { clearBridgeSearchReplayCacheForTests } from "../../src/responses/bridge-search-replay-cache";
import { runWithWebSearch } from "../../src/web-search/loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// #7269: a routed model searched through the sidecar, then called a client tool, which ended the
// turn. Codex replays only the hosted cell (query, no result), and the parser used to drop it, so the
// model forgot the search and ran the same search and tool again in a loop.
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearBridgeSearchReplayCacheForTests(); });

const SHELL = { type: "function", name: "shell", parameters: { type: "object", properties: {} } };
const scope = (thread = "thread-a", principal = "principal-a") => ({ clientPrincipalId: principal, clientThreadId: thread });
const searchPass: AdapterEvent[] = [
  { type: "tool_call_start", id: "toolu_search", name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query: "munpia fantasy best 2026" }) },
  { type: "tool_call_end" }, { type: "done" },
];
const shellPass: AdapterEvent[] = [
  { type: "tool_call_start", id: "call_shell", name: "shell" },
  { type: "tool_call_delta", arguments: "{}" },
  { type: "tool_call_end" }, { type: "done" },
];
const answerPass: AdapterEvent[] = [{ type: "text_delta", text: "done" }, { type: "done" }];

async function turn(parsed: OcxParsedRequest, passes: AdapterEvent[][]) {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [
    { url: "https://novel.example.test/best", title: "Fantasy best list", text: "Rank one: The Archmage" },
  ] }));
  const seen: OcxMessage[][] = [];
  let events: AdapterEvent[] = [];
  let iteration = 0;
  const adapter: ProviderAdapter = {
    name: "fixture",
    buildRequest(iterParsed) {
      seen.push(structuredClone(iterParsed.context.messages));
      events = passes[iteration++]!;
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async () => new Response("wire"),
    async *parseStream() { yield* events; },
  };
  const response = await runWithWebSearch({
    parsed, adapter, backend: "exa", exaApiKey: "fixture", hostedTool: { type: "web_search" },
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 }, maxSearches: 2,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
  });
  const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  return { seen, frames };
}

function nextTurn(cell: Record<string, unknown>, tools: unknown[] = [{ type: "web_search" }, SHELL]) {
  return {
    model: "anthropic/claude-opus-5-5", stream: true, tools,
    input: [
      { role: "user", content: [{ type: "input_text", text: "search once, then record the URLs" }] },
      cell,
      { type: "function_call", call_id: "call_shell", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_shell", output: "written" },
    ],
  };
}

async function firstTurnCell(): Promise<Record<string, unknown>> {
  const parsed: OcxParsedRequest = { modelId: "fixture", stream: true, options: {},
    context: { messages: [{ role: "user", content: "search", timestamp: 0 }], tools: [buildWebSearchTool()] },
    _reasoningReplayScope: scope() };
  const { frames } = await turn(parsed, [searchPass, shellPass]);
  const cell = frames.find(frame => frame.type === "response.output_item.done" && frame.item?.type === "web_search_call")?.item;
  expect(cell?.id).toMatch(/^ws_/);
  // Codex keeps the cell without any result text.
  return { type: "web_search_call", id: cell.id, status: cell.status, action: cell.action };
}

function searchPair(messages: OcxMessage[], id: string) {
  const call = messages.flatMap(message => message.role === "assistant" ? message.content : [])
    .find(part => part.type === "toolCall" && part.id === id);
  const result = messages.find(message => message.role === "toolResult" && message.toolCallId === id);
  return { call, result: result?.role === "toolResult" ? result : undefined };
}

test("the next turn hands the routed model the search result the sidecar recorded for the replayed cell", async () => {
  const cell = await firstTurnCell();
  const parsed = parseRequest(nextTurn(cell));
  parsed._reasoningReplayScope = scope();
  const { seen } = await turn(parsed, [answerPass]);
  const { call, result } = searchPair(seen[0]!, cell.id as string);
  expect(call).toMatchObject({ type: "toolCall", name: "web_search", arguments: { query: "munpia fantasy best 2026" } });
  expect(result?.toolName).toBe("web_search");
  expect(result?.content).toContain("Rank one: The Archmage");
  expect(result?.content).toContain("https://novel.example.test/best");
  // The pair precedes the shell call, so the model sees it searched before running its tool.
  const order = seen[0]!.flatMap(message => message.role === "assistant"
    ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : [])
    : message.role === "toolResult" ? [`result:${message.toolCallId}`] : []);
  expect(order).toEqual([cell.id, `result:${cell.id}`, "call_shell", "result:call_shell"]);
});

test.each([
  { name: "another conversation", other: scope("thread-b") },
  { name: "another caller", other: scope("thread-a", "principal-b") },
  { name: "a caller without a principal", other: { clientThreadId: "thread-a" } },
])("$name keeps the fallback result instead of the recorded one", async ({ other }) => {
  const cell = await firstTurnCell();
  const parsed = parseRequest(nextTurn(cell));
  parsed._reasoningReplayScope = other;
  const { seen } = await turn(parsed, [answerPass]);
  const { result } = searchPair(seen[0]!, cell.id as string);
  expect(result?.content).not.toContain("Rank one");
  expect(result?.content).toContain('Earlier web search for: "munpia fantasy best 2026".');
  expect(result?.content).toContain("not available in the replayed conversation history");
});

test("a replayed cell without a recorded result still tells the model it searched, with its sources", () => {
  const parsed = parseRequest(nextTurn({ type: "web_search_call", id: "ws_native", status: "completed",
    action: { type: "search", query: "q1", queries: ["q1", "q2"] },
    sources: [{ type: "url", url: "https://a.example.test", title: "A" }, { type: "url", url: "https://b.example.test" }] }));
  const { call, result } = searchPair(parsed.context.messages, "ws_native");
  expect(call).toMatchObject({ arguments: { queries: ["q1", "q2"] } });
  expect(result?.isError).toBe(false);
  expect(result?.content).toBe([
    'Earlier web search for: "q1", "q2".',
    "The result text of this search is not available in the replayed conversation history.",
    "Sources it returned (titles and URLs only, untrusted):",
    "- A <https://a.example.test>",
    "- <https://b.example.test>",
  ].join("\n"));
  expect(parsed._replayedWebSearchCellIds).toEqual(["ws_native"]);
});

test("a failed cell is replayed as a failed search, and a cell without an id gets a request-local one", () => {
  const parsed = parseRequest(nextTurn({ type: "web_search_call", status: "failed", action: { type: "search", query: "q" } }));
  const { result } = searchPair(parsed.context.messages, "ws_replay_0");
  expect(result?.isError).toBe(true);
  expect(result?.content).toContain("This search failed");
});

test("without a hosted search declaration the replayed cell stays out of the routed history", () => {
  const parsed = parseRequest(nextTurn({ type: "web_search_call", id: "ws_native", status: "completed",
    action: { type: "search", query: "q" } }, [SHELL]));
  expect(searchPair(parsed.context.messages, "ws_native").call).toBeUndefined();
  expect(parsed.context.messages.some(message => message.role === "toolResult" && message.toolName === "web_search")).toBe(false);
  expect(parsed._replayedWebSearchCellIds).toBeUndefined();
});
