import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { webSearchPairFromItem } from "../../src/claude/outbound";
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
    expect(tools[2]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
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

  test("an orphan result with a unique anchor never synthesizes or replays a server call", async () => {
    const mismatched = SEARCH_TURN.map(f => f.type === "content_block_start" && f.index === 1
      ? { ...f, content_block: { ...(f.content_block as Record<string, unknown>), tool_use_id: "srvtoolu_orphan" } } : f);
    const truncated = SEARCH_TURN.map((f, i) => i === 2
      ? { ...f, delta: { type: "input_json_delta", partial_json: `{"query":"${"x".repeat(4096)}` } } : f);
    for (const frames of [
      [MESSAGE_START, ...SEARCH_TURN.slice(5, 10), ...MESSAGE_END],
      [MESSAGE_START, ...fetchTurn(FETCH_RESULT).slice(4)],
      mismatched,
      truncated,
    ]) {
      const turn = clientContent((await claudeTurn("https://api.anthropic.com", frames)).clientSse);
      const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", [
        { role: "user", content: "Search" }, { role: "assistant", content: turn }, { role: "user", content: "More?" },
      ]);
      const messages = wire.messages as { content: Record<string, unknown>[] }[];
      expect(messages[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
      expect(JSON.stringify(messages)).not.toContain("server_tool_use");
      expect(JSON.stringify(messages)).not.toContain("web_search_tool_result");
      expect(JSON.stringify(messages)).not.toContain("web_fetch_tool_result");
      expect(turn).toEqual([{ type: "text", text: "Bun shipped." }]);
    }
  });

  test("a single input fragment past 4 KiB drops its unprovable exchange at the cap", async () => {
    const query = "q".repeat(5000);
    const { clientSse } = await claudeTurn("https://api.anthropic.com", [
      ...SEARCH_TURN.slice(0, 2),
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query }) } },
      ...SEARCH_TURN.slice(4),
    ]);
    expect(blockStarts(clientSse)).toEqual([{ type: "text", text: "" }]);
    expect(clientContent(clientSse)).toEqual([{ type: "text", text: "Bun shipped." }]);
    expect(clientSse).not.toContain(query);
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

/** The client's content blocks rebuilt from its SSE, as Claude Code stores them for the next turn. */
function clientContent(clientSse: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const inputs: string[] = [];
  for (const f of clientFrames(clientSse)) {
    const i = f.index as number;
    const delta = f.delta as Record<string, string> | undefined;
    if (f.type === "content_block_start") blocks[i] = { ...(f.content_block as Record<string, unknown>) };
    else if (delta?.type === "input_json_delta") inputs[i] = (inputs[i] ?? "") + delta.partial_json;
    else if (delta?.type === "text_delta") blocks[i]!.text = String(blocks[i]!.text) + delta.text;
  }
  return blocks.map((b, i) => inputs[i] ? { ...b, input: JSON.parse(inputs[i]!) } : b);
}

describe("a server-tool exchange the client replays reaches Anthropic in place", () => {
  const followUp = (assistant: unknown[], next: unknown = "More?") => [
    { role: "user", content: "What did Bun release?" }, { role: "assistant", content: assistant }, { role: "user", content: next },
  ];

  test("web_search pair before text: original srvtoolu_ id and encrypted_content, only to api.anthropic.com", async () => {
    const turn1 = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", followUp(turn1));
    const content = (wire.messages as { content: Record<string, unknown>[] }[])[1]!.content;
    expect(content.slice(0, 2)).toEqual([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "bun release" } },
      SEARCH_TURN[5]!.content_block as Record<string, unknown>,
    ]);
    expect(content[2]).toMatchObject({ type: "text", text: "Bun shipped." });
    expect(content).toHaveLength(3);
    for (const [baseUrl, target] of [["https://compat.example.com", "anth"], ["https://api.anthropic.com", "gpt"]] as const) {
      const other = JSON.stringify((await claudeTurn(baseUrl, OK_TURN, target, followUp(turn1))).wire);
      expect(other).not.toContain("srvtoolu_1");
      expect(other).toContain("Bun shipped.");
    }
  });

  test("web_fetch pair before a client tool_use keeps its place ahead of the tool_use", async () => {
    const turn1 = clientContent((await claudeTurn("https://api.anthropic.com", fetchTurn(FETCH_RESULT))).clientSse);
    const toolUse = { type: "tool_use", id: "toolu_1", name: "Read", input: {} };
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth",
      followUp([...turn1.slice(0, 2), toolUse], [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]));
    const content = (wire.messages as { content: Record<string, unknown>[] }[])[1]!.content;
    expect(content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_f", name: "web_fetch", input: { url: "https://bun.sh/blog" } },
      { type: "web_fetch_tool_result", tool_use_id: "srvtoolu_f", content: FETCH_RESULT },
      toolUse,
    ]);
  });

  test("a repeated anchor drops its run instead of guessing an owner", async () => {
    const [use, result] = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse).slice(0, 2);
    const thinking = (signature: string) => ({ type: "thinking", thinking: `t ${signature}`, signature });
    const second = [{ ...use, id: "srvtoolu_2" }, { ...result, tool_use_id: "srvtoolu_2" }];
    const third = [{ ...use, id: "srvtoolu_3" }, { ...result, tool_use_id: "srvtoolu_3" }];
    const read = (id: string) => ({ type: "tool_use", id, name: "Read", input: {} });
    // Shape of the maintainer's counterexample on #7236: an earlier string-content turn with the same text,
    // then repeated text anchors around identical searches, identical calls and signed thinking.
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", [
      { role: "user", content: "Hi" }, { role: "assistant", content: "Bun shipped." },
      { role: "user", content: "What did Bun release?" },
      { role: "assistant", content: [
        thinking("SigOne0123456789abcdef"), use, result, { type: "text", text: "Bun shipped." },
        ...second, { type: "text", text: "Bun shipped." }, thinking("SigTwo0123456789abcdef"), ...third, read("toolu_a"), read("toolu_b"),
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }, { type: "tool_result", tool_use_id: "toolu_b", content: "ok" }] },
    ]);
    const ids = (wire.messages as { content: unknown }[])
      .map(m => Array.isArray(m.content) ? m.content.map(b => { const r = b as Record<string, unknown>; return String(r.id ?? r.tool_use_id ?? r.type); }) : []);
    expect(ids[1]).toEqual(["text"]);
    // Only srvtoolu_3, anchored on the unique call toolu_a, replays; the text-anchored runs are ambiguous.
    expect(ids[3]).toEqual(["thinking", "text", "text", "thinking", "srvtoolu_3", "srvtoolu_3", "toolu_a", "toolu_b"]);
  });

  test("a string-form assistant cannot steal a later identical text anchor", async () => {
    const turn = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", [
      { role: "user", content: "Hi" }, { role: "assistant", content: "Bun shipped." },
      { role: "user", content: "Search" }, { role: "assistant", content: turn },
      { role: "user", content: "More?" },
    ]);
    const messages = wire.messages as { content: Record<string, unknown>[] }[];
    expect(messages[3]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
    expect(JSON.stringify(messages)).not.toContain("server_tool_use");
    expect(JSON.stringify(messages)).not.toContain("web_search_tool_result");
  });

  test("repeated identical calls drop ambiguous server exchanges and preserve assistant turns", async () => {
    const turn = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const call = { type: "tool_use", id: "toolu_repeat", name: "Read", input: {} };
    const result = [{ type: "tool_result", tool_use_id: "toolu_repeat", content: "ok" }];
    const first = [...turn, call];
    const second = turn.map(b => b.id === "srvtoolu_1" ? { ...b, id: "srvtoolu_2" }
      : b.tool_use_id === "srvtoolu_1" ? { ...b, tool_use_id: "srvtoolu_2" } : b);
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", [
      { role: "user", content: "Hi" }, { role: "assistant", content: "Bun shipped." },
      { role: "user", content: "Search" }, { role: "assistant", content: first },
      { role: "user", content: result }, { role: "assistant", content: [...second, call] },
      { role: "user", content: result },
    ]);
    const messages = wire.messages as { content: Record<string, unknown>[] }[];
    expect(messages[3]!.content).toEqual([{ type: "text", text: "Bun shipped." }, call]);
    expect(messages[5]!.content).toEqual([{ type: "text", text: "Bun shipped." }, call]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
  });

  test("repeated string, thinking and redacted anchors drop exchanges and preserve signed blocks", async () => {
    const turn = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const [use, result, text] = turn;
    const thinking = { type: "thinking", thinking: "checking", signature: "SigRepeat0123456789abcdef" };
    const redacted = { type: "redacted_thinking", data: "RedactedRepeat0123456789" };
    const pair = (id: string) => [{ ...use, id }, { ...result, tool_use_id: id }];
    const assistant = [thinking, ...pair("srvtoolu_text"), text, redacted,
      ...pair("srvtoolu_thinking"), thinking, ...pair("srvtoolu_redacted"), redacted,
      ...pair("srvtoolu_text2"), text];
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", [
      { role: "user", content: "Hi" }, { role: "assistant", content: "Bun shipped." },
      { role: "user", content: "Search" }, { role: "assistant", content: assistant },
      { role: "user", content: "More?" },
    ]);
    const messages = wire.messages as { role: string; content: Record<string, unknown>[] }[];
    // Reasoning splits this source turn into adjacent translated assistant messages.
    const later = messages.slice(3).filter(m => m.role === "assistant").flatMap(m => m.content);
    expect(later).toEqual([thinking, text, redacted, thinking, redacted, text]);
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
  });

  test("a pair between thinking blocks stays between them", async () => {
    const [use, result] = (await claudeTurn("https://api.anthropic.com", SEARCH_TURN).then(r => clientContent(r.clientSse))).slice(0, 2);
    const thinking = (signature: string) => ({ type: "thinking", thinking: `t ${signature}`, signature });
    const redacted = { type: "redacted_thinking", data: "RedactedPayload0123456789" };
    const second = [{ ...use, id: "srvtoolu_2" }, { ...result, tool_use_id: "srvtoolu_2" }];
    const assistant = [thinking("SigOne0123456789abcdef"), use, result, thinking("SigTwo0123456789abcdef"), ...second, redacted];
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", followUp([...assistant, { type: "text", text: "Bun shipped." }]));
    const content = (wire.messages as { content: Record<string, unknown>[] }[])[1]!.content;
    expect(content.map(b => b.id ?? b.tool_use_id ?? b.type)).toEqual([
      "thinking", "srvtoolu_1", "srvtoolu_1", "thinking", "srvtoolu_2", "srvtoolu_2", "redacted_thinking", "text",
    ]);
  });

  test("duplicate or unmatched server-tool ids never replay an orphan result", async () => {
    const [use, result, text] = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const orphan = { ...result, tool_use_id: "srvtoolu_orphan" };
    for (const blocks of [[use, orphan], [use, use, result, orphan], [use, use, result, result]]) {
      const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", followUp([...blocks, text]));
      expect((wire.messages as { content: unknown }[])[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
    }
  });

  test("malformed server-tool input drops the exchange without changing its unique text anchor", async () => {
    const [use, result, text] = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    for (const [name, field, resultType] of [["web_search", "query", "web_search_tool_result"], ["web_fetch", "url", "web_fetch_tool_result"]] as const) {
      for (const input of [undefined, null, [], "invalid", {}, { [field]: 42 }, { [field]: "" }, { [field]: "  " }]) {
        const call = { ...use, name, input };
        const matched = { ...result, type: resultType, ...(name === "web_fetch" ? { content: FETCH_RESULT } : {}) };
        const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", followUp([call, matched, text]));
        const messages = wire.messages as { content: unknown }[];
        expect(messages[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
        expect(JSON.stringify(messages)).not.toContain("server_tool_use");
        expect(JSON.stringify(messages)).not.toContain(resultType);
      }
    }
  });

  test("a result before its call drops the exchange instead of replaying the reversed pair", async () => {
    const [use, result, text] = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", followUp([result, use, text]));
    const messages = wire.messages as { content: unknown }[];
    expect(messages[1]!.content).toEqual([{ type: "text", text: "Bun shipped." }]);
    expect(JSON.stringify(messages)).not.toContain("server_tool_use");
    expect(JSON.stringify(messages)).not.toContain("web_search_tool_result");
  });

  test("overlapping calls replay in source order when each result follows its own call", async () => {
    const [use, result, text] = clientContent((await claudeTurn("https://api.anthropic.com", SEARCH_TURN)).clientSse);
    const secondUse = { ...use, id: "srvtoolu_second" };
    const secondResult = { ...result, tool_use_id: "srvtoolu_second" };
    const turn = [use, secondUse, secondResult, result, text];
    const { wire } = await claudeTurn("https://api.anthropic.com", OK_TURN, "anth", followUp(turn));
    expect((wire.messages as { content: unknown }[])[1]!.content).toEqual(turn);
  });
});

test("a malformed anthropic_blocks falls back to the rebuilt pair", () => {
  const use = { type: "server_tool_use", id: "srvtoolu_stored", name: "web_search", input: { query: "stored" } };
  for (const anthropic_blocks of [{}, { use: {}, result: {} }, { use: { id: 1, name: "web_search" }, result: { type: "web_search_tool_result" } },
    { use, result: { type: "web_search_tool_result", tool_use_id: "srvtoolu_other" } },
    { use, result: { type: "web_fetch_tool_result", tool_use_id: use.id } },
    { use: { ...use, input: undefined }, result: { type: "web_search_tool_result", tool_use_id: use.id } },
  ]) {
    const pair = webSearchPairFromItem({ type: "web_search_call", id: "ws_1", action: { type: "search", query: "q" }, anthropic_blocks });
    expect(pair).toMatchObject({ id: "ws_1", name: "web_search", resultType: "web_search_tool_result", input: { query: "q" } });
  }
});

test("an item emitted before anthropic_blocks still maps its fetch_result to a web_fetch pair", () => {
  const pair = webSearchPairFromItem({
    type: "web_search_call", id: "srvtoolu_old", action: { type: "open_page", url: "https://bun.sh/blog" },
    fetch_result: FETCH_RESULT,
  });
  expect(pair).toMatchObject({ id: "srvtoolu_old", name: "web_fetch", resultType: "web_fetch_tool_result", input: { url: "https://bun.sh/blog" }, resultContent: FETCH_RESULT });
});
