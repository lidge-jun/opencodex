import { afterEach, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { clearBridgeSearchReplayCacheForTests } from "../../src/responses/bridge-search-replay-cache";
import { runWithWebSearch } from "../../src/web-search/loop";
import { rememberSidecarSearch, restoreSidecarSearchResults, stripReplayedSearchPairs } from "../../src/web-search/sidecar-search-replay";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

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
  // The search joins the shell call's batch, so the model sees it searched in the same turn as the tool.
  const order = seen[0]!.flatMap(message => message.role === "assistant"
    ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : [])
    : message.role === "toolResult" ? [`result:${message.toolCallId}`] : []);
  expect(order).toEqual([cell.id, "call_shell", "result:call_shell", `result:${cell.id}`]);
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
  expect(parsed._replayedWebSearchCells).toEqual([{ cellId: "ws_native", callId: "ws_native", failed: false }]);
});

test("a failed cell is replayed as a failed search, and a cell without an id gets a request-local one", () => {
  const parsed = parseRequest(nextTurn({ type: "web_search_call", status: "failed", action: { type: "search", query: "q" } }));
  restoreSidecarSearchResults(parsed);
  const { result } = searchPair(parsed.context.messages, "ws_replay");
  expect(result?.isError).toBe(true);
  expect(result?.content).toContain("This search failed");
});

test("without a hosted search declaration the replayed cell stays out of the routed history", () => {
  const parsed = parseRequest(nextTurn({ type: "web_search_call", id: "ws_native", status: "completed",
    action: { type: "search", query: "q" } }, [SHELL]));
  expect(searchPair(parsed.context.messages, "ws_native").call).toBeUndefined();
  expect(parsed.context.messages.some(message => message.role === "toolResult" && message.toolName === "web_search")).toBe(false);
  expect(parsed._replayedWebSearchCells).toBeUndefined();
});

const callOrder = (messages: OcxMessage[]) => messages.map(message => message.role === "assistant"
  ? `assistant[${message.content.map(part => part.type === "toolCall" ? part.id : part.type).join(",")}]`
  : message.role === "toolResult" ? `result:${message.toolCallId}` : message.role);
const cell = (id: string) => ({ type: "web_search_call", id, status: "completed", action: { type: "search", query: id } });
const call = (id: string) => ({ type: "function_call", call_id: id, name: "shell", arguments: "{}" });
const output = (id: string) => ({ type: "function_call_output", call_id: id, output: id });
const body = (input: unknown[]) => ({ model: "m", stream: true, tools: [{ type: "web_search" }, SHELL], input });

test("a cell inside a parallel client batch never splits it: its result follows the batch", () => {
  const parsed = parseRequest(body([{ role: "user", content: "go" }, call("A"), cell("ws_mid"), call("B"), output("A"), output("B"),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]));
  expect(callOrder(parsed.context.messages)).toEqual(["user", "assistant[A,ws_mid,B]", "result:A", "result:B", "result:ws_mid", "assistant[text]"]);
});

test("two cells after one reasoning item stay in one assistant turn with that reasoning", () => {
  const parsed = parseRequest(body([{ role: "user", content: "go" },
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }] }, cell("ws_1"), cell("ws_2"),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]));
  expect(callOrder(parsed.context.messages)).toEqual(["user", "assistant[thinking,ws_1,ws_2]", "result:ws_1", "result:ws_2", "assistant[text]"]);
});

test("a cell before consecutive client batches answers within the first batch, before the next call", () => {
  const parsed = parseRequest(body([{ role: "user", content: "go" }, cell("ws_first"), call("A"), output("A"), call("B"), output("B"),
    cell("ws_late")]));
  expect(callOrder(parsed.context.messages)).toEqual(
    ["user", "assistant[ws_first,A]", "result:A", "result:ws_first", "assistant[B]", "result:B", "assistant[ws_late]", "result:ws_late"]);
});

test("a call after an earlier call's output in the same run starts a new turn after the search result", () => {
  const parsed = parseRequest(body([{ role: "user", content: "go" }, call("A"), cell("ws_mid"), output("A"), call("B"), output("B")]));
  expect(callOrder(parsed.context.messages)).toEqual(["user", "assistant[A,ws_mid]", "result:A", "result:ws_mid", "assistant[B]", "result:B"]);
});

test("a failed cell keeps its error flag when a recorded result is restored", () => {
  const parsed = parseRequest(nextTurn({ type: "web_search_call", id: "ws_failed", status: "failed", action: { type: "search", query: "q" } }));
  parsed._reasoningReplayScope = scope();
  rememberSidecarSearch(parsed, "ws_failed", { id: "toolu_x", arguments: { query: "q" } }, "sidecar error: timeout");
  restoreSidecarSearchResults(parsed);
  const { result } = searchPair(parsed.context.messages, "ws_failed");
  expect(result?.content).toBe("sidecar error: timeout");
  expect(result?.isError).toBe(true);
});

test("synthetic call ids never collide with client call ids or with each other", () => {
  const parsed = parseRequest(body([{ role: "user", content: "go" }, cell("ws_replay"),
    { type: "web_search_call", status: "completed", action: { type: "search", query: "no id" } },
    cell("shared"), call("shared"), output("shared")]));
  const cells = parsed._replayedWebSearchCells!;
  expect(cells.map(entry => entry.callId)).toEqual(["ws_replay", "ws_replay_1", "shared_1"]);
  expect(cells.map(entry => entry.cellId)).toEqual(["ws_replay", undefined, "shared"]);
  const ids = parsed.context.messages.flatMap(message => message.role === "assistant"
    ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []);
  expect(new Set(ids).size).toBe(ids.length);
  expect(searchPair(parsed.context.messages, "shared").result?.content).toBe("shared");
});

test("without a sidecar plan the pairs are removed, restoring the pre-#7269 history", () => {
  const input = [{ role: "user", content: "go" },
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }] }, cell("ws_1"),
    call("A"), output("A"), cell("ws_2"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }];
  const parsed = parseRequest(body(input));
  stripReplayedSearchPairs(parsed);
  expect(callOrder(parsed.context.messages)).toEqual(["user", "assistant[thinking,A]", "result:A", "assistant[text]"]);
  expect(parsed._replayedWebSearchCells).toBeUndefined();
  expect(JSON.stringify(parsed.context.messages)).not.toContain("web_search");
  // Stripping is idempotent.
  stripReplayedSearchPairs(parsed);
  expect(callOrder(parsed.context.messages)).toEqual(["user", "assistant[thinking,A]", "result:A", "assistant[text]"]);
});

test("a routed Anthropic turn with the sidecar off sends no call to the undeclared web_search tool", async () => {
  const MODEL = "claude-opus-5-5";
  const wires: string[] = [];
  const frames = [
    { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    wires.push(String(init?.body));
    return new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  const config = {
    port: 0, defaultProvider: "anth", webSearchSidecar: { enabled: false },
    providers: { anth: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "sk-ant-fixture", models: [MODEL], fetch } },
  } as unknown as OcxConfig;
  const release = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...nextTurn({ type: "web_search_call", id: "ws_cell", status: "completed", action: { type: "search", query: "q" } }), model: `anth/${MODEL}` }),
    }), config, { model: "", provider: "" } as RequestLogContext, {});
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    release();
  }
  expect(wires).toHaveLength(1);
  const wire = JSON.parse(wires[0]!) as { tools?: Array<{ name: string }>; messages: Array<{ content: unknown }> };
  expect((wire.tools ?? []).some(tool => tool.name === "web_search")).toBe(false);
  const blocks = wire.messages.flatMap(message => Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []);
  expect(blocks.some(block => block.type === "tool_use" && block.name === "web_search")).toBe(false);
  expect(blocks.some(block => block.type === "tool_use" && block.name === "shell")).toBe(true);
  expect(JSON.stringify(wire)).not.toContain("ws_cell");
});
