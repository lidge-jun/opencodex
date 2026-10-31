import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import {
  CHAT_TOOL_DISPATCH_NAME, projectChatToolDispatch, rewriteChatToolDispatchEventList, rewriteChatToolDispatchEvents,
} from "../../src/claude/chat-tool-dispatch";
import { parseRequest } from "../../src/responses/parser";
import { resolveAdapter } from "../../src/server/adapter-resolve";
import type { AdapterEvent } from "../../src/types";

const model = "chatgw/deepseek-test";
const provider = { adapter: "openai-chat" as const, baseUrl: "https://chat.example.com/v1", apiKey: "synthetic-fixture" };
const tool = (name: string, deferred = false) => ({
  name, description: `${name} tool`, input_schema: { type: "object", properties: { q: { type: "string" } } },
  ...(deferred ? { defer_loading: true } : {}),
});
const search = (id: string, names: string[]) => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "ToolSearch", input: { query: names.join(",") } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: names.map(tool_name => ({ type: "tool_reference", tool_name })) }] },
];
const call = (id: string, name: string, input: Record<string, unknown>, output: string) => [
  { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
];
const request = (loaded: string[], messages: unknown[] = []) => ({
  model, metadata: { user_id: "synthetic-cache-test" }, system: "Synthetic test instructions", max_tokens: 100,
  tools: [tool("ToolSearch"), tool("Bash"), ...loaded.map(n => tool(n, true))],
  messages: [{ role: "user", content: "Use the available tools." }, ...messages],
});

const parse = (raw: ReturnType<typeof request>) => parseRequest(anthropicToResponsesTranslation(raw, {}).body as any);

/** The actual upstream Chat body the openai-chat adapter would send. */
async function chatBody(raw: ReturnType<typeof request>, dispatch = true): Promise<{ tools: any[]; messages: any[] }> {
  const parsed = parse(raw);
  const projected = dispatch ? projectChatToolDispatch(parsed, raw as any)?.parsed ?? parsed : parsed;
  const built = await resolveAdapter(provider as any, undefined, "chatgw").buildRequest(projected, { headers: new Headers() } as any);
  return JSON.parse(String(built.body));
}

const LOADED: ReadonlySet<string> = new Set(["WebFetch"]);

/** Run both rewrite forms and require them to agree. */
async function collect(events: AdapterEvent[], loaded = LOADED): Promise<AdapterEvent[]> {
  async function* source() { yield* events; }
  const out: AdapterEvent[] = [];
  for await (const event of rewriteChatToolDispatchEvents(source(), loaded)) out.push(event);
  expect(rewriteChatToolDispatchEventList(events, loaded)).toEqual(out);
  return out;
}
const dispatchCall = (id: string, args: string, end: AdapterEvent = { type: "tool_call_end" }): AdapterEvent[] => [
  { type: "tool_call_start", id, name: CHAT_TOOL_DISPATCH_NAME },
  { type: "tool_call_delta", arguments: args },
  end,
];

describe("Chat-wire dispatcher for ToolSearch-loaded tools", () => {
  test("no ToolSearch means no projection", () => {
    const raw = request([]);
    raw.tools = raw.tools.filter(t => t.name !== "ToolSearch");
    expect(projectChatToolDispatch(parse(raw), raw as any)).toBeNull();
  });

  test("the dispatcher is in the catalog from the first request", async () => {
    const body = await chatBody(request([]));
    expect(body.tools.map((t: any) => t.function.name)).toEqual(["ToolSearch", "Bash", CHAT_TOOL_DISPATCH_NAME]);
  });

  test("loading a tool keeps the tool catalog and every earlier message byte-identical", async () => {
    const before = request([], [...call("call_bash", "Bash", { q: "ls" }, "a.txt")]);
    const afterLoad = request(["WebFetch"], [...call("call_bash", "Bash", { q: "ls" }, "a.txt"), ...search("call_search", ["WebFetch"])]);
    const b = await chatBody(before);
    const a = await chatBody(afterLoad);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(JSON.stringify(a.messages.slice(0, b.messages.length))).toBe(JSON.stringify(b.messages));
    // Without the dispatcher the same load rewrites the catalog: the defect this fixes.
    const plainBefore = await chatBody(before, false);
    const plainAfter = await chatBody(afterLoad, false);
    expect(JSON.stringify(plainAfter.tools)).not.toBe(JSON.stringify(plainBefore.tools));
  });

  test("the loaded definition rides the ToolSearch result and later calls go through the dispatcher", async () => {
    const loadAndUse = request(["WebFetch"], [
      ...search("call_search", ["WebFetch"]),
      ...call("call_fetch", "WebFetch", { q: "https://example.com" }, "page"),
    ]);
    const body = await chatBody(loadAndUse);
    expect(body.tools.map((t: any) => t.function.name)).not.toContain("WebFetch");
    const searchResult = body.messages.find((m: any) => m.role === "tool" && m.tool_call_id === "call_search");
    expect(JSON.stringify(searchResult.content)).toContain('<tool name=\\"WebFetch\\">');
    const assistant = body.messages.find((m: any) => m.tool_calls?.some((c: any) => c.id === "call_fetch"));
    const fetchCall = assistant.tool_calls.find((c: any) => c.id === "call_fetch");
    expect(fetchCall.function.name).toBe(CHAT_TOOL_DISPATCH_NAME);
    expect(JSON.parse(fetchCall.function.arguments)).toEqual({ name: "WebFetch", arguments: { q: "https://example.com" } });
  });

  test("history re-encodes identically on the next request", async () => {
    const history = [...search("call_search", ["WebFetch"]), ...call("call_fetch", "WebFetch", { q: "u" }, "page")];
    const first = await chatBody(request(["WebFetch"], history));
    const next = await chatBody(request(["WebFetch"], [...history, ...call("call_bash", "Bash", { q: "pwd" }, "/")]));
    expect(JSON.stringify(next.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(next.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
  });

  test("a deferred tool called before any discovery result keeps its native slot", () => {
    const raw = request(["Legacy"], [...call("call_old", "Legacy", { q: "x" }, "ok")]);
    const projection = projectChatToolDispatch(parse(raw), raw as any)!;
    expect(projection.parsed.context.tools!.map(t => t.name)).toContain("Legacy");
    expect(projection.loaded.has("Legacy")).toBe(false);
  });

  test("a forced hidden tool leaves the request unprojected", () => {
    const raw = request(["WebFetch"], search("call_search", ["WebFetch"])) as any;
    raw.tool_choice = { type: "tool", name: "WebFetch" };
    expect(projectChatToolDispatch(parse(raw), raw)).toBeNull();
  });

  test("a duplicate client call id leaves the request unprojected", () => {
    const raw = request(["WebFetch"], [
      ...search("call_dup", ["WebFetch"]),
      ...call("call_dup", "Bash", { q: "ls" }, "a.txt"),
    ]);
    expect(projectChatToolDispatch(parse(raw), raw as any)).toBeNull();
  });

  test("a discovery result that is not present exactly once leaves the request unprojected", () => {
    const [searchCall, searchResult] = search("call_search", ["WebFetch"]);
    const raw = request(["WebFetch"], [searchCall, searchResult, searchResult]);
    expect(projectChatToolDispatch(parse(raw), raw as any)).toBeNull();
  });

  test("only tools with a discovery result in this request are dispatchable", () => {
    const raw = request(["WebFetch", "NotebookEdit"], search("call_search", ["WebFetch"]));
    const projection = projectChatToolDispatch(parse(raw), raw as any)!;
    expect([...projection.loaded]).toEqual(["WebFetch"]);
    // Both deferred tools stay out of the catalog; only the discovered one is reachable.
    expect(projection.parsed.context.tools!.map(t => t.name)).toEqual(["ToolSearch", "Bash", CHAT_TOOL_DISPATCH_NAME]);
  });

  test("a client tool already named like the dispatcher disables projection", () => {
    const raw = request([]) as any;
    raw.tools.push(tool(CHAT_TOOL_DISPATCH_NAME));
    expect(projectChatToolDispatch(parse(raw), raw)).toBeNull();
  });
});

describe("dispatcher response rewrite", () => {
  test("a dispatcher call becomes the client tool call", async () => {
    const out = await collect([
      { type: "text_delta", text: "ok" } as any,
      { type: "tool_call_start", id: "c1", name: CHAT_TOOL_DISPATCH_NAME },
      { type: "tool_call_delta", arguments: '{"name":"WebFetch",' },
      { type: "tool_call_delta", arguments: '"arguments":{"url":"https://x"}}' },
      { type: "tool_call_end" },
    ]);
    expect(out).toEqual([
      { type: "text_delta", text: "ok" } as any,
      { type: "tool_call_start", id: "c1", name: "WebFetch" },
      { type: "tool_call_delta", arguments: '{"url":"https://x"}' },
      { type: "tool_call_end" },
    ]);
  });

  test("ordinary calls and malformed dispatcher calls pass through unchanged", async () => {
    const plain: AdapterEvent[] = [
      { type: "tool_call_start", id: "c2", name: "Bash" },
      { type: "tool_call_delta", arguments: '{"q":"ls"}' },
      { type: "tool_call_end" },
    ];
    expect(await collect(plain)).toEqual(plain);
    const malformed: AdapterEvent[] = [
      { type: "tool_call_start", id: "c3", name: CHAT_TOOL_DISPATCH_NAME },
      { type: "tool_call_delta", arguments: '{"arguments":{}}' },
      { type: "tool_call_end" },
    ];
    expect(await collect(malformed)).toEqual(malformed);
  });

  test("a dispatcher call naming a tool outside the loaded set passes through unchanged", async () => {
    for (const name of ["NotebookEdit", "Bash", CHAT_TOOL_DISPATCH_NAME, ""]) {
      const events = dispatchCall("c5", JSON.stringify({ name, arguments: {} }));
      expect(await collect(events)).toEqual(events);
    }
  });

  test("consecutive dispatcher calls in one response are rewritten independently", async () => {
    const out = await collect([
      ...dispatchCall("c6", JSON.stringify({ name: "WebFetch", arguments: { url: "a" } })),
      { type: "tool_call_start", id: "c7", name: "Bash" },
      { type: "tool_call_delta", arguments: '{"q":"ls"}' },
      { type: "tool_call_end" },
      ...dispatchCall("c8", JSON.stringify({ name: "NotebookEdit", arguments: {} })),
    ], new Set(["WebFetch", "NotebookEdit"]));
    expect(out.filter(e => e.type === "tool_call_start").map((e: any) => [e.id, e.name]))
      .toEqual([["c6", "WebFetch"], ["c7", "Bash"], ["c8", "NotebookEdit"]]);
  });

  test("a dispatcher call cut off by another event is surfaced as received", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "c9", name: CHAT_TOOL_DISPATCH_NAME },
      { type: "tool_call_delta", arguments: '{"name":"WebFetch"' },
      { type: "error", message: "upstream closed" } as any,
    ];
    expect(await collect(events)).toEqual(events);
    expect(await collect(events.slice(0, 2))).toEqual(events.slice(0, 2));
  });

  test("an incomplete dispatcher call is surfaced as received", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "c4", name: CHAT_TOOL_DISPATCH_NAME },
      { type: "tool_call_delta", arguments: '{"name":"Web' },
      { type: "tool_call_end", incomplete: true },
    ];
    expect(await collect(events)).toEqual(events);
  });
});

describe("dispatcher at the actual Messages HTTP boundary", () => {
  const originalFetch = globalThis.fetch;
  let previousHome: string | undefined;
  let isolated: IsolatedCodexHome | undefined;
  let home: string;
  let release: (() => void) | undefined;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolated = installIsolatedCodexHome("ocx-chat-dispatch-");
    home = mkdtempSync(join(tmpdir(), "ocx-chat-dispatch-config-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(() => {
    release?.();
    globalThis.fetch = originalFetch;
    isolated?.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "chat_dispatch", object: "chat.completion.chunk", model: "deepseek-test",
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  for (const selected of [true, false]) {
    test(`an ${selected ? "opted-in" : "unlisted"} Chat route ${selected ? "dispatches" : "keeps the native catalog"}`, async () => {
      const captured: any[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://chat.example.com/v1/chat/completions");
        captured.push(JSON.parse(String(init?.body)));
        const name = selected ? CHAT_TOOL_DISPATCH_NAME : "WebFetch";
        const args = selected ? JSON.stringify({ name: "WebFetch", arguments: { q: "https://x" } }) : JSON.stringify({ q: "https://x" });
        const body = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_new", type: "function", function: { name, arguments: "" } }] })
          + chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] })
          + chunk({}, "tool_calls") + "data: [DONE]\n\n";
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const config = {
        defaultProvider: "chatgw", providers: { chatgw: { ...provider, models: ["deepseek-test"] } },
        claudeCode: { chatToolDispatchModels: selected ? [model] : ["chatgw/other"] },
      } as unknown as OcxConfig;
      const raw = { ...request(["WebFetch"], search("call_search", ["WebFetch"])), stream: true };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(raw),
      }), config, { model: "", provider: "" });
      const sse = await response.text();
      expect(response.status).toBe(200);
      expect(captured).toHaveLength(1);
      const names = captured[0].tools.map((t: any) => t.function.name);
      expect(names).toEqual(selected ? ["ToolSearch", "Bash", CHAT_TOOL_DISPATCH_NAME] : ["ToolSearch", "Bash", "WebFetch"]);
      // The client always sees its own tool name and arguments.
      expect(sse).toContain('"name":"WebFetch"');
      expect(sse).not.toContain(CHAT_TOOL_DISPATCH_NAME);
      expect(sse).toContain('\\"q\\":\\"https://x\\"');
    });
  }
});
