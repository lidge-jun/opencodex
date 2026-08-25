import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as storeModule from "../src/oauth/store";
import { MAX_SIDECAR_RESPONSE_BYTES } from "../src/web-search/parse";

let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean; credential?: Record<string, unknown> }>; activeAccountId?: string }> = {};
mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? storeModule.getAccountSet(provider),
}));

import { mapCcaGroundedResponse } from "../src/web-search/gemini-executor";
import { findGeminiSidecarProvider, planWebSearch } from "../src/web-search";
import { parseRequest } from "../src/responses/parser";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routed: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "k" };
const cca: OcxProviderConfig = { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" };

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
import {
  resetProviderTlsProfileForTests,
  setProviderTlsRuntimeForTest,
} from "../src/lib/provider-tls-profile";
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
  test("uses the opt-in Antigravity executor for Gemini grounding", async () => {
    accountSets = { "google-antigravity": { accounts: [{ id: "a1", credential: { projectId: "proj-9" } }], activeAccountId: "a1" } };
    let nativeCalls = 0;
    let bunCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      bunCalls += 1;
      return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "bun" }] } }] } }), { status: 200 });
    }) as typeof fetch;
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          nativeCalls += 1;
          return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "native" }] } }] } }), { status: 200 });
        },
      }),
    });
    try {
      const out = await runGeminiWebSearch("q", "google-antigravity", {
        ...cca,
        googleMode: "cloud-code-assist",
        tlsProfile: "antigravity-browser",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      }, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000 });
      expect(out.text).toBe("native");
      expect(nativeCalls).toBe(1);
      expect(bunCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      resetProviderTlsProfileForTests();
    }
  });

  test("redacts proxy credentials from profiled native errors", async () => {
    accountSets = { "google-antigravity": { accounts: [{ id: "a1", credential: { projectId: "proj-9" } }], activeAccountId: "a1" } };
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          throw new Error("native connect failed at http://proxy-user:proxy-secret@example.test:8080/?access_token=gem-token-abc");
        },
      }),
    });
    try {
      const out = await runGeminiWebSearch("q", "google-antigravity", {
        ...cca,
        googleMode: "cloud-code-assist",
        tlsProfile: "antigravity-browser",
      }, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000 });
      expect(out.error).toContain("native connect failed");
      expect(out.error).not.toMatch(/proxy-user|proxy-secret|gem-token-abc|access_token/);
    } finally {
      resetProviderTlsProfileForTests();
    }
  });

  test("classifies a profiled TimeoutError as a timeout without leaking details", async () => {
    accountSets = { "google-antigravity": { accounts: [{ id: "a1", credential: { projectId: "proj-9" } }], activeAccountId: "a1" } };
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          const timeout = new Error("timed out at http://proxy-user:proxy-secret@example.test:8080/?token=gem-secret");
          timeout.name = "TimeoutError";
          throw timeout;
        },
      }),
    });
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = await runGeminiWebSearch("q", "google-antigravity", {
        ...cca,
        googleMode: "cloud-code-assist",
        tlsProfile: "antigravity-browser",
      }, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000 });
      expect(out.error).toContain("timed out");
      expect(out.error).not.toMatch(/proxy-user|proxy-secret|gem-secret|token=/);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    } finally {
      warning.mockRestore();
      resetProviderTlsProfileForTests();
    }
  });

  test("malicious baseUrl fails closed and does not dispatch upstream", async () => {
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
      expect(out.error).toContain("canonical Antigravity HTTPS destination");
      expect(captured).toHaveLength(0);

      const canonical: OcxProviderConfig = { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" };
      const validOut = await runGeminiWebSearch("q", "google-antigravity", canonical, { model: "gemini-3.7-flash", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(validOut.text).toBe("ok");
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
