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
