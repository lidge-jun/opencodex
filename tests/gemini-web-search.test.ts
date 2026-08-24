import { afterEach, describe, expect, mock, test } from "bun:test";
import * as storeModule from "../src/oauth/store";
import { MAX_SIDECAR_RESPONSE_BYTES } from "../src/web-search/parse";

let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean; credential?: Record<string, unknown> }>; activeAccountId?: string }> = {};
mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? null,
}));

import { mapCcaGroundedResponse } from "../src/web-search/gemini-executor";
import { findGeminiSidecarProvider, mediaBridgeWillRun, planWebSearch, resolveCcaInTurnGrounding } from "../src/web-search";
import { planImageBridge, planVideoBridge } from "../src/images";
import { parseRequest } from "../src/responses/parser";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routed: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "k" };
const cca: OcxProviderConfig = { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" };
const antigravityRouted: OcxProviderConfig = {
  adapter: "google",
  googleMode: "cloud-code-assist",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  project: "proj-1",
  apiKey: "token",
};
const openAiSidecar = { provider: routed, headers: { Authorization: "Bearer chatgpt" } };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "routed", providers: { routed, "google-antigravity": cca }, ...overrides };
}
function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "search", stream: true, tools: [{ type: "web_search" }] });
}
let accessSnapshot = {
  provider: "google-antigravity",
  accountId: "a1",
  generation: "generation-a",
  accessToken: "gem-token-abc",
  projectId: "proj-9",
};
let afterAccessSnapshot: (() => void) | undefined;

afterEach(() => {
  accountSets = {};
  accessSnapshot = {
    provider: "google-antigravity",
    accountId: "a1",
    generation: "generation-a",
    accessToken: "gem-token-abc",
    projectId: "proj-9",
  };
  afterAccessSnapshot = undefined;
});

describe("mapCcaGroundedResponse (002 live capture shape)", () => {
  test("wrapped response -> text + deduped grounding sources", () => {
    const out = mapCcaGroundedResponse({ response: { candidates: [{
      content: { parts: [{ text: "Google announced " }, { text: "a device." }] },
      groundingMetadata: { webSearchQueries: ["q"], groundingChunks: [
        { web: { uri: "https://blog.google/a", title: "A" } },
        { web: { uri: "https://blog.google/a", title: "A dup" } },
        { web: { uri: "https://blog.google/b" } },
      ], groundingSupports: [{}] },
    }] } });
    expect(out.text).toBe("Google announced a device.");
    expect(out.sources).toEqual([{ url: "https://blog.google/a", title: "A" }, { url: "https://blog.google/b" }]);
    expect(out.error).toBeUndefined();
  });

  test("absent groundingMetadata -> empty sources; empty text -> error outcome", () => {
    const ok = mapCcaGroundedResponse({ candidates: [{ content: { parts: [{ text: "plain" }] } }] });
    expect(ok.sources).toEqual([]);
    expect(ok.error).toBeUndefined();
    const bad = mapCcaGroundedResponse({ candidates: [{ content: { parts: [] } }] });
    expect(bad.error).toContain("no text");
    expect(mapCcaGroundedResponse(null).error).toBeDefined();
    expect(mapCcaGroundedResponse({}).error).toContain("no candidates");
  });

  test("grounding sources are sanitized: non-http URLs, control chars, and oversized values are dropped", () => {
    const out = mapCcaGroundedResponse({ response: { candidates: [{
      content: { parts: [{ text: "answer" }] },
      groundingMetadata: { groundingChunks: [
        { web: { uri: "javascript:alert(1)", title: "xss" } },
        { web: { uri: "https://good.example/a", title: "A" } },
        { web: { uri: "https://good.example/b", title: "B\u0000control" } },
        { web: { uri: "https://good.example/c", title: "C".repeat(10_000) } },
        { web: { uri: "ftp://bad.example/d" } },
        { web: { uri: "  https://whitespace.example/e  " } },
      ] },
    }] } });
    // Non-http(s) schemes, javascript:, and whitespace-padded URLs are dropped entirely.
    // Valid URLs with a control-char or oversized title keep the URL but drop the bad title
    // (matches the shared safe-source validator used across the web-search subsystem).
    expect(out.sources).toEqual([
      { url: "https://good.example/a", title: "A" },
      { url: "https://good.example/b" },
      { url: "https://good.example/c" },
    ]);
    expect(out.error).toBeUndefined();
  });
});

describe("resolveCcaInTurnGrounding / planWebSearch in-turn gate", () => {
  test("Antigravity Gemini 3 with default backend -> in-turn grounding, no sidecar plan", () => {
    const parsed = parsedWithWebSearch();
    expect(resolveCcaInTurnGrounding(config(), parsed, false, antigravityRouted, "gemini-3.7-flash")).toEqual({
      search: true,
      urlContext: false,
    });
    expect(planWebSearch(config(), parsed, false, antigravityRouted, "gemini-3.7-flash", openAiSidecar)).toBeUndefined();
  });

  test("explicit gemini backend on Antigravity Gemini 3 still uses in-turn", () => {
    const parsed = parsedWithWebSearch();
    expect(resolveCcaInTurnGrounding(
      config({ webSearchSidecar: { backend: "gemini" } }),
      parsed,
      false,
      antigravityRouted,
      "gemini-3.7-flash",
    )).toEqual({
      search: true,
      urlContext: false,
    });
    expect(planWebSearch(
      config({ webSearchSidecar: { backend: "gemini" } }),
      parsed,
      false,
      antigravityRouted,
      "gemini-3.7-flash",
      openAiSidecar,
    )).toBeUndefined();
  });

  test("explicit openai backend -> sidecar path, not in-turn", () => {
    const parsed = parsedWithWebSearch();
    expect(resolveCcaInTurnGrounding(
      config({ webSearchSidecar: { backend: "openai" } }),
      parsed,
      false,
      antigravityRouted,
      "gemini-3.7-flash",
    )).toBeUndefined();
    expect(planWebSearch(
      config({ webSearchSidecar: { backend: "openai" } }),
      parsed,
      false,
      antigravityRouted,
      "gemini-3.7-flash",
      openAiSidecar,
    )?.backend).toBe("openai");
  });

  test("Claude-on-CCA never selects in-turn grounding", () => {
    expect(resolveCcaInTurnGrounding(config(), parsedWithWebSearch(), false, antigravityRouted, "claude-sonnet-4-6")).toBeUndefined();
  });

  test("Gemini 2.x with Codex tools stays on sidecar path", () => {
    const parsed = parseRequest({
      model: "gemini-2.0-flash",
      input: "q",
      stream: true,
      tools: [{ type: "web_search" }, { type: "function", name: "shell", parameters: { type: "object" } }],
    });
    expect(resolveCcaInTurnGrounding(config(), parsed, false, antigravityRouted, "gemini-2.0-flash")).toBeUndefined();
  });

  test("Gemini 2.x with only hosted web_search uses in-turn grounding", () => {
    const parsed = parseRequest({
      model: "gemini-2.0-flash",
      input: "q",
      stream: true,
      tools: [{ type: "web_search" }],
    });
    expect(resolveCcaInTurnGrounding(config(), parsed, false, antigravityRouted, "gemini-2.0-flash")).toEqual({
      search: true,
      urlContext: false,
    });
    expect(planWebSearch(config(), parsed, false, antigravityRouted, "gemini-2.0-flash", openAiSidecar)).toBeUndefined();
  });

  test("Gemini 2.x with an active image bridge does not use in-turn grounding", async () => {
    const parsed = parseRequest({
      model: "gemini-2.0-flash",
      input: "q",
      stream: true,
      tools: [
        { type: "web_search" },
        { type: "image_generation", size: "1024x1024" },
      ],
    });
    const mediaConfig = config({
      images: { bridgeEnabled: true },
      providers: {
        ...config().providers,
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
      },
    });
    expect(resolveCcaInTurnGrounding(config(), parsed, false, antigravityRouted, "gemini-2.0-flash")).toEqual({
      search: true,
      urlContext: false,
    });
    const imgPlan = await planImageBridge(mediaConfig, parsed, antigravityRouted);
    expect(imgPlan).toBeDefined();
    const wsPlan = planWebSearch(mediaConfig, parsed, false, antigravityRouted, "gemini-2.0-flash", openAiSidecar, true);
    expect(wsPlan).toBeDefined();
    const mediaWillRun = mediaBridgeWillRun(!!imgPlan, !!wsPlan, true);
    expect(mediaWillRun).toBe(true);
    expect(resolveCcaInTurnGrounding(mediaConfig, parsed, false, antigravityRouted, "gemini-2.0-flash", mediaWillRun)).toBeUndefined();
  });

  test("Gemini 2.x uses in-turn grounding when web search wins over the planned image bridge", async () => {
    const parsed = parseRequest({
      model: "gemini-2.0-flash",
      input: "q",
      stream: true,
      tools: [
        { type: "web_search" },
        { type: "image_generation", size: "1024x1024" },
      ],
    });
    const mediaConfig = config({
      images: { bridgeEnabled: true },
      providers: {
        ...config().providers,
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
      },
    });
    const imgPlan = await planImageBridge(mediaConfig, parsed, antigravityRouted);
    expect(imgPlan).toBeDefined();
    const wsPlan = planWebSearch(mediaConfig, parsed, false, antigravityRouted, "gemini-2.0-flash", openAiSidecar, true);
    expect(wsPlan).toBeDefined();
    const mediaWillRun = mediaBridgeWillRun(!!imgPlan, !!wsPlan, false);
    expect(mediaWillRun).toBe(false);
    expect(resolveCcaInTurnGrounding(mediaConfig, parsed, false, antigravityRouted, "gemini-2.0-flash", mediaWillRun)).toEqual({
      search: true,
      urlContext: false,
    });
  });

  test("Gemini 2.x keeps in-turn grounding for non-streaming video-only requests", async () => {
    const parsed = parseRequest({
      model: "gemini-2.0-flash",
      input: "q",
      stream: false,
      tools: [{ type: "web_search" }],
    });
    const mediaConfig = config({
      images: { videoBridgeEnabled: true },
      providers: {
        ...config().providers,
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
      },
    });
    const videoPlan = await planVideoBridge(mediaConfig, parsed, antigravityRouted);
    expect(videoPlan).toBeDefined();
    const mediaCanInject = mediaBridgeWillRun(!!videoPlan, false, true, parsed.stream);
    expect(mediaCanInject).toBe(false);
    const wsPlan = planWebSearch(
      mediaConfig,
      parsed,
      false,
      antigravityRouted,
      "gemini-2.0-flash",
      openAiSidecar,
      mediaCanInject,
    );
    expect(wsPlan).toBeUndefined();
    expect(resolveCcaInTurnGrounding(
      mediaConfig,
      parsed,
      false,
      antigravityRouted,
      "gemini-2.0-flash",
      mediaCanInject,
    )).toEqual({ search: true, urlContext: false });
  });

  test("Gemini 2.x suppresses in-turn grounding for streaming video injection", async () => {
    const parsed = parseRequest({
      model: "gemini-2.0-flash",
      input: "q",
      stream: true,
      tools: [{ type: "web_search" }],
    });
    const mediaConfig = config({
      images: { videoBridgeEnabled: true },
      providers: {
        ...config().providers,
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
      },
    });
    const videoPlan = await planVideoBridge(mediaConfig, parsed, antigravityRouted);
    expect(videoPlan).toBeDefined();
    const mediaCanInject = mediaBridgeWillRun(!!videoPlan, false, true, parsed.stream);
    expect(mediaCanInject).toBe(true);
    const wsPlan = planWebSearch(
      mediaConfig,
      parsed,
      false,
      antigravityRouted,
      "gemini-2.0-flash",
      openAiSidecar,
      mediaCanInject,
    );
    expect(wsPlan).toBeDefined();
    const mediaWillRun = mediaBridgeWillRun(!!videoPlan, !!wsPlan, true, parsed.stream);
    expect(mediaWillRun).toBe(true);
    expect(resolveCcaInTurnGrounding(
      mediaConfig,
      parsed,
      false,
      antigravityRouted,
      "gemini-2.0-flash",
      mediaWillRun,
    )).toBeUndefined();
  });

  test("Gemini 3.x keeps in-turn grounding when an active media bridge is present", async () => {
    const parsed = parseRequest({
      model: "gemini-3.7-flash",
      input: "q",
      stream: true,
      tools: [
        { type: "web_search" },
        { type: "image_generation", size: "1024x1024" },
      ],
    });
    const mediaConfig = config({
      images: { bridgeEnabled: true },
      providers: {
        ...config().providers,
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
      },
    });
    const imgPlan = await planImageBridge(mediaConfig, parsed, antigravityRouted);
    expect(imgPlan).toBeDefined();
    const wsPlan = planWebSearch(mediaConfig, parsed, false, antigravityRouted, "gemini-3.7-flash", openAiSidecar, true);
    expect(wsPlan).toBeUndefined();
    const mediaWillRun = mediaBridgeWillRun(!!imgPlan, !!wsPlan, true);
    expect(mediaWillRun).toBe(true);
    expect(resolveCcaInTurnGrounding(mediaConfig, parsed, false, antigravityRouted, "gemini-3.7-flash", mediaWillRun)).toEqual({
      search: true,
      urlContext: false,
    });
  });

  test("Gemini 3.x keeps in-turn grounding when web search wins over the planned image bridge", async () => {
    const parsed = parseRequest({
      model: "gemini-3.7-flash",
      input: "q",
      stream: true,
      tools: [
        { type: "web_search" },
        { type: "image_generation", size: "1024x1024" },
      ],
    });
    const mediaConfig = config({
      images: { bridgeEnabled: true },
      providers: {
        ...config().providers,
        xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "xai-key" },
      },
    });
    const imgPlan = await planImageBridge(mediaConfig, parsed, antigravityRouted);
    expect(imgPlan).toBeDefined();
    const wsPlan = planWebSearch(mediaConfig, parsed, false, antigravityRouted, "gemini-3.7-flash", openAiSidecar);
    expect(wsPlan).toBeUndefined();
    const mediaWillRun = mediaBridgeWillRun(!!imgPlan, !!wsPlan, false);
    expect(mediaWillRun).toBe(true);
    expect(resolveCcaInTurnGrounding(mediaConfig, parsed, false, antigravityRouted, "gemini-3.7-flash", mediaWillRun)).toEqual({
      search: true,
      urlContext: false,
    });
  });

  test("url_context when the turn carries an http(s) URL", () => {
    const parsed = parseRequest({
      model: "gemini-3.7-flash",
      input: "read https://example.com/docs",
      stream: true,
      tools: [{ type: "web_search" }],
    });
    expect(resolveCcaInTurnGrounding(config(), parsed, false, antigravityRouted, "gemini-3.7-flash")).toEqual({
      search: true,
      urlContext: true,
    });
  });
});

describe("planWebSearch gemini arm (L8)", () => {
  const healthy = { accounts: [{ id: "a1", credential: { projectId: "proj-1" } }], activeAccountId: "a1" };

  test("explicit gemini + OAuth + projectId -> plan with geminiSidecar and 3.7-flash default", () => {
    accountSets = { "google-antigravity": healthy };
    const plan = planWebSearch(config({ webSearchSidecar: { backend: "gemini" } }), parsedWithWebSearch(), false, routed, "model", undefined);
    expect(plan?.backend).toBe("gemini");
    expect(plan?.geminiSidecar?.providerName).toBe("google-antigravity");
    expect(plan?.settings.model).toBe("gemini-3.7-flash");
  });

  test.each([
    ["no account set", {}],
    ["needsReauth", { "google-antigravity": { accounts: [{ id: "a1", needsReauth: true, credential: { projectId: "p" } }], activeAccountId: "a1" } }],
    ["missing projectId", { "google-antigravity": { accounts: [{ id: "a1", credential: {} }], activeAccountId: "a1" } }],
  ] as const)("%s -> fail closed (no plan)", (_name, sets) => {
    accountSets = sets as typeof accountSets;
    expect(planWebSearch(config({ webSearchSidecar: { backend: "gemini" } }), parsedWithWebSearch(), false, routed, "model", undefined)).toBeUndefined();
  });

  test("findGeminiSidecarProvider: disabled and key-auth providers fail", () => {
    accountSets = { "google-antigravity": healthy };
    expect(findGeminiSidecarProvider(config({ providers: { routed, "google-antigravity": { ...cca, disabled: true } } }))).toBeUndefined();
    expect(findGeminiSidecarProvider(config({ providers: { routed, "google-antigravity": { ...cca, authMode: "key", apiKey: "k" } } }))).toBeUndefined();
    expect(findGeminiSidecarProvider(config())?.providerName).toBe("google-antigravity");
  });
});

import { runGeminiWebSearch } from "../src/web-search/gemini-executor";
import * as oauthModule from "../src/oauth";
mock.module("../src/oauth", () => ({
  ...oauthModule,
  getValidAccessTokenSnapshot: async () => {
    const snapshot = accessSnapshot;
    afterAccessSnapshot?.();
    return snapshot;
  },
}));
import { runWithWebSearch, type WebSearchLoopDeps } from "../src/web-search/loop";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { AdapterEvent, ProviderAdapter } from "../src/adapters/base";

describe("runGeminiWebSearch request shape (review P1)", () => {
  test("malicious baseUrl ignored: registry destination, manual redirect, bearer + IDE UA, full envelope, thinkingConfig", async () => {
    accountSets = { "google-antigravity": { accounts: [{ id: "a1", credential: { projectId: "proj-9" } }], activeAccountId: "a1" } };
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
      return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }), { status: 200 });
    }) as typeof fetch;
    try {
      const evil: OcxProviderConfig = { adapter: "google", baseUrl: "https://evil.example/v1", authMode: "oauth" };
      const out = await runGeminiWebSearch("q", "google-antigravity", evil, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.text).toBe("ok");
      expect(captured).toHaveLength(1);
      const req = captured[0]!;
      expect(new URL(req.url).origin).toBe("https://daily-cloudcode-pa.googleapis.com");
      expect(req.url).toContain("/v1internal:generateContent");
      expect(req.init.redirect).toBe("manual");
      const headers = req.init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer gem-token-abc");
      expect(headers["User-Agent"]).toContain("antigravity");
      const body = JSON.parse(String(req.init.body));
      expect(body.project).toBe("proj-9");
      expect(body.userAgent).toBe("antigravity");
      expect(body.requestType).toBe("agent");
      expect(body.request.tools).toEqual([{ google_search: {} }]);
      expect(typeof body.request.sessionId).toBe("string");
      // Effort mapping (L8 requirement): "low" on gemini-3.7-flash resolves to the
      // tiered wire model with thinkingLevel "low" — both must reach the envelope.
      expect(body.model).toBe("gemini-3.7-flash-tiered");
      expect(body.request.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "low" } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("uses one atomic OAuth snapshot when the active account changes before dispatch", async () => {
    accessSnapshot = {
      provider: "google-antigravity",
      accountId: "account-a",
      generation: "generation-a",
      accessToken: "token-a",
      projectId: "project-a",
    };
    accountSets = {
      "google-antigravity": {
        accounts: [
          { id: "account-a", credential: { projectId: "project-a" } },
          { id: "account-b", credential: { projectId: "project-b" } },
        ],
        activeAccountId: "account-a",
      },
    };
    afterAccessSnapshot = () => {
      accountSets["google-antigravity"]!.activeAccountId = "account-b";
    };
    let request: RequestInit | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }), { status: 200 });
    }) as typeof fetch;
    try {
      const out = await runGeminiWebSearch("q", "google-antigravity", cca, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000 });
      expect(out.text).toBe("ok");
      expect((request!.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-a");
      expect(JSON.parse(String(request!.body)).project).toBe("project-a");
      expect(accountSets["google-antigravity"]!.activeAccountId).toBe("account-b");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an abort immediately after headers cancels and settles the response body", async () => {
    const parent = new AbortController();
    let bodyCancelled = false;
    let bodyCancelSettled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "late" }] } }] } })));
      },
      cancel() {
        bodyCancelled = true;
        return Promise.resolve().then(() => { bodyCancelSettled = true; });
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => {
      resolve(new Response(body, { status: 200 }));
      parent.abort(new DOMException("client disconnected", "AbortError"));
    })) as typeof fetch;
    try {
      const out = await runGeminiWebSearch("q", "google-antigravity", cca, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000 }, parent.signal);
      await Promise.resolve();
      expect(out.error).toBeDefined();
      expect(bodyCancelled).toBe(true);
      expect(bodyCancelSettled).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test.each([
    ["success", 200],
    ["error", 500],
  ] as const)("oversized %s body is rejected and cancelled", async (_branch, status) => {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_SIDECAR_RESPONSE_BYTES + 1).fill(0x61));
      },
      cancel() { bodyCancelled = true; },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
    try {
      const out = await runGeminiWebSearch("q", "google-antigravity", cca, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000 });
      expect(out.error).toContain("byte bound");
      expect(bodyCancelled).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("loop dispatch: gemini arm fails closed without a sidecar (review P1)", () => {
  test("missing geminiSidecar yields the invariant error; forward executor and pool recorder untouched", async () => {
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
    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => { fetches.push(String(input)); return new Response("{}", { status: 500 }); }) as typeof fetch;
    let poolRecorded = 0;
    try {
      const response = await runWithWebSearch({
        parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
        adapter,
        backend: "gemini",
        hostedTool: { type: "web_search" },
        selectedForwardHeaders: new Headers({ authorization: "Bearer forward-secret" }),
        settings: { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000, describeImages: false },
        maxSearches: 1,
        recordSidecarOutcome: () => { poolRecorded += 1; },
        incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      } satisfies WebSearchLoopDeps);
      await new Response(response.body).text();
      expect(fetches).toEqual([]);
      expect(poolRecorded).toBe(0);
      expect(sawToolResult).toContain("without a resolved Antigravity provider");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
