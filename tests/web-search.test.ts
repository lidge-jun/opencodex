import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { planWebSearch, shouldResolveOpenAiWebSearchSidecar, webSearchStallTimeoutSec } from "../src/web-search";
import { runWithWebSearch as runWithWebSearchProduction, type WebSearchLoopDeps } from "../src/web-search/loop";
import { runWebSearch as runOpenAiWebSearch } from "../src/web-search/executor";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { headersForCodexAuthContext } from "../src/codex/auth-context";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar } from "../src/providers/openai-sidecar";
import { handleResponses } from "../src/server/responses/core";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../src/types";
import type { AdapterFetchContext, ProviderAdapter } from "../src/adapters/base";
import type { OcxMessage, OcxParsedRequest } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { withUpstreamHttpVersion } from "../src/lib/upstream-http-version";

/**
 * Wrap a fetch so it applies the provider's HTTP-version pin the way `providerFetch` does in
 * production. The reset-recovery tests need a provider-scoped executor that pins a protocol, so the
 * composition order in the loop leg is observable without standing up the whole server path.
 */
function withUpstreamHttpVersionExecutor(
  inner: typeof globalThis.fetch,
  provider: Pick<OcxProviderConfig, "upstreamHttpVersion">,
): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    inner(input, withUpstreamHttpVersion(input, init, provider))) as typeof globalThis.fetch;
}

/** Run the web-search loop with a default test translator budget. */
function runWithWebSearch(
  deps: Omit<WebSearchLoopDeps, "incomingMeta"> & { incomingMeta?: WebSearchLoopDeps["incomingMeta"] },
): Promise<Response> {
  return runWithWebSearchProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

describe("issue #1001 — forced-answer passes must produce usable output", () => {
  const webSearchFirstPass: AdapterEvent[] = [
    { type: "tool_call_start", id: "ws1", name: "web_search" },
    { type: "tool_call_delta", arguments: "{\"q\":\"docs\"}" },
    { type: "tool_call_end" },
    { type: "done" },
  ];

  function twoPassAdapter(secondPass: AdapterEvent[]): ProviderAdapter {
    let pass = 0;
    return {
      name: "two-pass",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        const events = pass++ === 0 ? webSearchFirstPass : secondPass;
        for (const event of events) yield event;
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
  }

  async function drive(secondPass: AdapterEvent[]) {
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: twoPassAdapter(secondPass),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    return collectSse(response.body!);
  }

  test("a malformed forced-answer tool call (blank id/name) becomes response.failed, never completed", async () => {
    const frames = await drive([
      { type: "tool_call_start", id: "", name: "" },
      { type: "tool_call_delta", arguments: "{\"x\":1}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("an unterminated tool call on the forced pass is malformed", async () => {
    const frames = await drive([
      { type: "tool_call_start", id: "c1", name: "shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"" },
      { type: "done" },
    ]);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("a forced pass with no text and no tool call becomes response.failed", async () => {
    const frames = await drive([{ type: "done" }]);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("commentary-only output does not satisfy the forced pass", async () => {
    const frames = await drive([
      { type: "text_delta", text: "thinking out loud", phase: "commentary" },
      { type: "done" },
    ]);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("visible text on the forced pass completes normally", async () => {
    const frames = await drive([
      { type: "text_delta", text: "final answer" },
      { type: "done" },
    ]);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
  });

  test("a valid closed non-web tool call without text is allowed to complete", async () => {
    const frames = await drive([
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
    expect(frames.some(frame => frame.event === "response.failed")).toBe(false);
  });
});

const routedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "routed-key",
};

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: {
      routed: routedProvider,
      chatgpt: forwardProvider,
    },
    ...overrides,
  };
}

function parsedWithWebSearch() {
  return parseRequest({
    model: "routed/model",
    input: "Search for current docs",
    stream: true,
    tools: [
      { type: "web_search", search_context_size: "medium" },
      { type: "function", name: "read_file", description: "Read file", parameters: {} },
    ],
  });
}

describe("web-search sidecar planning", () => {
  test("canonical sidecar discovery defaults only an omitted OpenAI auth mode to forward", () => {
    const canonicalWithoutAuthMode: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex///",
          codexAccountMode: "direct",
        },
      },
    };
    expect(listOpenAiForwardSidecarCandidates(canonicalWithoutAuthMode)).toMatchObject([{
      providerName: "openai",
      provider: {
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      accountMode: "direct",
    }]);

    for (const openai of [
      { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "key" },
      { adapter: "openai-chat", baseUrl: "https://chatgpt.com/backend-api/codex" },
      { adapter: "openai-responses", baseUrl: "https://proxy.example.test/v1" },
    ] satisfies OcxProviderConfig[]) {
      expect(listOpenAiForwardSidecarCandidates({
        ...canonicalWithoutAuthMode,
        providers: { openai },
      })).toEqual([]);
    }
  });

  test("central Direct sidecar selection never treats a proxy admission bearer as Codex auth", async () => {
    const cfg: OcxConfig = {
      port: 10100,
      defaultProvider: "routed",
      providers: {
        routed: routedProvider,
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
      apiKeys: [{ id: "admission", name: "Admission", key: "proxy-secret", createdAt: "2026-07-17" }],
    };
    const resolved = await resolveFirstUsableOpenAiSidecar(
      listOpenAiForwardSidecarCandidates(cfg),
      new Headers({ authorization: "Bearer proxy-secret", "x-opencodex-api-key": "proxy-secret" }),
      cfg,
    );
    expect(resolved).toBeUndefined();
  });

  test("central Direct sidecar selection requires a canonical ChatGPT account-bearing bearer", async () => {
    const cfg: OcxConfig = {
      port: 10100,
      defaultProvider: "routed",
      providers: {
        routed: routedProvider,
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    };
    const opaque = await resolveFirstUsableOpenAiSidecar(
      listOpenAiForwardSidecarCandidates(cfg),
      new Headers({ authorization: "Bearer sk-provider-secret", "chatgpt-account-id": "acct-forged" }),
      cfg,
    );
    expect(opaque).toBeUndefined();

    const mismatched = await resolveFirstUsableOpenAiSidecar(
      listOpenAiForwardSidecarCandidates(cfg),
      new Headers({
        authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-jwt" })}`,
        "chatgpt-account-id": "acct-other",
      }),
      cfg,
    );
    expect(mismatched).toBeUndefined();
  });

  test("central Direct sidecar selection requires an explicit matching ChatGPT account header", async () => {
    const cfg: OcxConfig = {
      port: 10100,
      defaultProvider: "routed",
      providers: {
        routed: routedProvider,
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    };
    const token = fakeChatGptJwt({ chatgpt_account_id: "acct-jwt" });
    const missingHeader = await resolveFirstUsableOpenAiSidecar(
      listOpenAiForwardSidecarCandidates(cfg),
      new Headers({ authorization: `Bearer ${token}` }),
      cfg,
    );
    expect(missingHeader).toBeUndefined();

    const resolved = await resolveFirstUsableOpenAiSidecar(
      listOpenAiForwardSidecarCandidates(cfg),
      new Headers({
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": "acct-jwt",
      }),
      cfg,
    );
    expect(resolved).toBeDefined();
    expect(resolved?.authContext).toEqual({ kind: "main", accountId: null });
    expect(resolved?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(resolved?.headers.get("chatgpt-account-id")).toBe("acct-jwt");
  });

  test("sidecar auth stays lazy when search is absent, disabled, or native-passthrough", () => {
    const parsed = parsedWithWebSearch();
    expect(shouldResolveOpenAiWebSearchSidecar(config(), { ...parsed, _webSearch: undefined }, false)).toBe(false);
    expect(shouldResolveOpenAiWebSearchSidecar(config({ webSearchSidecar: { enabled: false } }), parsed, false)).toBe(false);
    expect(shouldResolveOpenAiWebSearchSidecar(config(), parsed, true)).toBe(false);
    expect(shouldResolveOpenAiWebSearchSidecar(config(), parsed, false)).toBe(true);
  });

  test("parseRequest stashes hosted web_search while keeping normal tools", () => {
    const parsed = parsedWithWebSearch();

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.context.tools?.map(t => t.name)).toEqual(["read_file"]);
  });

  test("planWebSearch activates only for routed requests with forward auth and incoming authorization", () => {
    const parsed = parsedWithWebSearch();
    const sidecar = {
      providerName: "openai" as const,
      provider: forwardProvider,
      accountMode: "direct" as const,
      authContext: { kind: "main" as const, accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }),
    };
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      routedProvider,
      "model",
      sidecar,
    );

    expect(plan).toBeDefined();
    expect(plan?.forwardSidecar).toBe(sidecar);
    expect(plan?.hostedTool).toEqual(parsed._webSearch);
    expect(plan?.settings.model).toBe("gpt-5.6-luna");
  });

  test("planWebSearch never arms a sidecar excluded by tool_choice", () => {
    const parsed = parsedWithWebSearch();
    const sidecar = {
      providerName: "openai" as const,
      provider: forwardProvider,
      accountMode: "direct" as const,
      authContext: { kind: "main" as const, accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }),
    };
    const plan = () => planWebSearch(config(), parsed, false, routedProvider, "model", sidecar);

    parsed.options.toolChoice = "none";
    expect(plan()).toBeUndefined();
    parsed.options.toolChoice = { name: "read_file" };
    expect(plan()).toBeUndefined();
    parsed.options.toolChoice = { allowedTools: ["read_file"], mode: "required" };
    expect(plan()).toBeUndefined();

    parsed.options.toolChoice = { name: "web_search" };
    expect(plan()).toBeDefined();
    parsed.options.toolChoice = { allowedTools: ["web_search"], mode: "required" };
    expect(plan()).toBeDefined();
  });

  test("planWebSearch activates for pool-selected headers even when raw inbound auth would be main", () => {
    const parsed = parsedWithWebSearch();
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );
    const plan = planWebSearch(
      config(),
      parsed,
      false,
      routedProvider,
      "model",
      {
        providerName: "openai",
        provider: forwardProvider,
        accountMode: "pool",
        authContext: { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
        headers: selectedHeaders,
      },
    );

    expect(plan).toBeDefined();
    expect(selectedHeaders.get("authorization")).toBe("Bearer pool-token");
    expect(selectedHeaders.get("chatgpt-account-id")).toBe("pool_acc");
  });

  test("planWebSearch suppresses sidecar predictably when prerequisites are absent", () => {
    const parsed = parsedWithWebSearch();

    expect(planWebSearch(config(), parsed, true, routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config(), parsed, false, routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config({ webSearchSidecar: { enabled: false } }), parsed, false, routedProvider, "model")).toBeUndefined();
    expect(planWebSearch(config(), { ...parsed, _webSearch: undefined }, false, routedProvider, "model")).toBeUndefined();
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("issue #2885 — Zhipu-shaped web-search routing preserves the provider HTTP version pin", async () => {
  let routedProtocol: string | undefined;
  let routedBody: Record<string, unknown> | undefined;
  const zhipuProvider = {
    adapter: "openai-chat",
    baseUrl: "https://zhipu.test/v4",
    apiKey: "zhipu-key",
    upstreamHttpVersion: "http1.1",
    models: ["glm-4.7"],
    liveModels: false,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      routedProtocol = (init as RequestInit & { protocol?: string } | undefined)?.protocol;
      routedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const cfg: OcxConfig = {
    port: 10100,
    defaultProvider: "zhipu",
    providers: {
      zhipu: zhipuProvider,
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  };
  globalThis.fetch = (async () => {
    throw new Error("the routed web-search leg must use the provider fetch");
  }) as typeof fetch;

  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-zhipu-search" })}`,
      "chatgpt-account-id": "acct-zhipu-search",
    },
    body: JSON.stringify({
      model: "zhipu/glm-4.7",
      input: "Search current docs",
      stream: true,
      tools: [{ type: "web_search" }],
    }),
  }), cfg, { model: "", provider: "" });

  expect(response.status).toBe(200);
  const frames = await collectSse(response.body!);
  expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  expect((routedBody?.tools as { function?: { name?: string } }[] | undefined)
    ?.some(tool => tool.function?.name === "web_search")).toBe(true);
  expect(routedProtocol).toBe("http1.1");
});

test("web-search adapters receive the provider-scoped fetch executor", async () => {
  let routedProtocol: string | undefined;
  const pinnedProvider = {
    adapter: "openai-chat",
    baseUrl: "https://routed.test/v1",
    apiKey: "routed-key",
    upstreamHttpVersion: "http1.1",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      routedProtocol = (init as RequestInit & { protocol?: string } | undefined)?.protocol;
      return new Response("wire", { status: 200 });
    }) as typeof fetch,
  } satisfies OcxProviderConfig & { fetch: typeof fetch };
  const adapter: ProviderAdapter = {
    name: "executor-aware",
    buildRequest: (_parsed, incoming) => {
      expect(incoming.providerFetch).toBeDefined();
      return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: (request, ctx) => ctx!.executor!(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: ctx?.abortSignal,
    }),
    async *parseStream() {
      yield { type: "text_delta", text: "done" };
      yield { type: "done" };
    },
  };

  const response = await runWithWebSearch({
    parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
    adapter,
    incomingMeta: {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
      providerFetch: providerFetch(pinnedProvider),
    },
    forwardProvider,
    hostedTool: { type: "web_search" },
    selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
    settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
    maxSearches: 1,
  });

  expect(response.status).toBe(200);
  await collectSse(response.body!);
  expect(routedProtocol).toBe("http1.1");
});

test("OpenAI web-search execution uses the pinned canonical URL and selected credentials", async () => {
  const cfg = config({
    providers: {
      routed: routedProvider,
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex///",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  });
  const candidate = listOpenAiForwardSidecarCandidates(cfg)[0]!;
  let observedUrl = "";
  let observedHeaders = new Headers();
  let observedProtocol: string | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    observedHeaders = new Headers(init?.headers);
    observedProtocol = (init as RequestInit & { protocol?: string } | undefined)?.protocol;
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  await runOpenAiWebSearch(
    "current docs",
    { type: "web_search" },
    { ...candidate.provider, upstreamHttpVersion: "http1.1" },
    new Headers({ authorization: "Bearer selected-token", "chatgpt-account-id": "selected-account" }),
    { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
  );

  expect(observedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(observedHeaders.get("authorization")).toBe("Bearer selected-token");
  expect(observedHeaders.get("chatgpt-account-id")).toBe("selected-account");
  expect(observedProtocol).toBe("http1.1");
});

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

function hangUntilAbort(ctx?: AdapterFetchContext): Promise<Response> {
  const signal = ctx?.abortSignal;
  return new Promise((_resolve, reject) => {
    const rejectAborted = () => {
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(reason ? String(reason) : "aborted"));
    };
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener("abort", rejectAborted, { once: true });
  });
}

/** Adapter whose first streamed pass returns the events, and every later (forceAnswer) pass a text answer. */
function scriptedAdapter(firstPass: AdapterEvent[]): ProviderAdapter {
  let pass = 0;
  return {
    name: "mock",
    buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
    async *parseStream() {
      const events: AdapterEvent[] = pass++ === 0
        ? firstPass
        : [{ type: "text_delta", text: "final answer" }, { type: "done" }];
      for (const event of events) yield event;
      if (!events.some(event => event.type === "done" || event.type === "error")) {
        yield { type: "done" };
      }
    },
    async parseResponse() {
      throw new Error("parseResponse must be unreachable");
    },
  };
}

describe("BUG-R86 routed web-search timeout semantics", () => {
  test("web-search-loop SSE snapshots preserve the client-facing model selector", async () => {
    const parsed = parseRequest({
      model: "claude-sonnet-5",
      input: "hi",
      stream: true,
      tools: [{ type: "web_search" }],
    });
    parsed._responseModelId = "anthropic/claude-sonnet-5";
    let upstreamModel = "";
    const adapter: ProviderAdapter = {
      name: "identity",
      buildRequest: request => {
        upstreamModel = request.modelId;
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "answer" };
        yield { type: "done" };
      },
    };
    const response = await runWithWebSearch({
      parsed,
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    const frames = await collectSse(response.body!);
    const models = frames.flatMap(frame => {
      const responseModel = (frame.data.response as { model?: unknown } | undefined)?.model;
      return typeof responseModel === "string" ? [responseModel] : [];
    });

    expect(upstreamModel).toBe("claude-sonnet-5");
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set(["anthropic/claude-sonnet-5"]));
  });

  test("translator overflow remains typed through the sidecar loop and bridge", async () => {
    const adapter: ProviderAdapter = {
      name: "overflow",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield {
          type: "error",
          status: 502,
          errorType: "upstream_error",
          code: "translation_buffer_limit",
          message: "upstream translation buffer exceeded the safe limit",
        };
      },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const failed = frames.filter(frame => frame.event === "response.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0]?.data.response as { error?: { code?: string } }).error?.code)
      .toBe("translation_buffer_limit");
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("Kiro-style commentary streams before the iteration finishes", async () => {
    let releaseIteration: () => void = () => {};
    const iterationGate = new Promise<void>(resolve => { releaseIteration = resolve; });
    const adapter: ProviderAdapter = {
      name: "kiro-commentary",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "Hi from Kiro", phase: "commentary" };
        await iterationGate;
        yield { type: "done" };
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (let reads = 0; reads < 10 && !text.includes("Hi from Kiro"); reads++) {
        const result = await Promise.race([
          reader.read(),
          new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 250)),
        ]);
        expect(result).not.toBe("timeout");
        if (result === "timeout" || result.done) break;
        text += decoder.decode(result.value, { stream: true });
      }
      expect(text).toContain("Hi from Kiro");
    } finally {
      releaseIteration();
    }

    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    expect(text).toContain("event: response.completed");
  });

  test("routed iterations isolate diagnostic failures and never call parseResponse", async () => {
    const seenStream: boolean[] = [];
    const reasoningLogs: unknown[] = [];
    let parseStreamCalls = 0;
    let parseResponseCalls = 0;
    const adapter: ProviderAdapter = {
      name: "stream-only",
      buildRequest(parsed) {
        seenStream.push(parsed.stream);
        return {
          url: "https://routed.test/v1",
          method: "POST",
          headers: {},
          body: "{}",
          reasoningLog: {
            effectiveEffort: "high",
            wireField: "reasoning_effort",
            wireValue: "high",
          },
        };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        parseStreamCalls++;
        yield { type: "text_delta", text: "healthy" };
        yield { type: "done" };
      },
      async parseResponse() {
        parseResponseCalls++;
        throw new Error("parseResponse must be unreachable");
      },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      onRequestBuilt: request => {
        reasoningLogs.push(request.reasoningLog);
        throw new Error("diagnostic hook failure must not abort delivery");
      },
    });

    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(seenStream).toEqual([true]);
    expect(reasoningLogs).toEqual([{
      effectiveEffort: "high",
      wireField: "reasoning_effort",
      wireValue: "high",
    }]);
    expect(parseStreamCalls).toBe(1);
    expect(parseResponseCalls).toBe(0);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  });

  test("fast headers plus raw byte progress can outlive connectTimeoutMs", async () => {
    const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    let bodyCancelled = 0;
    const adapter: ProviderAdapter = {
      name: "slow-healthy-stream",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async (_request, ctx) => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of ["a", "b", "c", "d", "e"]) {
              await delay(12);
              if (ctx?.abortSignal?.aborted) {
                controller.error(ctx.abortSignal.reason);
                return;
              }
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
          cancel() { bodyCancelled++; },
        });
        return new Response(body, { status: 200 });
      },
      async *parseStream(response) {
        expect(await response.text()).toBe("abcde");
        yield { type: "text_delta", text: "healthy after slow generation" };
        yield { type: "done" };
      },
      async parseResponse(response) {
        await response.text();
        return [{ type: "text_delta", text: "legacy non-stream result" }, { type: "done" }];
      },
    };

    const started = performance.now();
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 25,
    });

    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(bodyCancelled).toBe(0);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  }, 1_000);

  test("a buffered web_search followed by error never dispatches the hosted sidecar", async () => {
    let sidecarCalls = 0;
    globalThis.fetch = (async () => {
      sidecarCalls++;
      return new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"must not run"}\n\n'
          + 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    let streamPass = 0;
    let responsePass = 0;
    const badPass: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_bad", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "must not run" }) },
      { type: "tool_call_end" },
      { type: "error", message: "routed model failed" },
    ];
    const finalPass: AdapterEvent[] = [
      { type: "text_delta", text: "fallback answer" },
      { type: "done" },
    ];
    const adapter: ProviderAdapter = {
      name: "search-then-error",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        const events = streamPass++ === 0 ? badPass : finalPass;
        for (const event of events) yield event;
      },
      async parseResponse() {
        return responsePass++ === 0 ? badPass : finalPass;
      },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    expect(sidecarCalls).toBe(0);
    expect(frames.filter(frame => frame.event === "response.failed")).toHaveLength(1);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });
});

describe("web-search sidecar native web_search_call emission", () => {
  test("loop 429 awaits OAuth on429 rotation and succeeds with the rebuilt adapter", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    // First adapter always 429s via fetchResponse; the rotated adapter answers.
    const reasoningLogs: unknown[] = [];
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest: () => ({
        url: "https://routed.test/v1",
        method: "POST",
        headers: {},
        body: "{}",
        reasoningLog: {
          effectiveEffort: "low",
          wireField: "reasoning_effort",
          wireValue: "low",
        },
      }),
      fetchResponse: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "text_delta", text: "should not reach" }, { type: "done" }] as AdapterEvent[]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "mock-rotated",
      buildRequest: () => ({
        url: "https://routed.test/v1",
        method: "POST",
        headers: {},
        body: "{}",
        reasoningLog: {
          effectiveEffort: "high",
          wireField: "reasoning_effort",
          wireValue: "high",
        },
      }),
      fetchResponse: async () => new Response("{}", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "answer from rotated key" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };
    let rotations = 0;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      onRequestBuilt: request => reasoningLogs.push(request.reasoningLog),
      on429: async retryAfter => {
        rotations++;
        expect(retryAfter).toBe("30");
        await Promise.resolve();
        return rotatedAdapter;
      },
    });
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as { type: string; content?: { text?: string }[] }[];
    expect(output.find(o => o.type === "message")?.content?.[0]?.text).toBe("answer from rotated key");
    expect(rotations).toBe(1);
    expect(reasoningLogs).toEqual([
      {
        effectiveEffort: "low",
        wireField: "reasoning_effort",
        wireValue: "low",
      },
      {
        effectiveEffort: "high",
        wireField: "reasoning_effort",
        wireValue: "high",
      },
    ]);
  });

  test("retryOn429 replays on the same key before on429 rotation", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    let sends = 0;
    let rotations = 0;
    let retrySends = 0;
    let builds = 0;
    const retryingAdapter: ProviderAdapter = {
      name: "mock-retry429",
      buildRequest: () => {
        builds += 1;
        return {
          url: "https://routed.test/v1",
          method: "POST",
          headers: {},
          body: "{}",
        };
      },
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
        }
        return new Response("{}", { status: 200 });
      },
      async *parseStream() {
        yield { type: "text_delta", text: "answer after same-key retry" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: retryingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      retryOn429Policy: { enabled: true, attempts: 2, intervalMs: 120, maxIntervalMs: 60_000, respectRetryAfter: false },
      on429: () => {
        rotations += 1;
        return null;
      },
      onAttemptSend: recovery => {
        if (recovery === "rate-limit-429") retrySends += 1;
      },
    });
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as { type: string; content?: { text?: string }[] }[];
    expect(output.find(o => o.type === "message")?.content?.[0]?.text).toBe("answer after same-key retry");
    expect(sends).toBe(2);
    expect(rotations).toBe(0);
    expect(retrySends).toBe(1);
    // Same-target replay reuses the ONE built request (builder runs once per target sequence).
    expect(builds).toBe(1);
  });

  test("retry wait longer than the stall budget still succeeds (heartbeats feed the watchdog)", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    let sends = 0;
    const retryingAdapter: ProviderAdapter = {
      name: "mock-retry429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
        }
        return new Response("{}", { status: 200 });
      },
      async *parseStream() {
        yield { type: "text_delta", text: "answer after long backoff" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: retryingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      stallTimeoutSec: 1,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1_500, maxIntervalMs: 60_000, respectRetryAfter: false },
    });
    const frames = await collectSse(response.body!);
    // A 1.5s backoff under a 1s stall budget must not trip upstream_stall_timeout.
    expect(sends).toBe(2);
    expect(frames.find(f => f.event === "response.completed")).toBeDefined();
    expect(frames.find(f => f.event === "response.failed")).toBeUndefined();
  }, 5_000);

  test("retry wait longer than connectTimeoutMs restarts the header deadline (no 504)", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    ))) as typeof fetch;

    let sends = 0;
    const retryingAdapter: ProviderAdapter = {
      name: "mock-retry429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
        }
        return new Response("{}", { status: 200 });
      },
      async *parseStream() {
        yield { type: "text_delta", text: "answer after deadline restart" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: retryingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 100,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 150, maxIntervalMs: 60_000, respectRetryAfter: false },
    });
    const frames = await collectSse(response.body!);
    // The deliberate backoff must not consume the response-header deadline: a fresh deadline is
    // armed after the wait, so the replay gets a new connect budget instead of a 504.
    expect(sends).toBe(2);
    expect(frames.find(f => f.event === "response.completed")).toBeDefined();
    expect(frames.find(f => f.event === "response.failed")).toBeUndefined();
  }, 5_000);

  test("retryOn429 budget is shared across iterations (per request, not per round)", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses: return a minimal completed SSE so the search round advances.
      return Promise.resolve(new Response(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    let sends = 0;
    let retrySends = 0;
    let rotations = 0;
    const retryingAdapter: ProviderAdapter = {
      name: "mock-retry429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => {
        sends += 1;
        if (sends === 1 || sends === 3) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
        }
        return new Response("{}", { status: 200 });
      },
      async *parseStream() {
        if (sends === 2) {
          // Round 0 success carries a web_search call so the loop advances to a forced-answer round.
          yield { type: "tool_call_start", id: "call_1", name: "web_search" };
          yield { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) };
          yield { type: "tool_call_end" };
        } else {
          yield { type: "text_delta", text: "unused" };
        }
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: retryingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 50, maxIntervalMs: 60_000, respectRetryAfter: false },
      on429: () => {
        rotations += 1;
        return null;
      },
      onAttemptSend: recovery => {
        if (recovery === "rate-limit-429") retrySends += 1;
      },
    });
    const frames = await collectSse(response.body!);
    expect(sends).toBe(3);
    expect(retrySends).toBe(1);
    expect(rotations).toBe(1);
    const failed = frames.find(f => f.event === "response.failed")?.data.response as { error?: { message?: string } } | undefined;
    expect(failed?.error?.message ?? "").toContain("429");
  });

  test("loop 429 with exhausted pool (on429 null) surfaces the provider error", async () => {
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("rate limited", { status: 429 }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      on429: () => null,
    });
    expect(response.status).toBe(429);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("429");
  });

  test("loop per-iteration timeout surfaces 504 instead of hanging", async () => {
    const hangingAdapter: ProviderAdapter = {
      name: "mock-hang",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_req, ctx) => hangUntilAbort(ctx),
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: hangingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 100,
    });
    expect(response.status).toBe(504);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("timeout");
  }, 1_000);

  test("loop reuses one iteration deadline signal across 429 rotation", async () => {
    let firstSignal: AbortSignal | undefined;
    const firstAdapter: ProviderAdapter = {
      name: "mock-429",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async (_req, ctx) => {
        firstSignal = ctx?.abortSignal;
        return new Response("rate limited", { status: 429 });
      },
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };
    const rotatedAdapter: ProviderAdapter = {
      name: "mock-rotated-hang",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_req, ctx) => {
        expect(ctx?.abortSignal).toBe(firstSignal);
        return hangUntilAbort(ctx);
      },
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: firstAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 100,
      on429: () => rotatedAdapter,
    });
    expect(response.status).toBe(504);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message ?? "").toContain("timeout");
  }, 1_000);

  test("loop propagates parent abort into a hanging iteration", async () => {
    const parent = new AbortController();
    let resolveSignal!: (signal: AbortSignal) => void;
    const receivedSignal = new Promise<AbortSignal>(resolve => { resolveSignal = resolve; });
    const hangingAdapter: ProviderAdapter = {
      name: "mock-parent-abort",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: (_req, ctx) => {
        if (ctx?.abortSignal) resolveSignal(ctx.abortSignal);
        return hangUntilAbort(ctx);
      },
      async *parseStream() { /* unused */ },
      async parseResponse() { return [{ type: "done" }] as AdapterEvent[]; },
    };

    const pending = runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: hangingAdapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      connectTimeoutMs: 30_000,
      abortSignal: parent.signal,
    });
    const iterationSignal = await receivedSignal;
    parent.abort(new DOMException("superseded", "AbortError"));

    const response = await pending;
    expect(iterationSignal.aborted).toBe(true);
    expect(response.status).toBe(499);
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toBe("client closed request during web-search");
  }, 1_000);

  test("signed thinking before a web_search call survives into the replayed assistant turn", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const seenBodies: OcxMessage[][] = [];
    let pass = 0;
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: (p: OcxParsedRequest) => {
        seenBodies.push(p.context.messages);
        return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
      },
      async *parseStream() {
        pass++;
        if (pass === 1) {
          const events: AdapterEvent[] = [
            { type: "thinking_delta", thinking: "I should search" },
            { type: "thinking_signature", signature: "RealSig1234567890==" },
            { type: "tool_call_start", id: "call_t", name: "web_search" },
            { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
            { type: "tool_call_end" },
            { type: "done" },
          ];
          for (const event of events) yield event;
          return;
        }
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const parsed = parseRequest({ model: "routed/model", input: "look up docs", stream: true, tools: [{ type: "web_search" }] });
    parsed._clientThreadId = "web-search-raw-replay";
    parsed._reasoningReplayScope = {
      clientThreadId: parsed._clientThreadId,
      current: {
        providerName: "routed",
        providerDestinationIdentity: "destination:routed",
        adapterName: adapter.name,
        modelId: "model",
        credentialIdentity: "key:test",
      },
    };
    const response = await runWithWebSearch({
      parsed,
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 2,
    });
    await collectSse(response.body!);

    // The second iteration's request must replay the assistant turn as [thinking, toolCall].
    const replayMessages = seenBodies.at(-1)!;
    const assistant = replayMessages.find(m => m.role === "assistant"
      && Array.isArray(m.content) && (m.content as { type: string }[]).some(c => c.type === "toolCall"));
    expect(assistant).toBeDefined();
    const content = assistant!.content as { type: string; thinking?: string; signature?: string }[];
    expect(content[0].type).toBe("thinking");
    expect(content[0].thinking).toBe("I should search");
    expect(content[0].signature).toBe("RealSig1234567890==");
    expect(content[1].type).toBe("toolCall");
  });

  // #688: DeepSeek V4 and other OpenAI-compatible providers emit reasoning_raw_delta rather than
  // signed thinking. Dropping it left the replayed turn as a bare tool call, which the provider
  // rejected — surfacing downstream as a 502 because the loop drops the LoopError status.
  test("raw reasoning before a web_search call is replayed as an unsigned thinking part", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const seenBodies: OcxMessage[][] = [];
    let pass = 0;
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: (p: OcxParsedRequest) => {
        seenBodies.push(p.context.messages);
        return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
      },
      async *parseStream() {
        pass++;
        if (pass === 1) {
          const events: AdapterEvent[] = [
            { type: "reasoning_raw_delta", text: "I should " },
            { type: "reasoning_raw_delta", text: "search the docs" },
            { type: "tool_call_start", id: "call_raw", name: "web_search" },
            { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
            { type: "tool_call_end" },
            { type: "done" },
          ];
          for (const event of events) yield event;
          return;
        }
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "look up docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 2,
    });
    await collectSse(response.body!);

    // Locate the replayed turn by its tool-call id so unrelated history cannot satisfy this.
    const replayMessages = seenBodies.at(-1)!;
    const assistant = replayMessages.find(m => m.role === "assistant"
      && Array.isArray(m.content)
      && (m.content as { type: string; id?: string }[]).some(c => c.type === "toolCall" && c.id === "call_raw"));
    expect(assistant).toBeDefined();
    const content = assistant!.content as { type: string; thinking?: string; signature?: string }[];
    expect(content[0].type).toBe("thinking");
    expect(content[0].thinking).toBe("I should search the docs");
    // Raw reasoning is NOT signed: presenting it as signed would corrupt the Anthropic contract.
    expect(content[0].signature).toBeUndefined();
    expect(content[1].type).toBe("toolCall");
  });

  // A signature authenticates the exact block it closed, so each block must keep its own pairing.
  // Flattening two blocks under the last signature is what src/images/loop.ts already guards.
  test("multiple signed thinking blocks keep their own signatures across a web_search replay", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const seenBodies: OcxMessage[][] = [];
    let pass = 0;
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: (p: OcxParsedRequest) => {
        seenBodies.push(p.context.messages);
        return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
      },
      async *parseStream() {
        pass++;
        if (pass === 1) {
          const events: AdapterEvent[] = [
            { type: "redacted_thinking", data: "d1" },
            { type: "thinking_delta", thinking: "first" },
            { type: "thinking_signature", signature: "RealSigAAAAAAAAAA==" },
            { type: "thinking_delta", thinking: "second" },
            { type: "thinking_signature", signature: "RealSigBBBBBBBBBB==" },
            { type: "reasoning_raw_delta", text: "raw" },
            { type: "tool_call_start", id: "call_multi", name: "web_search" },
            { type: "tool_call_delta", arguments: JSON.stringify({ query: "docs" }) },
            { type: "tool_call_end" },
            { type: "done" },
          ];
          for (const event of events) yield event;
          return;
        }
        yield { type: "text_delta", text: "final" };
        yield { type: "done" };
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "look up docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 2,
    });
    await collectSse(response.body!);

    const replayMessages = seenBodies.at(-1)!;
    const assistant = replayMessages.find(m => m.role === "assistant"
      && Array.isArray(m.content)
      && (m.content as { type: string; id?: string }[]).some(c => c.type === "toolCall" && c.id === "call_multi"));
    expect(assistant).toBeDefined();
    const content = assistant!.content as { type: string; thinking?: string; signature?: string; redacted?: string[] }[];
    expect(content).toHaveLength(5);
    expect(content[0]).toEqual({ type: "thinking", thinking: "", redacted: ["d1"] });
    expect(content[1]).toEqual({ type: "thinking", thinking: "first", signature: "RealSigAAAAAAAAAA==" });
    expect(content[2]).toEqual({ type: "thinking", thinking: "second", signature: "RealSigBBBBBBBBBB==" });
    expect(content[3]).toEqual({ type: "thinking", thinking: "raw" });
    expect(content[4].type).toBe("toolCall");
  });

  // The user-visible failure lives at the SERIALIZER boundary: openai-chat only emits
  // reasoning_content for models in preserveReasoningContentModels, and only from thinking parts.
  // The mock-adapter tests above prove the replay SHAPE; this one proves the wire contract, so a
  // regression that drops reasoning_content on the second request cannot pass unnoticed.
  test("a reasoning_content provider receives raw reasoning beside the replayed tool_calls", async () => {
    const routedBodies: Record<string, unknown>[] = [];
    let routedPass = 0;
    globalThis.fetch = ((input, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) {
        routedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        routedPass++;
        const sse = routedPass === 1
          ? 'data: {"choices":[{"delta":{"reasoning_content":"I should search the docs"}}]}\n\n'
            + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ds","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":\\"docs\\"}"}}]}}]}\n\n'
            + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
            + "data: [DONE]\n\n"
          : 'data: {"choices":[{"delta":{"content":"final"}}]}\n\n'
            + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            + "data: [DONE]\n\n";
        return Promise.resolve(new Response(sse, { headers: { "Content-Type": "text/event-stream" } }));
      }
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    // modelInList matches EXACTLY, so the provider list and the request model must agree verbatim.
    const deepseekProvider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://routed.test/v1",
      apiKey: "routed-key",
      preserveReasoningContentModels: ["deepseek-v4-flash"],
    };

    const parsed = parseRequest({ model: "deepseek-v4-flash", input: "look up docs", stream: true, tools: [{ type: "web_search" }] });
    parsed._clientThreadId = "web-search-deepseek-replay";
    parsed._reasoningReplayScope = {
      clientThreadId: parsed._clientThreadId,
      current: {
        providerName: "routed",
        providerDestinationIdentity: "destination:deepseek",
        adapterName: "openai-chat",
        modelId: "deepseek-v4-flash",
        credentialIdentity: "key:test",
      },
    };
    const response = await runWithWebSearch({
      parsed,
      adapter: createOpenAIChatAdapter(deepseekProvider),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 2,
    });
    await collectSse(response.body!);

    expect(routedBodies).toHaveLength(2);
    const replay = routedBodies[1]!.messages as {
      role: string; content?: unknown; reasoning_content?: string;
      tool_calls?: { id: string; function: { name: string } }[];
    }[];
    const assistant = replay.find(m => m.role === "assistant" && m.tool_calls?.some(tc => tc.id === "call_ds"));
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe("I should search the docs");
    expect(assistant!.tool_calls).toHaveLength(1);
    expect(assistant!.tool_calls![0]!.function.name).toBe("web_search");
  });

  test("an executed search emits a web_search_call item ahead of the assistant message", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses: return a minimal completed SSE with answer text
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.map(item => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]).toMatchObject({ type: "web_search_call", action: { type: "search", query: "current docs" } });
  });

  test("empty-query and limit placeholders do NOT emit a web_search_call item", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    // First pass: an empty-query web_search call (handled by the empty-query branch, never hits the sidecar).
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "go", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_empty", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output.some(item => item.type === "web_search_call")).toBe(false);
    expect(output.map(item => item.type)).toEqual(["message"]);
  });
});

/** Adapter that records the messages handed to it on each pass (forced-answer nudge assertion). */
function capturingAdapter(firstPass: AdapterEvent[]): { adapter: ProviderAdapter; messagesPerPass: OcxMessage[][] } {
  const messagesPerPass: OcxMessage[][] = [];
  let pass = 0;
  const adapter: ProviderAdapter = {
    name: "mock",
    buildRequest: (parsed: OcxParsedRequest) => {
      messagesPerPass.push(parsed.context.messages);
      return { url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" };
    },
    async *parseStream() {
      const events: AdapterEvent[] = pass++ === 0
        ? firstPass
        : [{ type: "text_delta", text: "final answer" }, { type: "done" }];
      for (const event of events) yield event;
      if (!events.some(event => event.type === "done" || event.type === "error")) {
        yield { type: "done" };
      }
    },
    async parseResponse() { throw new Error("parseResponse must be unreachable"); },
  };
  return { adapter, messagesPerPass };
}

/** Drain an SSE body so iterations that run live inside the stream actually execute. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("web-search forced-answer nudge", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("forced pass appends exactly one developer nudge after a real search, without mutating shared messages", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const { adapter, messagesPerPass } = capturingAdapter([
      { type: "tool_call_start", id: "call_1", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
      { type: "tool_call_end" },
    ]);
    const parsed = parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] });
    const baselineUserMessages = parsed.context.messages.length;

    const response = await runWithWebSearch({
      parsed,
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    // Iteration 2 (the forced-answer pass) runs live inside the SSE body — drain it so it executes.
    await drain(response.body!);

    // Pass 1 (search) has no nudge; pass 2 (forced answer) ends with exactly one developer nudge.
    expect(messagesPerPass.length).toBe(2);
    expect(messagesPerPass[0].some(m => m.role === "developer")).toBe(false);
    const forced = messagesPerPass[1];
    const developerMsgs = forced.filter(m => m.role === "developer");
    expect(developerMsgs.length).toBe(1);
    expect(forced[forced.length - 1].role).toBe("developer");
    // The nudge is iteration-local: the shared/persisted message list is never grown by it.
    expect(parsed.context.messages.length).toBe(baselineUserMessages);
    expect(parsed.context.messages.some(m => m.role === "developer")).toBe(false);
  });

  test("a run with only an empty-query placeholder gets NO forced-answer nudge", async () => {
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const { adapter, messagesPerPass } = capturingAdapter([
      { type: "tool_call_start", id: "call_empty", name: "web_search" },
      { type: "tool_call_delta", arguments: JSON.stringify({ query: "" }) },
      { type: "tool_call_end" },
    ]);
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "go", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    await drain(response.body!);

    // Every pass is nudge-free because no real sidecar search ran (executedSearches stayed empty).
    for (const msgs of messagesPerPass) {
      expect(msgs.some(m => m.role === "developer")).toBe(false);
    }
  });
});

describe("web-search live spinner ordering", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("the in_progress added frame is emitted BEFORE the sidecar search resolves", async () => {
    // Gate the sidecar response so the search stays pending until we choose to release it.
    let releaseSidecar: () => void = () => {};
    const sidecarGate = new Promise<void>(resolve => { releaseSidecar = resolve; });
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar: resolve only after the gate opens.
      return sidecarGate.then(() => new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"docs say X"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    // Read frames incrementally. The added(in_progress) web_search_call must arrive while the
    // sidecar promise is still gated; only after we see it do we release the sidecar.
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawInProgress = false;
    let releasedAt = -1;
    const order: string[] = [];
    for (let reads = 0; reads < 200; reads++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").find(l => l.startsWith("data: "))?.slice(6);
        if (!data) continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(data); } catch { continue; }
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "web_search_call") {
          order.push(`${parsed.type}:${item.status}`);
          if (parsed.type === "response.output_item.added" && item.status === "in_progress") {
            sawInProgress = true;
            releasedAt = order.length;
            releaseSidecar(); // open the gate ONLY after the spinner frame is observed
          }
        }
      }
    }

    expect(sawInProgress).toBe(true);
    // The added(in_progress) frame came first, and we released the sidecar only after seeing it —
    // proving the spinner is live, not flashed back-to-back with done.
    expect(order[0]).toBe("response.output_item.added:in_progress");
    expect(order).toContain("response.output_item.done:completed");
    expect(releasedAt).toBe(1);
  });
});

describe("web-search batched queries", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a single call with queries[] runs each query and emits ONE cell carrying all queries", async () => {
    const sidecarQueries: string[] = [];
    globalThis.fetch = ((input, init) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar: capture the query the proxy asked for, return a minimal answer.
      try {
        const body = JSON.parse(String(init?.body ?? "{}"));
        // Sidecar query lives at input[0].content[0].text (see src/web-search/executor.ts).
        const text = body?.input?.[0]?.content?.[0]?.text;
        if (typeof text === "string") sidecarQueries.push(text);
      } catch { /* ignore */ }
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ans"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "compare", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_b", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ queries: ["rust async", "tokio runtime"] }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 3,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    // Exactly ONE web_search_call cell, ahead of the message, carrying both queries (native plural).
    const cells = output.filter(item => item.type === "web_search_call");
    expect(cells.length).toBe(1);
    expect(cells[0]).toMatchObject({ action: { type: "search", queries: ["rust async", "tokio runtime"] } });
    // Both queries actually hit the sidecar.
    expect(sidecarQueries.some(q => q.includes("rust async"))).toBe(true);
    expect(sidecarQueries.some(q => q.includes("tokio runtime"))).toBe(true);
  });
});

describe("web-search sources -> url_citation annotations", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a search's sources land as url_citation annotations on the assistant message", async () => {
    // Sidecar returns answer text plus a url_citation annotation in the completed output[].
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      const completed = {
        type: "response.completed",
        response: {
          output: [{
            type: "message", role: "assistant",
            content: [{
              type: "output_text", text: "Node 24 is LTS.",
              annotations: [{ type: "url_citation", url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases" }],
            }],
          }],
        },
      };
      return Promise.resolve(new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Node 24 is LTS."}\n\n' +
          `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "node lts?", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_s", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "node lts" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([{
      type: "url_citation", url: "https://nodejs.org/en/about/previous-releases", title: "Node.js Releases", start_index: 0, end_index: 0,
    }]);
  });

  test("real-world: empty annotations + body Sources block still produce url_citation annotations", async () => {
    // Mirrors the actual OpenAI hosted web_search wire shape captured in dumps: annotations:[] and a
    // trailing markdown Sources block in the answer text.
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      const answer = "Node 24.18.0 is the latest LTS.\n\nSources:\n" +
        "- Node.js Download page: https://nodejs.org/en/download/current\n" +
        "- Node.js release archive: https://nodejs.org/en/download/archive/current";
      const completed = {
        type: "response.completed",
        response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: answer }] }] },
      };
      return Promise.resolve(new Response(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "node lts?", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_s2", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "node lts" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([
      { type: "url_citation", url: "https://nodejs.org/en/download/current", title: "Node.js Download page", start_index: 0, end_index: 0 },
      { type: "url_citation", url: "https://nodejs.org/en/download/archive/current", title: "Node.js release archive", start_index: 0, end_index: 0 },
    ]);
  });

  test("a turn with no search keeps empty annotations", async () => {
    globalThis.fetch = ((input) => {
      const u = String(input);
      if (u.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
    }) as typeof fetch;
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([{ type: "text_delta", text: "no search needed" }, { type: "done" }]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([]);
  });
});

describe("web-search batched sources -> url_citation annotations", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("a batched call dedupes duplicate sources across queries by URL", async () => {
    // Both queries' sidecar answers cite the SAME url; only one url_citation must survive.
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      const answer = "Shared finding.\n\nSources:\n" +
        "- Shared doc: https://shared.test/doc\n" +
        "- Unique: https://shared.test/uniqueA";
      const completed = {
        type: "response.completed",
        response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: answer }] }] },
      };
      return Promise.resolve(new Response(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "compare", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_dup", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ queries: ["q one", "q two"] }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 3,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    // Both queries returned the same shared.test/doc, so it appears exactly once.
    expect(part.annotations).toEqual([
      { type: "url_citation", url: "https://shared.test/doc", title: "Shared doc", start_index: 0, end_index: 0 },
      { type: "url_citation", url: "https://shared.test/uniqueA", title: "Unique", start_index: 0, end_index: 0 },
    ]);
  });

  test("a partial failure still surfaces the successful query's sources", async () => {
    // First sidecar call fails (HTTP 500), second succeeds with a real Sources block. The batch is a
    // partial success, so the surviving query's citation must still reach the assistant message.
    let sidecarCall = 0;
    globalThis.fetch = ((input) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      sidecarCall++;
      if (sidecarCall === 1) return Promise.resolve(new Response("upstream boom", { status: 500 }));
      const answer = "Recovered.\n\nSources:\n- Good doc: https://ok.test/doc";
      const completed = {
        type: "response.completed",
        response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: answer }] }] },
      };
      return Promise.resolve(new Response(
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "compare", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_partial", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ queries: ["fails first", "works second"] }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 3,
    });

    const frames = await collectSse(response.body!);
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    // The cell is still "completed" because one query succeeded.
    const cell = output.find(item => item.type === "web_search_call") as Record<string, unknown>;
    expect(cell.status).toBe("completed");
    const message = output.find(item => item.type === "message") as Record<string, unknown>;
    const part = (message.content as Record<string, unknown>[])[0];
    expect(part.annotations).toEqual([
      { type: "url_citation", url: "https://ok.test/doc", title: "Good doc", start_index: 0, end_index: 0 },
    ]);
  });
});

describe("web-search stall deadline", () => {
  test("planWebSearch computes the effective stall deadline covering bounded silent units", () => {
    const parsed = parsedWithWebSearch();
    const auth = new Headers({ authorization: "Bearer chatgpt" });
    // defaults: max(300 bridge, connect 200s, sidecar 200s) + 30 margin
    expect(planWebSearch(config(), parsed, false, auth, routedProvider, "model")?.stallTimeoutSec).toBe(330);
    // a larger user-configured stallTimeoutSec dominates
    expect(planWebSearch(config({ stallTimeoutSec: 600 }), parsed, false, auth, routedProvider, "model")?.stallTimeoutSec).toBe(630);
    // small unit budgets -> the bridge's 300s default dominates
    expect(planWebSearch(
      config({
        connectTimeoutMs: 30_000,
        webSearchSidecar: { timeoutMs: 30_000, routedModelStallTimeoutMs: 30_000 },
      }),
      parsed, false, auth, routedProvider, "model",
    )?.stallTimeoutSec).toBe(330);
  });

  test("webSearchStallTimeoutSec helper covers the largest bounded unit plus margin", () => {
    expect(webSearchStallTimeoutSec(undefined, undefined, 200_000)).toBe(330);
    expect(webSearchStallTimeoutSec(90, 200_000, 200_000)).toBe(230);
    expect(webSearchStallTimeoutSec(600, 200_000, 200_000)).toBe(630);
    expect(webSearchStallTimeoutSec(undefined, 30_000, 30_000)).toBe(330);
  });

  test("#398: the default sidecar search deadline is bounded (60s, not 200s)", () => {
    const parsed = parsedWithWebSearch();
    const auth = new Headers({ authorization: "Bearer chatgpt" });
    // With no explicit webSearchSidecar.timeoutMs, the plan must carry the lowered 60s default so
    // an unavailable/limit-exhausted backend degrades within ~1 min instead of the old 200s hang.
    const plan = planWebSearch(config(), parsed, false, auth, routedProvider, "model");
    expect(plan?.settings.timeoutMs).toBe(60_000);
    // An explicit override still wins.
    const overridden = planWebSearch(
      config({ webSearchSidecar: { timeoutMs: 90_000 } }),
      parsed, false, auth, routedProvider, "model",
    );
    expect(overridden?.settings.timeoutMs).toBe(90_000);
  });

  test("threaded stallTimeoutSec reaches the bridge: a hung sidecar trips upstream_stall_timeout", async () => {
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses hangs until aborted (stall must fire first: sidecar budget is 600s)
      return new Promise<Response>((_, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "Search for current docs", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_1", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "current docs" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 600_000 },
      maxSearches: 1,
      // Bridge clamps to >= 1s and checks on its 2s tick: the hung search dies on the first
      // silent tick (~4s), proving deps.stallTimeoutSec actually reaches bridgeToResponsesSSE.
      stallTimeoutSec: 1,
    });
    const frames = await collectSse(response.body!);
    const incomplete = frames.find(f => f.event === "response.incomplete");
    expect(incomplete).toBeDefined();
    const resp = incomplete!.data.response as { incomplete_details?: { reason?: string } };
    expect(resp.incomplete_details?.reason).toBe("upstream_stall_timeout");
  }, 15_000);
});

describe("#398 sidecar failure degradation", () => {
  test("an unexpectedly thrown sidecar degrades to a failed cell and a completed turn", async () => {
    // The executors are 'never throws', but the loop must enforce that contract: even a thrown
    // sidecar becomes a failed tool result and the routed model still answers (no 499/502).
    globalThis.fetch = ((input: unknown) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) return Promise.resolve(new Response("{}", { status: 200 }));
      // sidecar /responses throws synchronously (simulates an unexpected executor throw carrying a secret)
      throw new Error("boom LEAKMARKER_should_not_appear");
    }) as typeof fetch;

    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "search please", stream: true, tools: [{ type: "web_search" }] }),
      adapter: scriptedAdapter([
        { type: "tool_call_start", id: "call_boom", name: "web_search" },
        { type: "tool_call_delta", arguments: JSON.stringify({ query: "anything" }) },
        { type: "tool_call_end" },
      ]),
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });

    const frames = await collectSse(response.body!);
    // The turn completes normally — no response.failed.
    expect(frames.find(f => f.event === "response.completed")).toBeDefined();
    expect(frames.find(f => f.event === "response.failed")).toBeUndefined();
    // The failed search cell is present and marked failed.
    const completed = frames.find(f => f.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    const cell = output.find(item => item.type === "web_search_call") as Record<string, unknown> | undefined;
    expect(cell?.status).toBe("failed");
    // The raw thrown message (fake secret) must never leak into any SSE frame.
    const raw = frames.map(f => JSON.stringify(f.data)).join("");
    expect(raw.includes("LEAKMARKER_should_not_appear")).toBe(false);
  });
});

describe("web-search sidecar live streaming (streamRoutedModelOutput)", () => {
  /** Incremental SSE frame reader so tests can observe delivery ORDER relative to adapter progress. */
  function frameReader(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const frames: { event?: string; data: Record<string, unknown> }[] = [];
    const parse = (frame: string) => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      if (dataLine?.slice(6) === "[DONE]") return undefined;
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    };
    return {
      frames,
      /** Read until a frame matches, or the stream ends. Returns the matching frame or undefined. */
      async readUntil(match: (f: { event?: string; data: Record<string, unknown> }) => boolean) {
        for (const f of frames) if (match(f)) return f;
        while (true) {
          const { done, value } = await reader.read();
          if (done) return undefined;
          buffered += decoder.decode(value, { stream: true });
          const parts = buffered.split("\n\n");
          buffered = parts.pop() ?? "";
          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const parsed = parse(trimmed);
            if (!parsed) continue;
            frames.push(parsed);
            if (match(parsed)) return parsed;
          }
        }
      },
      async drain() {
        await this.readUntil(() => false);
        return frames;
      },
    };
  }

  const outputTextOf = (frames: { event?: string; data: Record<string, unknown> }[]): string =>
    frames
      .filter(f => f.data.type === "response.output_text.delta")
      .map(f => String(f.data.delta ?? ""))
      .join("");

  /**
   * Bound a readUntil wait with a deadline that REJECTS. The deadline must never release an
   * adapter gate: doing so would let a buffered implementation pass via the terminal replay.
   */
  const within = async <T>(wait: Promise<T>, what: string): Promise<T> => {
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${what} — output was not delivered live`)),
        5_000,
      );
    });
    try {
      return await Promise.race([wait, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  test("leading text deltas stream live: the client sees them while the adapter is still mid-turn", async () => {
    // The adapter blocks after its first delta until the TEST has observed that delta on the wire.
    // Buffered delivery would deadlock here; the rejecting 5s deadline turns that into a failure.
    let releaseAdapter!: () => void;
    const clientSawFirstDelta = new Promise<void>(resolve => { releaseAdapter = resolve; });
    const adapter: ProviderAdapter = {
      name: "gated",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "Hello " } satisfies AdapterEvent;
        await clientSawFirstDelta;
        yield { type: "text_delta", text: "World" } satisfies AdapterEvent;
        yield { type: "done" } satisfies AdapterEvent;
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      streamRoutedModelOutput: true,
    });
    const sse = frameReader(response.body!);
    const first = await within(
      sse.readUntil(f => f.data.type === "response.output_text.delta"),
      "the first live text delta",
    );
    expect(first?.data.delta).toBe("Hello ");
    releaseAdapter();
    const frames = await sse.drain();
    // Every delta exactly once — the terminal replay must skip what already streamed.
    expect(outputTextOf(frames)).toBe("Hello World");
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
  });

  test("leading reasoning deltas stream live: the client sees them while the adapter is still mid-turn", async () => {
    // Same gate as the text test, but for the reasoning path: thinking_delta must reach the
    // client as response.reasoning_summary_text.delta before the adapter is allowed to finish.
    let releaseAdapter!: () => void;
    const clientSawFirstReasoning = new Promise<void>(resolve => { releaseAdapter = resolve; });
    const adapter: ProviderAdapter = {
      name: "gated-reasoning",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield { type: "thinking_delta", thinking: "Considering " } satisfies AdapterEvent;
        await clientSawFirstReasoning;
        yield { type: "thinking_delta", thinking: "options" } satisfies AdapterEvent;
        yield { type: "text_delta", text: "Answer" } satisfies AdapterEvent;
        yield { type: "done" } satisfies AdapterEvent;
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
    const response = await runWithWebSearch({
      // Without reasoning.summary the parser sets hideThinkingSummary and no reasoning frame is
      // ever client-visible; "auto" matches what Codex sends on real turns.
      parsed: parseRequest({
        model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }],
        reasoning: { summary: "auto" },
      }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      streamRoutedModelOutput: true,
    });
    const sse = frameReader(response.body!);
    const first = await within(
      sse.readUntil(f => f.data.type === "response.reasoning_summary_text.delta"),
      "the first live reasoning delta",
    );
    expect(first?.data.delta).toBe("Considering ");
    releaseAdapter();
    const frames = await sse.drain();
    // Each reasoning delta exactly once — the terminal replay must not duplicate the streamed head.
    const reasoning = frames
      .filter(f => f.data.type === "response.reasoning_summary_text.delta")
      .map(f => String(f.data.delta ?? ""))
      .join("");
    expect(reasoning).toBe("Considering options");
    expect(outputTextOf(frames)).toBe("Answer");
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
  });

  test("default (flag unset) keeps full buffering: no text reaches the client before the adapter finishes", async () => {
    let adapterFinished = false;
    const adapter: ProviderAdapter = {
      name: "paced",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "Hello " } satisfies AdapterEvent;
        await new Promise(resolve => setTimeout(resolve, 100));
        yield { type: "text_delta", text: "World" } satisfies AdapterEvent;
        adapterFinished = true;
        yield { type: "done" } satisfies AdapterEvent;
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
    });
    const sse = frameReader(response.body!);
    const first = await sse.readUntil(f => f.data.type === "response.output_text.delta");
    // By the time the FIRST delta is visible, the adapter must already be past its last delta.
    expect(adapterFinished).toBe(true);
    expect(first).toBeDefined();
    const frames = await sse.drain();
    expect(outputTextOf(frames)).toBe("Hello World");
  });

  test("the live window closes at the first tool_call_start; the buffered tail replays once, in order", async () => {
    // The adapter withholds the tool call until the TEST has seen "prefix " on the wire, so a
    // buffered implementation (which delivers nothing before the terminal replay) deadlocks the
    // gate instead of passing on identical final frames.
    let releaseToolCall!: () => void;
    const clientSawPrefix = new Promise<void>(resolve => { releaseToolCall = resolve; });
    const adapter: ProviderAdapter = {
      name: "tool-tail",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        yield { type: "text_delta", text: "prefix " } satisfies AdapterEvent;
        await clientSawPrefix;
        yield { type: "tool_call_start", id: "call_1", name: "shell" } satisfies AdapterEvent;
        yield { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"}" } satisfies AdapterEvent;
        yield { type: "tool_call_end" } satisfies AdapterEvent;
        yield { type: "text_delta", text: "suffix" } satisfies AdapterEvent;
        yield { type: "done" } satisfies AdapterEvent;
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      streamRoutedModelOutput: true,
    });
    const sse = frameReader(response.body!);
    const prefixDelta = await within(
      sse.readUntil(f => f.data.type === "response.output_text.delta"),
      "the live prefix delta before the tool call",
    );
    expect(prefixDelta?.data.delta).toBe("prefix ");
    releaseToolCall();
    const frames = await sse.drain();
    expect(outputTextOf(frames)).toBe("prefix suffix");
    // The real tool call still reaches the client exactly once, and the replayed tail keeps
    // wire order: prefix delta → function_call item → suffix delta.
    const isCallAdd = (f: { data: Record<string, unknown> }) =>
      f.data.type === "response.output_item.added"
      && (f.data.item as Record<string, unknown> | undefined)?.type === "function_call";
    expect(frames.filter(isCallAdd).length).toBe(1);
    const prefixIdx = frames.findIndex(f => f.data.type === "response.output_text.delta" && f.data.delta === "prefix ");
    const callIdx = frames.findIndex(isCallAdd);
    const suffixIdx = frames.findIndex(f => f.data.type === "response.output_text.delta" && f.data.delta === "suffix");
    expect(prefixIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(prefixIdx);
    expect(suffixIdx).toBeGreaterThan(callIdx);
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
  });

  test("search loop: pre-search text streams live (documented tradeoff), the final answer arrives once", async () => {
    // The first pass withholds its web_search call until the TEST has seen "Let me check. " on
    // the wire — a buffered implementation would deadlock the gate rather than pass on final
    // frames alone.
    let releaseWebSearch!: () => void;
    const clientSawPreSearchText = new Promise<void>(resolve => { releaseWebSearch = resolve; });
    let pass = 0;
    const adapter: ProviderAdapter = {
      name: "search-then-answer",
      buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        if (pass++ === 0) {
          yield { type: "text_delta", text: "Let me check. " } satisfies AdapterEvent;
          await clientSawPreSearchText;
          yield { type: "tool_call_start", id: "ws1", name: "web_search" } satisfies AdapterEvent;
          yield { type: "tool_call_delta", arguments: "{\"query\":\"docs\"}" } satisfies AdapterEvent;
          yield { type: "tool_call_end" } satisfies AdapterEvent;
          yield { type: "done" } satisfies AdapterEvent;
        } else {
          yield { type: "text_delta", text: "Final answer." } satisfies AdapterEvent;
          yield { type: "done" } satisfies AdapterEvent;
        }
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
    const response = await runWithWebSearch({
      parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
      adapter,
      forwardProvider: { ...forwardProvider, baseUrl: "https://chatgpt.test/v1" },
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      streamRoutedModelOutput: true,
    });
    const sse = frameReader(response.body!);
    const preSearchDelta = await within(
      sse.readUntil(f => f.data.type === "response.output_text.delta"),
      "the live pre-search text delta",
    );
    expect(preSearchDelta?.data.delta).toBe("Let me check. ");
    releaseWebSearch();
    const frames = await sse.drain();
    const text = outputTextOf(frames);
    // Pre-search text is visible exactly once, then the post-search answer exactly once.
    expect(text).toBe("Let me check. Final answer.");
    expect(frames.some(f => f.event === "response.completed")).toBe(true);
  });
});

describe("connection-reset recovery parity on the web-search legs", () => {
  const originalGlobalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalGlobalFetch; });

  /** Bun's reset rejection shape, as matched by isConnectionResetError. */
  function bunResetError(): Error {
    return new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  }

  type Observed = { keepalive: unknown; connection: string | null; protocol: string | undefined; body: unknown; redirect: string | undefined };

  function observe(init: RequestInit | undefined): Observed {
    const withExtras = init as (RequestInit & { keepalive?: unknown; protocol?: string }) | undefined;
    return {
      keepalive: withExtras?.keepalive,
      connection: new Headers(init?.headers).get("connection"),
      protocol: withExtras?.protocol,
      body: init?.body,
      redirect: init?.redirect,
    };
  }

  test("the sidecar leg replays a reset on a fresh connection while keeping the provider HTTP version pin", async () => {
    const attempts: Observed[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      attempts.push(observe(init));
      if (attempts.length === 1) throw bunResetError();
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    await runOpenAiWebSearch(
      "current docs",
      { type: "web_search" },
      {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        upstreamHttpVersion: "http1.1",
      },
      new Headers({ authorization: "Bearer selected-token" }),
      { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
    );

    expect(attempts.length).toBe(2);
    // The first attempt must NOT force a fresh connection: pooling is the normal, faster path.
    expect(attempts[0]!.keepalive).toBeUndefined();
    expect(attempts[0]!.connection).toBeNull();
    // The replay must leave the half-closed pooled socket. `keepalive: false` is the field that
    // actually does it — Bun has ignored a bare `Connection: close` (oven-sh/bun#20492) — so
    // assert both rather than treating the header as sufficient.
    expect(attempts[1]!.keepalive).toBe(false);
    expect(attempts[1]!.connection).toBe("close");
    // Composition order guard: recovery must not displace the protocol pin, or a user who set
    // http1.1 to work around a transport failure loses it on exactly the retry that needs it.
    expect(attempts[0]!.protocol).toBe("http1.1");
    expect(attempts[1]!.protocol).toBe("http1.1");
    // Credential-boundary and replayability fields survive the composition.
    expect(attempts[1]!.redirect).toBe("manual");
    expect(typeof attempts[1]!.body).toBe("string");
  });

  test("the routed loop leg replays a reset on a fresh connection through the provider-scoped fetch", async () => {
    const attempts: Observed[] = [];
    const routedProvider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://routed.test/v1",
      apiKey: "routed-key",
      upstreamHttpVersion: "http1.1",
    };
    const providerScopedFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      attempts.push(observe(init));
      if (attempts.length === 1) throw bunResetError();
      return new Response(
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    globalThis.fetch = (async () => {
      throw new Error("the routed leg must use the provider-scoped fetch, not the global one");
    }) as typeof fetch;

    const parsed = parseRequest({ model: "routed/model", input: "search please", stream: true });
    const response = await runWithWebSearch({
      parsed,
      adapter: createOpenAIChatAdapter(routedProvider),
      hostedTool: { type: "web_search" },
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 1_000 },
      maxSearches: 1,
      selectedForwardHeaders: new Headers(),
      forwardProvider: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
      incomingMeta: {
        headers: new Headers(),
        translatorBudget: createTestTranslatorBudget(),
        providerFetch: withUpstreamHttpVersionExecutor(providerScopedFetch, routedProvider),
      },
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]!.keepalive).toBeUndefined();
    expect(attempts[0]!.connection).toBeNull();
    expect(attempts[1]!.keepalive).toBe(false);
    expect(attempts[1]!.connection).toBe("close");
    expect(attempts[1]!.protocol).toBe("http1.1");
    // The loop sets accept-encoding: identity so raw byte progress stays observable; the recovery
    // helper clones headers into a Headers instance and must not drop it.
    expect(typeof attempts[1]!.body).toBe("string");
  });
});

