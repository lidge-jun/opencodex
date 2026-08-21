import { afterEach, describe, expect, mock, test } from "bun:test";
import * as storeModule from "../src/oauth/store";

let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean }>; activeAccountId?: string }> = {};
mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? null,
}));
import * as oauthModule from "../src/oauth";
mock.module("../src/oauth", () => ({
  ...oauthModule,
  getValidAccessToken: async () => "test-token-xyz",
}));

import { parseXaiResponsesSSE, validateXaiSearchOptions } from "../src/web-search/xai-executor";
import { findXaiSidecarProvider, planWebSearch, xaiSearchOptionsFromConfig } from "../src/web-search";
import { MAX_SIDECAR_RESPONSE_BYTES } from "../src/web-search/parse";
import { parseRequest } from "../src/responses/parser";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routed: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "k" };
const xaiProvider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "routed", providers: { routed, xai: xaiProvider }, ...overrides };
}
function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "search", stream: true, tools: [{ type: "web_search" }] });
}
afterEach(() => { accountSets = {}; });

describe("validateXaiSearchOptions (doc limits)", () => {
  test("21 handles rejected; 20 accepted", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => "h" + i);
    expect(validateXaiSearchOptions({ allowedXHandles: twenty })).toBeUndefined();
    expect(validateXaiSearchOptions({ allowedXHandles: [...twenty, "extra"] })).toContain("at most 20");
  });
  test("allow XOR exclude; ISO dates", () => {
    expect(validateXaiSearchOptions({ allowedXHandles: ["a"], excludedXHandles: ["b"] })).toContain("mutually exclusive");
    expect(validateXaiSearchOptions({ fromDate: "08/21/2026" })).toContain("ISO-8601");
    expect(validateXaiSearchOptions({ fromDate: "2026-08-21", toDate: "2026-08-22" })).toBeUndefined();
  });
});

function sse(frames: Array<Record<string, unknown>>): Response {
  const body = frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }));
}

describe("parseXaiResponsesSSE (live capture shapes, devlog 003)", () => {
  test("text assembly + sources from annotations ∪ action.sources, deduped", async () => {
    const out = await parseXaiResponsesSSE(sse([
      { type: "response.output_text.delta", delta: "xAI shipped " },
      { type: "response.output_text.delta", delta: "a thing." },
      { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://x.ai/news", title: "1" } },
      { type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q", sources: [{ type: "url", url: "https://x.ai/news" }, { type: "url", url: "https://x.ai/company" }] } } },
      { type: "response.output_text.done", text: "xAI shipped a thing." },
      { type: "response.completed" },
    ]));
    expect(out.text).toBe("xAI shipped a thing.");
    expect(out.sources.map(s => s.url).sort()).toEqual(["https://x.ai/company", "https://x.ai/news"]);
    expect(out.error).toBeUndefined();
  });

  test("custom_tool_call items tolerated; absent action tolerated", async () => {
    const out = await parseXaiResponsesSSE(sse([
      { type: "response.output_item.added", item: { type: "web_search_call", id: "ws_2", status: "in_progress" } },
      { type: "response.output_item.done", item: { type: "custom_tool_call", id: "ctc_1", call_id: "xs_call-1", name: "x_user_search", input: "{}", status: "completed" } },
      { type: "response.output_text.delta", delta: "posts found" },
      { type: "response.completed" },
    ]));
    expect(out.text).toBe("posts found");
    expect(out.error).toBeUndefined();
  });

  test("upstream failure with no text -> error outcome, never throws", async () => {
    const out = await parseXaiResponsesSSE(sse([
      { type: "response.failed", response: { error: { message: "entitlement denied" } } },
    ]));
    expect(out.text).toBe("");
    expect(out.error).toContain("entitlement");
  });

  test("oversized stream cancels the upstream body", async () => {
    let canceled = false;
    const chunk = new Uint8Array(MAX_SIDECAR_RESPONSE_BYTES);
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    }));

    const out = await parseXaiResponsesSSE(response);

    expect(out.error).toContain("byte bound");
    expect(canceled).toBe(true);
  });
});

describe("planWebSearch xai arm (L7)", () => {
  test("explicit xai + usable Grok OAuth -> plan with xaiSidecar and grok-4.6 default", () => {
    accountSets = { xai: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    const cfg = config({ webSearchSidecar: { backend: "xai" } });
    const plan = planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined);
    expect(plan?.backend).toBe("xai");
    expect(plan?.xaiSidecar?.providerName).toBe("xai");
    expect(plan?.settings.model).toBe("grok-4.6");
  });

  test("explicit xai without credential fails closed (no plan)", () => {
    const cfg = config({ webSearchSidecar: { backend: "xai" } });
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined)).toBeUndefined();
  });

  test("invalid persisted xSearch options fail closed at plan time", () => {
    accountSets = { xai: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    const cfg = config({ webSearchSidecar: { backend: "xai", xSearch: { enabled: true, allowedXHandles: ["a"], excludedXHandles: ["b"] } } });
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined)).toBeUndefined();
  });

  test("xaiSearchOptionsFromConfig lifts only enabled blocks", () => {
    expect(xaiSearchOptionsFromConfig({})).toEqual({});
    expect(xaiSearchOptionsFromConfig({ xSearch: { enabled: false, allowedXHandles: ["a"] } })).toEqual({});
    expect(xaiSearchOptionsFromConfig({ xSearch: { enabled: true, allowedXHandles: ["a"], fromDate: "2026-08-01" } }))
      .toEqual({ xSearch: true, allowedXHandles: ["a"], fromDate: "2026-08-01" });
  });

  test("findXaiSidecarProvider: disabled/key-auth/reauth all fail", () => {
    accountSets = { xai: { accounts: [{ id: "a1", needsReauth: true }], activeAccountId: "a1" } };
    expect(findXaiSidecarProvider(config())).toBeUndefined();
    accountSets = { xai: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
    expect(findXaiSidecarProvider(config({ providers: { routed, xai: { ...xaiProvider, disabled: true } } }))).toBeUndefined();
    expect(findXaiSidecarProvider(config({ providers: { routed, xai: { ...xaiProvider, authMode: "key", apiKey: "k" } } }))).toBeUndefined();
    expect(findXaiSidecarProvider(config())?.providerName).toBe("xai");
  });
});

describe("credential pinning + loop fail-closed (review blockers)", () => {
  test("lookalike origin https://api.x.ai.evil never receives the bearer (falls back to canonical)", async () => {
    const captured: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 401 });
    }) as typeof fetch;
    try {
      const evil: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.x.ai.evil/v1", authMode: "oauth" };
      const { runXaiWebSearch } = await import("../src/web-search/xai-executor");
      const out = await runXaiWebSearch("q", "xai", evil, { model: "grok-4.6", reasoning: "low", timeoutMs: 5000, describeImages: false }, {});
      expect(captured.length).toBeGreaterThanOrEqual(1);
      for (const url of captured) expect(new URL(url).origin).toBe("https://api.x.ai");
      expect(out.error).toContain("401");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

import { runWithWebSearch, type WebSearchLoopDeps } from "../src/web-search/loop";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { AdapterEvent, ProviderAdapter } from "../src/adapters/base";

describe("loop dispatch: xai arm fails closed without a sidecar (review blocker)", () => {
  test("missing xaiSidecar yields the invariant error tool-result; forward executor and pool recorder untouched", async () => {
    const firstPass: AdapterEvent[] = [
      { type: "tool_call_start", id: "ws1", name: "web_search" },
      { type: "tool_call_delta", arguments: "{\"query\":\"docs\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    let pass = 0;
    let sawToolResult = "";
    const adapter: ProviderAdapter = {
      name: "two-pass",
      buildRequest: (parsed) => {
        if (pass > 0) sawToolResult = JSON.stringify(parsed.context.messages ?? parsed);
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        const events = pass++ === 0 ? firstPass : [{ type: "text_delta", text: "answer" } as AdapterEvent, { type: "done" } as AdapterEvent];
        for (const event of events) yield event;
      },
      async parseResponse() { throw new Error("unreachable"); },
    };
    const capturedForwardFetches: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedForwardFetches.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    let poolRecorded = 0;
    try {
      const response = await runWithWebSearch({
        parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
        adapter,
        backend: "xai",
        // xaiSidecar deliberately ABSENT — the invariant violation under test.
        hostedTool: { type: "web_search" },
        selectedForwardHeaders: new Headers({ authorization: "Bearer forward-secret" }),
        settings: { model: "grok-4.6", reasoning: "low", timeoutMs: 5000, describeImages: false },
        maxSearches: 1,
        recordSidecarOutcome: () => { poolRecorded += 1; },
        incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      } satisfies WebSearchLoopDeps);
      // Drain the SSE so the loop completes.
      await new Response(response.body).text();
      // No network fetch may have carried the forward headers (executors were never invoked).
      expect(capturedForwardFetches).toEqual([]);
      // The pool recorder belongs to the OpenAI executor path only.
      expect(poolRecorded).toBe(0);
      // The second pass received the graceful error tool result.
      expect(sawToolResult).toContain("without a resolved Grok OAuth provider");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
