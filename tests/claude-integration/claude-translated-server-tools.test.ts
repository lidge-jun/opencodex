import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A Claude client's typed web_search / web_fetch reach an Anthropic destination on the
// translated lane (a combo declines the native Messages lane), and Anthropic's server-side
// search comes back to the client as server_tool_use + web_search_tool_result.
const MODEL = "claude-opus-5-5";
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
const WEB_FETCH = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, cache_control: { type: "ephemeral" } };
let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;

beforeAll(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-server-tools-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
});
afterAll(() => {
  releaseSpend?.();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

const sse = (frames: Record<string, unknown>[]) => new Response(
  frames.map(f => `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

const SEARCH_TURN = [
  { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"bun " } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "release\"}" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
    { type: "web_search_result", url: "https://bun.sh/blog", title: "Bun blog", encrypted_content: "enc", page_age: null },
  ] } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Bun shipped." } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5, server_tool_use: { web_search_requests: 1 } } },
  { type: "message_stop" },
];

const OK_TURN = [
  { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

async function claudeTurn(
  baseUrl: string,
  frames: Record<string, unknown>[],
  target: "anth" | "gpt" = "anth",
  messages: unknown[] = [{ role: "user", content: "What did Bun release? https://bun.sh/blog" }],
  { stream = true, direct = false }: { stream?: boolean; direct?: boolean } = {},
): Promise<{ wire: Record<string, unknown>; clientSse: string }> {
  const wires: string[] = [];
  const fetch = (async (_input: unknown, init?: RequestInit) => {
    wires.push(String(init?.body));
    if (target === "gpt") {
      return new Response(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }
    return sse(frames);
  }) as typeof globalThis.fetch;
  const config = {
    port: 0, defaultProvider: "anth",
    claudeCode: { nativePassthrough: false },
    webSearchSidecar: { enabled: false },
    ...(direct ? { protocols: { rollout: { directEncoders: true } } } : {}),
    providers: {
      anth: { adapter: "anthropic", baseUrl, authMode: "key", apiKey: "sk-ant-fixture", models: [MODEL], fetch },
      gpt: { adapter: "openai-chat", baseUrl: "https://gpt.invalid/v1", authMode: "key", apiKey: "sk-fixture", models: ["g"], fetch },
    },
    combos: { waterfall: { strategy: "failover", targets: target === "anth"
      ? [{ provider: "anth", model: MODEL }, { provider: "gpt", model: "g" }]
      : [{ provider: "gpt", model: "g" }, { provider: "anth", model: MODEL }] } },
  } as unknown as OcxConfig;
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: direct ? `anth/${MODEL}` : "combo/waterfall", max_tokens: 64, stream,
      tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }, WEB_SEARCH, WEB_FETCH],
      messages,
    }),
  }), config, { model: "", provider: "" });
  expect(response.status).toBe(200);
  const clientSse = await response.text();
  expect(wires).toHaveLength(1);
  return { wire: JSON.parse(wires[0]!) as Record<string, unknown>, clientSse };
}

function clientFrames(text: string): Record<string, unknown>[] {
  return text.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

describe("translated Claude lane carries typed web tools to Anthropic", () => {
  test("api.anthropic.com receives web_search and web_fetch as declared", async () => {
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN);
    const tools = wire.tools as Record<string, unknown>[];
    expect(tools.map(t => t.name)).toEqual(["Read", "web_search", "web_fetch"]);
    expect(tools[1]).toMatchObject(WEB_SEARCH);
    // The caller's own breakpoint is dropped; the adapter's tools breakpoint lands on the last tool.
    expect(tools[2]).toMatchObject({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 2 });
    expect(tools[2]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("an Anthropic-compatible third party does not receive them", async () => {
    const { wire } = await claudeTurn("https://compat.example.com", OK_TURN);
    expect((wire.tools as Record<string, unknown>[]).map(t => t.name)).toEqual(["Read"]);
  });

  test("a GPT leg's body carries no typed Anthropic tool", async () => {
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "gpt");
    expect(JSON.stringify(wire)).not.toContain("web_fetch");
    expect(JSON.stringify(wire)).not.toContain("web_search_2025");
  });

  test("Anthropic's server-side search reaches the Claude client as server_tool_use + web_search_tool_result", async () => {
    const { clientSse } = await claudeTurn("https://api.anthropic.com", SEARCH_TURN);
    const frames = clientFrames(clientSse);
    const starts = frames.filter(f => f.type === "content_block_start").map(f => f.content_block as Record<string, unknown>);
    expect(starts.map(b => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    const toolUse = starts[0]!;
    expect(toolUse.name).toBe("web_search");
    const queryDelta = frames.find(f => f.type === "content_block_delta"
      && (f.delta as Record<string, unknown>).type === "input_json_delta")!;
    expect(JSON.parse((queryDelta.delta as { partial_json: string }).partial_json)).toEqual({ query: "bun release" });
    expect(starts[1]).toMatchObject({ tool_use_id: toolUse.id, content: [{ type: "web_search_result", url: "https://bun.sh/blog", title: "Bun blog" }] });
    expect(clientSse).toContain("Bun shipped.");
    const usage = frames.find(f => f.type === "message_delta")!.usage as Record<string, unknown>;
    expect(usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });
});

const MESSAGE_START = SEARCH_TURN[0]!;
const MESSAGE_END = SEARCH_TURN.slice(-2);
const blockStarts = (clientSse: string) => clientFrames(clientSse)
  .filter(f => f.type === "content_block_start").map(f => f.content_block as Record<string, unknown>);

describe("server-side search across responses", () => {
  test("a search Anthropic defers beside a client tool_use is not surfaced as a completed search", async () => {
    const { clientSse } = await claudeTurn("https://api.anthropic.com", [
      MESSAGE_START,
      ...SEARCH_TURN.slice(1, 5),
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
    expect(blockStarts(clientSse).map(b => b.type)).toEqual(["tool_use"]);
  });

  test("a result whose call came in an earlier response still reaches the client by its tool_use_id", async () => {
    const { clientSse } = await claudeTurn("https://api.anthropic.com", [MESSAGE_START, ...SEARCH_TURN.slice(5, 10), ...MESSAGE_END]);
    const starts = blockStarts(clientSse);
    expect(starts.map(b => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(starts[1]).toMatchObject({ tool_use_id: starts[0]!.id, content: [{ type: "web_search_result", url: "https://bun.sh/blog" }] });
  });

  test("a replayed search pair without encrypted_content never reaches Anthropic", async () => {
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", [
      { role: "user", content: "What did Bun release?" },
      { role: "assistant", content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "bun release" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", url: "https://bun.sh/blog", title: "Bun blog" }] },
        { type: "text", text: "Bun shipped." },
      ] },
      { role: "user", content: "More?" },
    ]);
    const wireText = JSON.stringify(wire.messages);
    expect(wireText).not.toContain("web_search_tool_result");
    expect(wireText).not.toContain("server_tool_use");
    expect(wireText).toContain("Bun shipped.");
  });
});

const FETCH_RESULT = {
  type: "web_fetch_result", url: "https://bun.sh/blog", retrieved_at: "2026-10-15T00:00:00Z",
  content: { type: "document", title: "Bun blog", citations: { enabled: true }, source: { type: "text", media_type: "text/plain", data: "Bun 2 is out." } },
};
const fetchTurn = (result: unknown) => [
  MESSAGE_START,
  { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_f", name: "web_fetch", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"url\":\"https://bun.sh/blog\"}" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_f", content: result } },
  { type: "content_block_stop", index: 1 },
  ...SEARCH_TURN.slice(7, 10),
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5, server_tool_use: { web_fetch_requests: 1 } } },
  { type: "message_stop" },
];

describe("server-side web_fetch reaches the Claude client", () => {
  for (const [lane, opts] of [["bridge stream", {}], ["bridge JSON", { stream: false }], ["direct encoder", { direct: true }]] as const) {
    test(`${lane}: server_tool_use web_fetch + its web_fetch_tool_result, verbatim`, async () => {
      for (const result of [FETCH_RESULT, { type: "web_fetch_tool_error", error_code: "url_not_accessible" }]) {
        const { clientSse } = await claudeTurn("https://api.anthropic.com", fetchTurn(result), "anth", undefined, opts);
        let blocks: Record<string, unknown>[];
        let usage: Record<string, unknown>;
        if ("stream" in opts) {
          const message = JSON.parse(clientSse) as { content: Record<string, unknown>[]; usage: Record<string, unknown> };
          blocks = message.content;
          usage = message.usage;
        } else {
          const frames = clientFrames(clientSse);
          blocks = blockStarts(clientSse);
          const input = frames.find(f => f.type === "content_block_delta" && (f.delta as Record<string, unknown>).type === "input_json_delta")!;
          blocks[0] = { ...blocks[0], input: JSON.parse((input.delta as { partial_json: string }).partial_json) };
          usage = frames.find(f => f.type === "message_delta")!.usage as Record<string, unknown>;
        }
        expect(blocks.map(b => b.type)).toEqual(["server_tool_use", "web_fetch_tool_result", "text"]);
        expect(blocks[0]).toMatchObject({ name: "web_fetch", input: { url: "https://bun.sh/blog" } });
        expect(blocks[1]).toEqual({ type: "web_fetch_tool_result", tool_use_id: blocks[0]!.id, content: result });
        // A fetch is not a search.
        expect(usage.server_tool_use).toBeUndefined();
      }
    });
  }
});

describe("anthropic adapter: typed web tools beside function tools", () => {
  const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", authMode: "key" } as unknown as OcxProviderConfig;
  test("the web-search sidecar's web_search function keeps priority; web_fetch is still carried", async () => {
    const parsed = {
      modelId: MODEL, stream: true, options: {},
      context: { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [{ name: "web_search", description: "search", parameters: { type: "object", properties: {} } }] },
      _anthropicServerTools: [WEB_SEARCH, WEB_FETCH],
    } as unknown as OcxParsedRequest;
    const { body } = await createAnthropicAdapter(provider).buildRequest(parsed);
    const tools = (JSON.parse(String(body)) as { tools: Record<string, unknown>[] }).tools;
    expect(tools.map(t => t.type ?? "function")).toEqual(["function", "web_fetch_20250910"]);
  });
});
