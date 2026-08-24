import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { routeModel } from "../src/router";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import type { RequestLogContext } from "../src/server/request-log";
import { decideV2NativeParentOverride } from "../src/server/responses/v2-native-parent-override";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function config(target = "gw/routed-model"): OcxConfig {
  return {
    defaultProvider: "openai",
    multiAgentMode: "v2",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      gw: {
        adapter: "openai-chat",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
    v2NativeParentOverride: { enabled: true, model: target },
  } as unknown as OcxConfig;
}

function parsed(tools: Array<Record<string, unknown>> = [
  { name: "spawn_agent" },
  { name: "send_message" },
]): OcxParsedRequest {
  return parseRequest({
    model: "gpt-5.6-luna",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: tools.map(tool => ({ type: "function", ...tool })),
    stream: false,
  });
}

function sourceRoute(configValue = config()): ReturnType<typeof routeModel> {
  return routeModel(configValue, "gpt-5.6-luna");
}

function rootBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-5.6-luna",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [
      { type: "function", name: "spawn_agent", parameters: { type: "object" } },
      { type: "function", name: "send_message", parameters: { type: "object" } },
    ],
    stream: false,
    ...extra,
  };
}

function responseRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("v2 native parent override decision", () => {
  test("returns a routed target for an eligible native V2 root", () => {
    const result = decideV2NativeParentOverride({
      kind: "responses",
      config: config(),
      headers: new Headers(),
      parsed: parsed(),
      sourceRoute: sourceRoute(),
    });

    expect(result.kind).toBe("override");
    if (result.kind === "override") {
      expect(result.route.providerName).toBe("gw");
      expect(result.route.modelId).toBe("routed-model");
    }
  });

  test("skips routed sources, children, helpers, combos, and non-V2 surfaces", () => {
    const routed = {
      ...sourceRoute(),
      providerName: "gw",
      provider: config().providers.gw as OcxProviderConfig,
    };
    expect(decideV2NativeParentOverride({ kind: "responses", config: config(), headers: new Headers(), parsed: parsed(), sourceRoute: routed }).kind).toBe("skip");
    expect(decideV2NativeParentOverride({ kind: "responses", config: config(), headers: new Headers({ "x-openai-subagent": "collab_spawn" }), parsed: parsed(), sourceRoute: sourceRoute() }).kind).toBe("skip");
    expect(decideV2NativeParentOverride({ kind: "responses", config: config(), headers: new Headers({ "x-openai-subagent": "review" }), parsed: parsed(), sourceRoute: sourceRoute() }).kind).toBe("skip");
    const v1 = parsed();
    v1.context.tools = [{ name: "spawn_agent", description: "", parameters: { type: "object" }, namespace: "agents" }];
    expect(decideV2NativeParentOverride({ kind: "responses", config: config(), headers: new Headers(), parsed: v1, sourceRoute: sourceRoute() }).kind).toBe("skip");
    expect(decideV2NativeParentOverride({ kind: "responses", config: config(), headers: new Headers(), parsed: parsed(), sourceRoute: sourceRoute(), comboAttempt: true }).kind).toBe("skip");
  });

  test("fails closed when the target is missing, unroutable, or canonical", () => {
    const missing = { ...config(), v2NativeParentOverride: { enabled: true } } as OcxConfig;
    expect(decideV2NativeParentOverride({ kind: "responses", config: missing, headers: new Headers(), parsed: parsed(), sourceRoute: sourceRoute() }).kind).toBe("reject");
    expect(decideV2NativeParentOverride({ kind: "responses", config: config("missing/model"), headers: new Headers(), parsed: parsed(), sourceRoute: sourceRoute() }).kind).toBe("reject");
    const canonical = { ...config("openai/gpt-5.6-luna") } as OcxConfig;
    expect(decideV2NativeParentOverride({ kind: "responses", config: canonical, headers: new Headers(), parsed: parsed(), sourceRoute: sourceRoute(canonical) }).kind).toBe("reject");
  });

  test("compact requires explicit V2 mode and excludes helper markers", () => {
    const compactConfig = config();
    const source = sourceRoute(compactConfig);
    expect(decideV2NativeParentOverride({ kind: "compact", config: compactConfig, headers: new Headers(), sourceRoute: source, targetEvidence: {} }).kind).toBe("override");
    expect(decideV2NativeParentOverride({ kind: "compact", config: { ...compactConfig, multiAgentMode: "default" }, headers: new Headers(), sourceRoute: source, targetEvidence: {} }).kind).toBe("skip");
    expect(decideV2NativeParentOverride({ kind: "compact", config: compactConfig, headers: new Headers({ "x-openai-subagent": "memory" }), sourceRoute: source, targetEvidence: {} }).kind).toBe("skip");
  });
});

describe("v2 native parent override runtime", () => {
  test.each([
    ["missing", undefined],
    ["unroutable", "missing/model"],
    ["canonical", "openai/gpt-5.6-luna"],
  ] as const)("ordinary fail-closed %s performs no upstream I/O", async (_label, target) => {
    let upstreamCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      throw new Error("eligible ordinary reject must not fetch");
    }) as typeof fetch;
    try {
      const cfg = config();
      cfg.v2NativeParentOverride = target === undefined ? { enabled: true } : { enabled: true, model: target };
      const response = await handleResponses(responseRequest(rootBody()), cfg, { model: "", provider: "" });
      expect(response.status).toBe(404);
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["missing", undefined],
    ["unroutable", "missing/model"],
    ["canonical", "openai/gpt-5.6-luna"],
  ] as const)("compact fail-closed %s keeps source route metadata and performs no upstream I/O", async (_label, target) => {
    let upstreamCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      throw new Error("eligible compact reject must not fetch");
    }) as typeof fetch;
    try {
      const cfg = config();
      cfg.v2NativeParentOverride = target === undefined ? { enabled: true } : { enabled: true, model: target };
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponsesCompact(responseRequest(rootBody({ input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
        { type: "compaction_trigger" },
      ] })), cfg, logCtx);
      expect(response.status).toBe(404);
      expect(upstreamCalls).toBe(0);
      expect(logCtx.requestedModel).toBe("gpt-5.6-luna");
      expect(logCtx.model).toBe("gpt-5.6-luna");
      expect(logCtx.provider).toBe("openai");
      expect(logCtx.routeDecision).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["v1", [{ type: "function", name: "spawn_agent" }, { type: "function", name: "send_input" }], {}],
    ["non-agent", undefined, {}],
    ["ambiguous", [{ type: "function", name: "spawn_agent" }, { type: "function", name: "send_input" }, { type: "function", name: "send_message" }], {}],
    ["helper", undefined, { "x-openai-subagent": "review" }],
    ["exact child", undefined, { "x-openai-subagent": "collab_spawn" }],
    ["metadata child", undefined, { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) }],
  ] as const)("ordinary %s remains on its original route", async (_label, tools, headers) => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: "resp", status: "completed", output: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const body = rootBody();
      if (tools === undefined) delete body.tools;
      else body.tools = tools;
      const response = await handleResponses(responseRequest(body, headers), config(), { model: "", provider: "" });
      // The minimal fixture has no ChatGPT credential; unchanged native behavior fails auth
      // before fetch, which is still enough to prove the override did not select the gateway.
      expect(response.status).toBe(401);
      expect(urls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("malformed collab tool input is rejected before any provider fetch", async () => {
    let upstreamCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      throw new Error("malformed request must not fetch");
    }) as typeof fetch;
    try {
      const response = await handleResponses(
        responseRequest(rootBody({ tools: [{ type: "function", name: 42 }] })),
        config(),
        { model: "", provider: "" },
      );
      // Parser drops the malformed tool and the unchanged native path then reaches its
      // expected missing-credential response; importantly, it never selects the gateway.
      expect(response.status).toBe(401);
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("shadow interception runs before parent override", async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const cfg = config();
      cfg.shadowCallIntercept = { enabled: true, model: "gw/shadow-model" };
      await handleResponses(responseRequest(rootBody()), cfg, { model: "", provider: "" });
      expect(urls).toEqual(["https://gateway.example/v1/chat/completions"]);
      expect(bodies[0]?.model).toBe("shadow-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["exact child", { "x-openai-subagent": "collab_spawn" }],
    ["helper", { "x-openai-subagent": "memory" }],
    ["metadata child", { "x-codex-turn-metadata": JSON.stringify({ subagent_kind: "thread_spawn" }) }],
  ] as const)("compact %s stays on native route", async (_label, headers) => {
    let upstreamCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      throw new Error("native compact auth should fail before fetch in this fixture");
    }) as typeof fetch;
    try {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponsesCompact(
        responseRequest(rootBody({ input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
          { type: "compaction_trigger" },
        ] }), headers),
        config(),
        logCtx,
      );
      expect(response.status).toBe(401);
      expect(upstreamCalls).toBe(0);
      expect(logCtx.model).toBe("gpt-5.6-luna");
      expect(logCtx.provider).toBe("openai");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("combo dispatch keeps its selected target instead of applying the parent override", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const cfg = config();
      cfg.combos = { test: { targets: [{ provider: "gw", model: "combo-model" }] } } as typeof cfg.combos;
      const response = await handleResponses(
        responseRequest(rootBody({ model: "combo/test" })),
        cfg,
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      expect(bodies[0]?.model).toBe("combo-model");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rewrites an eligible native root to the routed provider and keeps caller logging identity", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(responseRequest(rootBody()), config(), logCtx);
      expect(response.status).toBe(200);
      expect(urls).toEqual(["https://gateway.example/v1/chat/completions"]);
      expect(bodies[0]?.model).toBe("routed-model");
      expect(logCtx.requestedModel).toBe("gpt-5.6-luna");
      expect(logCtx.model).toBe("routed-model");
      expect(logCtx.provider).toBe("gw");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rewrites eligible root compact before selecting routed synthetic compaction", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponsesCompact(
        responseRequest(rootBody({ input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
          { type: "compaction_trigger" },
        ] })),
        config(),
        logCtx,
      );
      expect(response.status).toBe(200);
      expect(urls).toEqual(["https://gateway.example/v1/chat/completions"]);
      expect(bodies[0]?.model).toBe("routed-model");
      expect(logCtx.requestedModel).toBe("gpt-5.6-luna");
      expect(logCtx.model).toBe("routed-model");
      expect(((await response.json()) as { output?: Array<{ type?: string }> }).output?.some(item => item.type === "message")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
