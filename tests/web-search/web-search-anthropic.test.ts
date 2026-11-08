import { afterEach, describe, expect, mock, test } from "bun:test";
import * as oauthModule from "../../src/oauth";

// Stub the stored-OAuth token fetch so the anthropic executor request-shape test is deterministic
// and never touches the real credential store or network (mirrors tests/destination-policy-resolved).
let oauthAccessError: Error | undefined;
mock.module("../../src/oauth", () => ({
  ...oauthModule,
  getValidAccessToken: async () => {
    if (oauthAccessError) throw oauthAccessError;
    return "test-token-xyz";
  },
}));

import { parseRequest } from "../../src/responses/parser";
import {
  findAnthropicSidecarProvider,
  planWebSearch,
  resolveSidecarBackend,
} from "../../src/web-search";
import { parseAnthropicSidecarSSE, runAnthropicWebSearch } from "../../src/web-search/anthropic-executor";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../src/oauth/anthropic";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { repoPath } from "../helpers/repo-root";
import { createRequestExecutionBudget, type AuxiliaryModelSend } from "../../src/lib/request-execution-budget";
import { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY, type SpendJournal } from "../../src/lib/spend-reservation-ledger";
import { createRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { estimateTokens } from "../../src/lib/token-estimate";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { runWithWebSearch } from "../../src/web-search/loop";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import { createPassthroughWebSearchBridgeExecutor } from "../../src/web-search/passthrough-bridge";

const routedProvider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
const forwardProvider: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" };
const anthropicProvider: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };
const AUTH_ERROR_CANARY = "C:\\Users\\Alice\\.opencodex\\auth.json.ocx-tmp /home/alice/.opencodex/auth.json.ocx-tmp";
const PUBLIC_OAUTH_ERROR = "OAuth authentication failed. Check the OpenCodex account status and retry.";

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "routed", providers: { routed: routedProvider, chatgpt: forwardProvider }, ...overrides };
}

function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "Search current docs", stream: true, tools: [{ type: "web_search" }] });
}

describe("Anthropic helper physical admission", () => {
  const originalFetch = globalThis.fetch;
  const settings = { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false };
  afterEach(() => { globalThis.fetch = originalFetch; oauthAccessError = undefined; });
  function owner(maxTokens = 100_000, helperPool = "anthropic") {
    const lines: string[] = [];
    const journal: SpendJournal = { read: () => [...lines], append: line => { lines.push(line); }, rewrite: next => { lines.splice(0, lines.length, ...next); } };
    const ledger = createSpendReservationLedger({ journal, policy: { ...DEFAULT_SPEND_RESERVATION_POLICY,
      pool: { maxTokens }, canonicalProviderIds: ["parent", helperPool] } });
    const log: Parameters<typeof createRequestSpendTracker>[0] = { provider: "parent", model: "parent", accountLogLabel: "parent-account", spendInputEstimateTokens: 1, spendOutputCeilingTokens: 1 };
    const tracker = createRequestSpendTracker(log, undefined, ledger);
    const budget = createRequestExecutionBudget(undefined, "anthropic-helper", tracker);
    const translatorBudget = createTranslatorBudget();
    const value = createResponsesSendBudget({ req: new Request("http://localhost/v1/responses"), logCtx: log,
      options: { sendBudget: budget, translatorBudget } });
    if (value instanceof Response) { translatorBudget.dispose(); throw new Error("fixture refused"); }
    return { value, budget, tracker, ledger, lines, log, close: () => translatorBudget.dispose() };
  }
  const ok = () => sseResponse([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 }, { type: "message_stop" },
  ]);

  test("a helper's own output ceiling refuses before fetch despite a tiny parent estimate", async () => {
    const f = owner(100);
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return ok(); }) as typeof fetch;
    try {
      const out = await runAnthropicWebSearch("q", "anthropic", anthropicProvider, settings, undefined, undefined, f.value.dispatchSidecarSend);
      expect(fetches).toBe(0);
      expect(out.error).toBe("anthropic sidecar send_budget_exhausted");
      expect(f.tracker.refusals).toBe(1);
      expect(f.budget.used).toBe(0);
    } finally { f.tracker.settle(undefined); f.close(); }
  });

  test("a nonterminal auxiliary pool refusal leaves a successful routed answer unmarked", async () => {
    const f = owner(100, "claude-fixture");
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return ok(); }) as typeof fetch;
    const passes: AdapterEvent[][] = [
      [{ type: "tool_call_start", id: "s1", name: "web_search" }, { type: "tool_call_delta", arguments: '{"query":"fixture"}' }, { type: "tool_call_end" }, { type: "done" }],
      [{ type: "text_delta", text: "normal answer" }, { type: "done" }],
    ];
    const adapter: ProviderAdapter = { name: "nonterminal-auxiliary-fixture",
      buildRequest: () => ({ url: "https://routed.test", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire"), async *parseStream() { yield* passes.shift()!; } };
    const translatorBudget = createTranslatorBudget();
    try {
      const response = await runWithWebSearch({ parsed: parsedWithWebSearch(), adapter, backend: "anthropic",
        anthropicSidecar: { providerName: "claude-fixture", provider: anthropicProvider,
          config: config({ providers: { routed: routedProvider, "claude-fixture": anthropicProvider } }) },
        dispatchSidecarSend: f.value.dispatchSidecarSend, settings, maxSearches: 1, hostedTool: { type: "web_search" },
        selectedForwardHeaders: new Headers(), incomingMeta: { headers: new Headers(), translatorBudget } });
      expect(await response.text()).toContain("normal answer"); expect(fetches).toBe(0);
      expect(f.tracker.refusals).toBe(1); expect(f.tracker.lastRefusal?.reason).toBe("workflow-spend-exhausted");
      expect(f.log.localTerminalReason).toBeUndefined(); expect(f.log.errorCode).toBeUndefined();
      expect(f.log.terminalSource).toBeUndefined();
    } finally { f.tracker.settle(undefined); translatorBudget.dispose(); f.close(); }
  });

  test("each query owns a seed and reset replay counts each actual send", async () => {
    const f = owner();
    let fetches = 0;
    const reserves = () => f.lines.map(line => JSON.parse(line)).filter(row => row.kind === "reserve").length;
    const countsAtWire: number[] = [];
    const wireBodies: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      wireBodies.push(String(init?.body));
      fetches++; countsAtWire.push(reserves());
      if (fetches === 1) throw Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
      return ok();
    }) as typeof fetch;
    try {
      const first = await runAnthropicWebSearch("q1", "anthropic", anthropicProvider, settings, undefined, undefined, f.value.dispatchSidecarSend);
      const second = await runAnthropicWebSearch("q2", "anthropic", anthropicProvider, settings, undefined, undefined, f.value.dispatchSidecarSend);
      expect(first.error).toBeUndefined(); expect(second.error).toBeUndefined();
      expect(first.text).toBe("ok"); expect(second.text).toBe("ok");
      expect(fetches).toBe(3);
      expect(countsAtWire).toEqual([1, 1, 3]);
      expect(reserves()).toBe(3);
      expect(f.budget.used).toBe(3);
      const expectedHold = wireBodies.reduce((total, body) =>
        total + Math.max(1, estimateTokens(body, settings.model)) + (JSON.parse(body) as { max_tokens: number }).max_tokens, 0);
      expect(f.ledger.snapshot("pool", "anthropic")!.reserved).toBe(expectedHold);
      expect(f.ledger.snapshot("identity", "parent-account")).toBeUndefined();
      expect(f.ledger.snapshot("pool", "parent")).toBeUndefined();
    } finally { f.tracker.settle(undefined); f.close(); }
  });

  test("an already aborted query never admits or sends a helper", async () => {
    const f = owner();
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return ok(); }) as typeof fetch;
    try {
      const out = await runAnthropicWebSearch("q", "anthropic", anthropicProvider, settings, AbortSignal.abort(), undefined, f.value.dispatchSidecarSend);
      expect(out.error).toBeDefined(); expect(fetches).toBe(0);
      expect(f.budget.used).toBe(0); expect(f.lines).toHaveLength(0);
    } finally { f.tracker.settle(undefined); f.close(); }
  });

  for (const path of ["fetch-loop", "run-turn", "passthrough-bridge"] as const) {
    test(`${path} forwards helper admission and preserves a refused search as a tool error`, async () => {
      let admissions = 0, fetches = 0;
      globalThis.fetch = (async () => { fetches++; return ok(); }) as typeof fetch;
      const dispatchSidecarSend: AuxiliaryModelSend = async target => {
        expect(target.poolId).toBe("claude-fixture");
        expect(target.identityId).toBe("");
        admissions++; throw new SendBudgetExhaustedError();
      };
      const anthropicSidecar = { providerName: "claude-fixture", provider: anthropicProvider, config: config() };
      const parsed: OcxParsedRequest = { modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [] } };
      const search: AdapterEvent[] = [
        { type: "tool_call_start", id: "search-1", name: "web_search" },
        { type: "tool_call_delta", arguments: '{"query":"fixture"}' }, { type: "tool_call_end" }, { type: "done" },
      ];
      const answer: AdapterEvent[] = [{ type: "text_delta", text: "answer" }, { type: "done" }];
      async function* stream(events: AdapterEvent[]) { yield* events; }
      const translatorBudget = createTranslatorBudget();
      let continued: OcxParsedRequest | undefined;
      try {
        if (path === "fetch-loop") {
          const passes = [search, answer];
          const adapter: ProviderAdapter = {
            name: "helper-admission-fixture",
            buildRequest: request => { continued = request; return { url: "https://routed.test", method: "POST", headers: {}, body: "{}" }; },
            fetchResponse: async () => new Response("wire"),
            async *parseStream() { yield* passes.shift()!; },
          };
          const response = await runWithWebSearch({ parsed, adapter, backend: "anthropic", anthropicSidecar,
            dispatchSidecarSend, settings, hostedTool: { type: "web_search" }, maxSearches: 1,
            selectedForwardHeaders: new Headers(), incomingMeta: { headers: new Headers(), translatorBudget } });
          expect(await response.text()).toContain("answer");
        } else if (path === "run-turn") {
          const events: AdapterEvent[] = [];
          for await (const event of runTurnWebSearchLoop(stream(search), { parsed, translatorBudget, dispatchSidecarSend,
            plan: { backend: "anthropic", anthropicSidecar, settings, hostedTool: { type: "web_search" }, maxSearches: 1,
              routedModelStallTimeoutMs: 1000, stallTimeoutSec: 1, streamRoutedModelOutput: false },
            dispatch: request => { continued = request; return stream(answer); } })) events.push(event);
          expect(events.some(event => event.type === "text_delta" && event.text === "answer")).toBe(true);
        } else {
          const execute = createPassthroughWebSearchBridgeExecutor({ backend: "anthropic", maxSearches: 1, timeoutMs: 5000 },
            { auth: { anthropic: anthropicSidecar }, dispatchSidecarSend });
          expect((await execute(["fixture"])).error).toBe("anthropic sidecar send_budget_exhausted");
        }
        if (continued) expect(JSON.stringify(continued.context.messages)).toContain("send_budget_exhausted");
        expect(admissions).toBe(1); expect(fetches).toBe(0);
      } finally { translatorBudget.dispose(); }
    });
  }
});

/** Build an Anthropic-style SSE stream Response from frame objects. */
function sseResponse(frames: Record<string, unknown>[], opts: { crlf?: boolean; unterminated?: boolean; chunkSize?: number } = {}): Response {
  const nl = opts.crlf ? "\r\n" : "\n";
  let body = frames.map(f => `event: ${f.type}${nl}data: ${JSON.stringify(f)}${nl}${nl}`).join("");
  if (opts.unterminated) body = body.replace(/(\r\n\r\n|\n\n)$/, ""); // drop the final frame terminator
  return new Response(new ReadableStream({
    start(c) {
      const bytes = new TextEncoder().encode(body);
      if (opts.chunkSize && opts.chunkSize > 0) {
        for (let i = 0; i < bytes.length; i += opts.chunkSize) c.enqueue(bytes.slice(i, i + opts.chunkSize));
      } else {
        c.enqueue(bytes);
      }
      c.close();
    },
  }), { status: 200 });
}

describe("web-search anthropic backend resolution", () => {
  test("resolveSidecarBackend: explicit wins, unset defaults to openai", () => {
    expect(resolveSidecarBackend("anthropic")).toBe("anthropic");
    expect(resolveSidecarBackend("openai")).toBe("openai");
    expect(resolveSidecarBackend(undefined)).toBe("openai");
  });

  test("findAnthropicSidecarProvider ignores providers with no usable stored credential", () => {
    // "anthropicx" has no account in the real store → not selectable.
    const cfg = config({ providers: { routed: routedProvider, chatgpt: forwardProvider, anthropicx: anthropicProvider } });
    expect(findAnthropicSidecarProvider(cfg)).toBeUndefined();
  });

  test("planWebSearch defaults to the openai backend when no anthropic credential exists", () => {
    const sidecar = {
      providerName: "openai" as const,
      provider: forwardProvider,
      accountMode: "direct" as const,
      authContext: { kind: "main" as const, accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }),
    };
    const plan = planWebSearch(config(), parsedWithWebSearch(), false, routedProvider, "model", sidecar);
    expect(plan?.backend).toBe("openai");
    expect(plan?.forwardSidecar).toBe(sidecar);
    expect(plan?.anthropicSidecar).toBeUndefined();
  });

  test("planWebSearch FAILS CLOSED when anthropic is explicitly configured but no credential is usable", () => {
    const cfg = config({ webSearchSidecar: { backend: "anthropic" } });
    // No usable anthropic credential → must return no plan (never silently borrow ChatGPT creds).
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routedProvider, "model")).toBeUndefined();
  });
});

describe("parseAnthropicSidecarSSE", () => {
  const partial = { type: "content_block_delta", delta: { type: "text_delta", text: "partial answer" } };
  const delta = (reason: string) => ({ type: "message_delta", delta: { stop_reason: reason } });

  test.each([
    ["upstream error", [partial, { type: "error", error: { type: "overloaded_error" } }]],
    ["missing completion", [partial]],
    ["search tool error", [{ type: "content_block_start", content_block: { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } } }, partial, { type: "message_stop" }]],
    ["max_tokens", [partial, delta("max_tokens"), { type: "message_stop" }]],
    ["error stop reason", [partial, delta("error"), { type: "message_stop" }]],
    ["empty stop reason", [partial, delta(""), { type: "message_stop" }]],
    ["empty stop reason at EOF", [partial, delta("")]],
    ["content after stop reason", [partial, delta("end_turn"), partial]],
  ])("reports %s without losing partial text", async (_name, frames) => {
    const out = await parseAnthropicSidecarSSE(sseResponse(frames));
    expect(out.text).toContain("partial answer");
    expect(out.error).toBeDefined();
  });

  test("accepts clean EOF after a complete successful message_delta and ping", async () => {
    const out = await parseAnthropicSidecarSSE(sseResponse([partial, delta("end_turn"), { type: "ping" }]));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeUndefined();
  });

  test("does not accept an unterminated message_delta as clean EOF", async () => {
    const out = await parseAnthropicSidecarSSE(sseResponse([partial, delta("end_turn")], { unterminated: true }));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("does not treat ping-named terminal data as completion", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\nevent: ping\ndata: {"type":"message_stop"}\n\n`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("a partial frame after a completed delta invalidates clean EOF", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\ndata: ${JSON.stringify(delta("end_turn"))}\n\nevent: content_block_delta\ndata: {"type":`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("a trailing SSE comment keeps the clean EOF completion", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\ndata: ${JSON.stringify(delta("end_turn"))}\n\n: keepalive\n`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeUndefined();
  });

  test("complete field-only SSE blocks do not invalidate clean EOF", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\ndata: ${JSON.stringify(delta("end_turn"))}\n\nid: 123\nretry: 500\n\nevent: custom\n\n`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeUndefined();
  });

  test("an unfinished field-only SSE block still invalidates clean EOF", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\ndata: ${JSON.stringify(delta("end_turn"))}\n\nevent: content_block_delta`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("accepts CR-only framing and a clean EOF", async () => {
    const body = `data: ${JSON.stringify(partial)}\r\rdata: ${JSON.stringify(delta("end_turn"))}\r\r`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeUndefined();
  });

  test("reports malformed data after message_stop", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\ndata: {"type":"message_stop"}\n\ndata: {`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("does not hide malformed data before message_stop", async () => {
    const body = `data: ${JSON.stringify(partial)}\n\ndata: {broken\n\ndata: {"type":"message_stop"}\n\n`;
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("reports a failed reader after preserving decoded text", async () => {
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify(partial)}\n\n`);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(encoded); }
        else controller.error(new Error("synthetic read failure"));
      },
    }, { highWaterMark: 0 });
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("partial answer");
    expect(out.error).toBeDefined();
  });

  test("folds web_search_tool_result + text + citations into {text, sources} and dedups by url", async () => {
    const res = sseResponse([
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"bun\"}" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
        { type: "web_search_result", url: "https://bun.sh", title: "Bun" },
        { type: "web_search_result", url: "https://bun.sh", title: "Bun dup" },
        { type: "web_search_result", url: "https://github.com/oven-sh/bun" },
      ] } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Bun 1.3 " } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "is out." } },
      { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://bun.sh/blog", title: "Blog" } } },
      { type: "content_block_stop", index: 2 },
      { type: "message_stop" },
    ]);
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("Bun 1.3 is out.");
    expect(out.sources).toEqual([
      { url: "https://bun.sh", title: "Bun" },
      { url: "https://github.com/oven-sh/bun" },
      { url: "https://bun.sh/blog", title: "Blog" },
    ]);
  });

  test("web_search_tool_result_error with no answer text surfaces an error", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_2", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.text).toBe("");
    expect(out.sources).toEqual([]);
    expect(out.error).toBeDefined();
  });

  test("an unterminated frame cannot buffer the stream without bound", async () => {
    // A sidecar that never emits a frame separator: without a cap the parser would accumulate
    // the whole stream in memory before it could fold anything.
    let produced = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`data: {"filler":"${"x".repeat(64 * 1024)}"}`);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (produced > 8 * 1024 * 1024) { c.close(); return; }
        produced += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    });
    const out = await parseAnthropicSidecarSSE(new Response(body, { status: 200 }));
    expect(cancelled).toBe(true);
    // The cap stops the read long before the producer would have finished on its own.
    expect(produced).toBeLessThan(1024 * 1024);
    expect(out.text).toBe("");
  });

  test("empty results (content:[]) with answer text is a success, not an error", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_3", content: [] } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "No relevant results." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]);
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("No relevant results.");
    expect(out.sources).toEqual([]);
  });

  test("handles CRLF framing and an unterminated final frame", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_4", content: [{ type: "web_search_result", url: "https://example.com", title: "Ex" }] } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer via CRLF." } },
    ], { crlf: true, unterminated: true });
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.text).toBe("Answer via CRLF.");
    expect(out.sources).toEqual([{ url: "https://example.com", title: "Ex" }]);
  });

  test("handles a CRLF frame terminator split across chunk boundaries (byte-by-byte)", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_5", content: [{ type: "web_search_result", url: "https://split.example", title: "Split" }] } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Chunked CRLF answer." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ], { crlf: true, chunkSize: 1 });
    const out = await parseAnthropicSidecarSSE(res);
    expect(out.text).toBe("Chunked CRLF answer.");
    expect(out.sources).toEqual([{ url: "https://split.example", title: "Split" }]);
  });
});

describe("Anthropic sidecar byte boundaries", () => {
  test.each(["\n", "\r\n", "\r"])("accepts a complete message_stop at the byte cap with %j framing", async (nl) => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}${nl}${nl}`;
    const terminal = `data: {"type":"message_stop"}${nl}${nl}`;
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 1 - 2 * nl.length)}${nl}${nl}`;
    const body = prefix + filler + terminal;
    expect(new TextEncoder().encode(body).byteLength).toBe(size);
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out).toEqual({ text: "answer", sources: [] });
  });

  test("still reports max_tokens when its complete terminal lands at the byte cap", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } })}\n\n`;
    const terminal = 'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\ndata: {"type":"message_stop"}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    const out = await parseAnthropicSidecarSSE(new Response(prefix + filler + terminal));
    expect(out.text).toBe("partial");
    expect(out.error).toBe("anthropic sidecar produced an incomplete answer");
  });

  test("accepts a complete successful stop-reason delta and clean EOF at the byte cap", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`;
    const terminal = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    const out = await parseAnthropicSidecarSSE(new Response(prefix + filler + terminal));
    expect(out).toEqual({ text: "answer", sources: [] });
  });

  test("does not accept a successful stop-reason delta when EOF is not clean at the cap", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`;
    const terminal = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix + filler + terminal));
        controller.enqueue(new TextEncoder().encode('data: {"type":"error"}\n\n'));
        controller.close();
      },
    });
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("answer");
    expect(out.error).toBeDefined();
  });

  test("does not hide over-cap bytes after a complete terminal in the same chunk", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`;
    const terminal = 'data: {"type":"message_stop"}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    const out = await parseAnthropicSidecarSSE(new Response(prefix + filler + terminal + "x"));
    expect(out.text).toBe("answer");
    expect(out.error).toBeDefined();
  });

  test("does not hide over-cap bytes in a later chunk after a terminal", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`;
    const terminal = 'data: {"type":"message_stop"}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix + filler + terminal));
        controller.enqueue(new TextEncoder().encode('data: {"type":"error"}\n\n'));
        controller.close();
      },
    });
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out.text).toBe("answer");
    expect(out.error).toBeDefined();
  });

  test("accepts EOF after empty chunks following a terminal at the byte cap", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`;
    const terminal = 'data: {"type":"message_stop"}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(prefix + filler + terminal)); },
      pull(controller) {
        if (pulls++ < 3) controller.enqueue(new Uint8Array(0));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const out = await parseAnthropicSidecarSSE(new Response(body));
    expect(out).toEqual({ text: "answer", sources: [] });
  });

  test("does not wait indefinitely when EOF cannot be verified at the byte cap", async () => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })}\n\n`;
    const terminal = 'data: {"type":"message_stop"}\n\n';
    const size = 64 * 1024;
    const filler = `:${"x".repeat(size - new TextEncoder().encode(prefix + terminal).length - 3)}\n\n`;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(prefix + filler + terminal)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        parseAnthropicSidecarSSE(new Response(body)),
        new Promise<"hung">(resolve => { watchdog = setTimeout(() => resolve("hung"), 3_000); }),
      ]);
      expect(outcome).not.toBe("hung");
      if (outcome === "hung") throw new Error("sidecar parser did not finish");
      expect(outcome.error).toBeDefined();
      expect(cancelled).toBe(true);
    } finally { if (watchdog !== undefined) clearTimeout(watchdog); }
  });

  test("synchronous empty chunks cannot starve the bounded EOF probe", async () => {
    const script = `
      import { parseAnthropicSidecarSSE } from ${JSON.stringify(repoPath("src/web-search/anthropic-executor.ts"))};
      const prefix = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\\n\\n';
      const terminal = 'data: {"type":"message_stop"}\\n\\n';
      const filler = ':' + 'x'.repeat(65536 - new TextEncoder().encode(prefix + terminal).length - 3) + '\\n\\n';
      const body = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(prefix + filler + terminal)); },
        pull(c) { c.enqueue(new Uint8Array(0)); },
      }, { highWaterMark: 0 });
      const outcome = await parseAnthropicSidecarSSE(new Response(body));
      process.stdout.write(outcome.error ?? 'unexpected success');
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, 5_000);
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ timedOut, status, stdout, stderr }).toEqual({
        timedOut: false,
        status: 0,
        stdout: "anthropic sidecar response byte limit reached before EOF",
        stderr: "",
      });
    } finally { clearTimeout(watchdog); }
  }, 10_000);
  test.each([64 * 1024, 80 * 1024])("preserves complete prefix frames at %i bytes without awaiting cancel", async (size) => {
    const prefix = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "prefix 한글" } })}\n\n`;
    const tail = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "discard" } })}`;
    const encoder = new TextEncoder();
    // The final unterminated frame is syntactically valid exactly at the cap.
    // EOF flush must not fold it after cancellation.
    const body = prefix + ":" + "x".repeat(64 * 1024 - encoder.encode(prefix + "\n\n" + tail).length - 1) + "\n\n" + tail;
    const bytes = encoder.encode(body + "z".repeat(size - 64 * 1024));
    let cancelled = false;
    const res = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 }));
    const out = await parseAnthropicSidecarSSE(res);
    expect(cancelled).toBe(true);
    expect(out).toEqual({ text: "prefix 한글", sources: [], error: "anthropic sidecar response exceeded the byte limit" });
  });
});

describe("runAnthropicWebSearch request shape", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    oauthAccessError = undefined;
  });

  test.each([401, 503])("bounds HTTP %i error bodies and never awaits non-settling cancellation", async (status) => {
    let reads = 0;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new Uint8Array(4096).fill(120)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 }), { status })) as typeof fetch;
    const out = await runAnthropicWebSearch("bounded fixture", "anthropic", anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false });
    expect(reads).toBe(16);
    expect(cancelled).toBe(true);
    expect(out.error).toBe(status === 401
      ? `anthropic sidecar auth failed: ${PUBLIC_OAUTH_ERROR}` : "sidecar HTTP 503");
  });

  test("projects OAuth, upstream-auth, and transport failures onto safe public errors", async () => {
    oauthAccessError = new Error(`credential read failed at ${AUTH_ERROR_CANARY}`);
    const credentialFailure = await runAnthropicWebSearch(
      "private query",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(credentialFailure.error).toBe(`anthropic sidecar auth failed: ${PUBLIC_OAUTH_ERROR}`);
    expect(credentialFailure.error).not.toContain(AUTH_ERROR_CANARY);

    oauthAccessError = undefined;
    globalThis.fetch = (async () => new Response(AUTH_ERROR_CANARY, { status: 401 })) as typeof fetch;
    const upstreamAuthFailure = await runAnthropicWebSearch(
      "private query",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(upstreamAuthFailure.error).toBe(`anthropic sidecar auth failed: ${PUBLIC_OAUTH_ERROR}`);
    expect(upstreamAuthFailure.error).not.toContain(AUTH_ERROR_CANARY);

    globalThis.fetch = (async () => new Response(AUTH_ERROR_CANARY, { status: 403 })) as typeof fetch;
    const permissionFailure = await runAnthropicWebSearch(
      "private query",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(permissionFailure.error).toBe("sidecar HTTP 403");
    expect(permissionFailure.error).not.toContain(AUTH_ERROR_CANARY);

    globalThis.fetch = (async () => new Response(AUTH_ERROR_CANARY, { status: 500 })) as typeof fetch;
    const upstreamFailure = await runAnthropicWebSearch(
      "private query",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(upstreamFailure.error).toBe("sidecar HTTP 500");
    expect(upstreamFailure.error).not.toContain(AUTH_ERROR_CANARY);

    globalThis.fetch = (async () => { throw new Error(`connect failed at ${AUTH_ERROR_CANARY}`); }) as typeof fetch;
    const transportFailure = await runAnthropicWebSearch(
      "private query",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(transportFailure.error).toBe("anthropic sidecar connect_error");
    expect(transportFailure.error).not.toContain(AUTH_ERROR_CANARY);
  });

  test("POSTs /v1/messages with the OAuth fingerprint, disabled thinking, and the web_search tool", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      captured = { url: String(url), headers, body: JSON.parse(String(init?.body)) };
      const ok = sseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]);
      return ok;
    }) as unknown as typeof fetch;

    const out = await runAnthropicWebSearch(
      "latest bun release",
      "anthropic",
      anthropicProvider,
      { model: "claude-sonnet-5", reasoning: "low", timeoutMs: 5000, describeImages: false },
    );
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("ok");

    const c = captured!;
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    expect(c.headers["authorization"]).toBe("Bearer test-token-xyz");
    expect(c.headers["anthropic-beta"]).toContain("oauth");
    expect(c.headers["anthropic-version"]).toBe("2023-06-01");
    expect(c.headers["x-app"]).toBe("cli");
    expect(c.headers["x-claude-code-session-id"]).toBeDefined();
    expect(c.body.model).toBe("claude-sonnet-5");
    expect(c.body.max_tokens).toBe(8192);
    expect(c.body.thinking).toEqual({ type: "disabled" });
    const system = c.body.system as { type: string; text: string }[];
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
    const tools = c.body.tools as { type: string; name: string; max_uses: number }[];
    expect(tools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });
});
