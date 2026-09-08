import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedEffort, applyPinnedEffort, prepareEffortNormalization, chatCollabSurface, applyChatEffortCap } from "../../src/server/effort-policy";
import { handleManagementAPI } from "../../src/server/management-api";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleNativeChatCompletions } from "../../src/server/chat-native";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { parseRequest } from "../../src/responses/parser";
import { routeModel } from "../../src/router";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../helpers/translator-budget";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

describe("model pinned reasoning effort policy", () => {
  const providerWithPinned: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    pinnedReasoningEffort: "high",
    modelPinnedReasoningEfforts: {
      "special-model": "max",
      "disabled-effort-model": "none",
    },
  };

  test("resolves model-specific pinned effort over provider-wide pinned effort", () => {
    const route = { provider: providerWithPinned, modelId: "special-model" };
    expect(resolvePinnedEffort(route)).toBe("max");
  });

  test("resolves provider-wide pinned effort when model is not specifically pinned", () => {
    const route = { provider: providerWithPinned, modelId: "other-model" };
    expect(resolvePinnedEffort(route)).toBe("high");
  });

  test("resolves global config modelPinnedEfforts fallback when provider has none", () => {
    const emptyProvider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const config = {
      modelPinnedEfforts: { "global-pinned": "max" },
    } as unknown as OcxConfig;
    const route = { provider: emptyProvider, modelId: "global-pinned" };
    expect(resolvePinnedEffort(route, undefined, config)).toBe("max");
  });

  test("applyPinnedEffort overrides caller effort in both parsed options and raw body", () => {
    const route = { provider: providerWithPinned, modelId: "special-model" };
    const parsed: OcxParsedRequest = {
      modelId: "special-model",
      context: { messages: [] },
      stream: true,
      options: { reasoning: "low" },
      _rawBody: { reasoning: { effort: "low" } },
    };

    const rewrite = applyPinnedEffort(parsed, route);
    expect(rewrite).toEqual({ from: "low", to: "max" });
    expect(parsed.options.reasoning).toBe("max");
    expect((parsed._rawBody as any).reasoning.effort).toBe("max");
  });

  test("applyPinnedEffort applies pinned effort when caller sent none", () => {
    const route = { provider: providerWithPinned, modelId: "other-model" };
    const parsed: OcxParsedRequest = {
      modelId: "other-model",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: {},
    };

    const rewrite = applyPinnedEffort(parsed, route);
    expect(rewrite).toEqual({ from: undefined, to: "high" });
    expect(parsed.options.reasoning).toBe("high");
    expect((parsed._rawBody as any).reasoning.effort).toBe("high");
  });

  test("applyPinnedEffort with none strips effort from both shapes", () => {
    const route = { provider: providerWithPinned, modelId: "disabled-effort-model" };
    const parsed: OcxParsedRequest = {
      modelId: "disabled-effort-model",
      context: { messages: [] },
      stream: true,
      options: { reasoning: "high" },
      _rawBody: { reasoning: { effort: "high", summary: "auto" } },
    };

    const rewrite = applyPinnedEffort(parsed, route);
    expect(rewrite).toEqual({ from: "high", to: "none" });
    expect(parsed.options.reasoning).toBeUndefined();
    expect((parsed._rawBody as any).reasoning.effort).toBeUndefined();
    expect((parsed._rawBody as any).reasoning.summary).toBe("auto");
  });
});

describe("management API pinned reasoning effort configuration", () => {
  let tempHome: string | undefined;
  const savedHome = process.env.OPENCODEX_HOME;
  afterEach(() => {
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    if (tempHome) removeTreeWithRetry(tempHome);
    tempHome = undefined;
  });
  function isolatedHome(): void {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-pinned-effort-"));
    process.env.OPENCODEX_HOME = tempHome;
  }

  function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
    return {
      version: 1,
      defaultProvider: "custom",
      providers: {
        custom: {
          adapter: "openai-responses",
          baseUrl: "https://api.custom.com",
          allowPrivateNetwork: true,
        },
      },
      ...overrides,
    } as unknown as OcxConfig;
  }

  test("PATCH /api/providers sets and updates pinned reasoning efforts", async () => {
    isolatedHome();
    const config = makeConfig();
    const patchReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pinnedReasoningEffort: "high",
        modelPinnedReasoningEfforts: { "model-a": "max", "model-b": "low" },
      }),
    });
    const patchRes = await handleManagementAPI(patchReq, new URL(patchReq.url), config);
    expect(patchRes?.status).toBe(200);
    const provider = config.providers.custom;
    expect(provider.pinnedReasoningEffort).toBe("high");
    expect(provider.modelPinnedReasoningEfforts).toEqual({ "model-a": "max", "model-b": "low" });

    // Updating with whitespace key normalizes to trimmed model id
    const wsReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedReasoningEfforts: { "  model-c  ": "medium" },
      }),
    });
    const wsRes = await handleManagementAPI(wsReq, new URL(wsReq.url), config);
    expect(wsRes?.status).toBe(200);
    expect(config.providers.custom.modelPinnedReasoningEfforts).toEqual({ "model-a": "max", "model-b": "low", "model-c": "medium" });

    // Clearing a model pinned effort with whitespace key
    const wsClearReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedReasoningEfforts: { "  model-c  ": null },
      }),
    });
    const wsClearRes = await handleManagementAPI(wsClearReq, new URL(wsClearReq.url), config);
    expect(wsClearRes?.status).toBe(200);
    expect(config.providers.custom.modelPinnedReasoningEfforts).toEqual({ "model-a": "max", "model-b": "low" });

    // Clearing a model pinned effort
    const clearReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedReasoningEfforts: { "model-a": null },
      }),
    });
    const clearRes = await handleManagementAPI(clearReq, new URL(clearReq.url), config);
    expect(clearRes?.status).toBe(200);
    expect(config.providers.custom.modelPinnedReasoningEfforts).toEqual({ "model-b": "low" });
  });

  test("PATCH /api/providers rejects invalid reasoning effort values", async () => {
    isolatedHome();
    const config = makeConfig();
    const badReq = new Request("http://localhost/api/providers?name=custom", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pinnedReasoningEffort: "invalid-tier",
      }),
    });
    const badRes = await handleManagementAPI(badReq, new URL(badReq.url), config);
    expect(badRes?.status).toBe(400);
  });

  test("PUT /api/effort-caps supports modelPinnedEfforts roundtrip", async () => {
    isolatedHome();
    const config = makeConfig();
    const putReq = new Request("http://localhost/api/effort-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedEfforts: { "gpt-5.5": "max", "claude-sonnet-4-6": "high" },
      }),
    });
    const putRes = await handleManagementAPI(putReq, new URL(putReq.url), config);
    expect(putRes?.status).toBe(200);
    expect(config.modelPinnedEfforts).toEqual({ "gpt-5.5": "max", "claude-sonnet-4-6": "high" });

    const getReq = new Request("http://localhost/api/effort-caps");
    const getRes = await handleManagementAPI(getReq, new URL(getReq.url), config);
    const data = await getRes?.json() as { modelPinnedEfforts: Record<string, string> };
    expect(data.modelPinnedEfforts).toEqual({ "gpt-5.5": "max", "claude-sonnet-4-6": "high" });

    // Partial merge: add one model, clear another
    const updateReq = new Request("http://localhost/api/effort-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelPinnedEfforts: { "gemini-3.7-flash": "high", "gpt-5.5": null },
      }),
    });
    const updateRes = await handleManagementAPI(updateReq, new URL(updateReq.url), config);
    expect(updateRes?.status).toBe(200);
    expect(config.modelPinnedEfforts).toEqual({ "claude-sonnet-4-6": "high", "gemini-3.7-flash": "high" });
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";

describe("native chat completions effort policy", () => {

  test("detects v2 collab surface in native chat tools", () => {
    const chatBody = {
      tools: [
        { type: "function", function: { name: "spawn_agent" } },
        { type: "function", function: { name: "send_message" } },
      ],
    };
    expect(chatCollabSurface(chatBody)).toBe("v2");
  });

  test("applyChatEffortCap respects effortCap ceiling over pinned effort", () => {
    const config = {
      effortCap: "low",
    };
    const chatBody = {
      reasoning_effort: "max",
    };
    const rewrite = applyChatEffortCap(chatBody, new Headers(), config, ["low", "medium", "high", "max"]);
    expect(rewrite).toEqual({ from: "max", to: "low", subagent: false });
    expect(chatBody.reasoning_effort).toBe("low");
  });
});

// Exercise the real ingress/adapter serializers. Only the upstream fetch is replaced;
// unexpected destinations fail closed instead of reaching a live provider.
describe("operator pins on the actual request wire", () => {
  const originalFetch = globalThis.fetch;
  let savedHome: string | undefined;
  let home: string;
  let codexHome: IsolatedCodexHome;
  let captured: Array<{ url: string; body: Record<string, unknown> }>;
  let failFirst: boolean;
  let failureStatus: number;
  let onFirstSend: (() => void) | undefined;

  beforeEach(() => {
    savedHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-pin-wire-"));
    process.env.OPENCODEX_HOME = home;
    codexHome = installIsolatedCodexHome("ocx-pin-wire-codex-");
    captured = [];
    failFirst = false;
    failureStatus = 503;
    onFirstSend = undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof globalThis.Request ? input.url : String(input);
      if (!url.startsWith("http://127.0.0.1:65534/")) throw new Error("unexpected pin-test destination");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.push({ url, body });
      if (captured.length === 1) onFirstSend?.();
      if (failFirst && captured.length === 1) {
        return Response.json({ error: { message: "fixture unavailable", type: "server_error" } },
          { status: failureStatus, headers: { "retry-after": "0" } });
      }
      if (url.endsWith("/chat/completions")) {
        if (body.stream === true) {
          return new Response([
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
            'data: [DONE]\n\n',
          ].join(""), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "chatcmpl_pin", object: "chat.completion", model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      return Response.json({
        id: "resp_pin", object: "response", model: body.model, status: "completed",
        output: [{ type: "message", id: "msg_pin", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    codexHome.restore();
    removeTreeWithRetry(home);
  });

  function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
    return {
      adapter: "openai-chat", authMode: "key", apiKey: "fixture-pin-key",
      baseUrl: "http://127.0.0.1:65534/v1", allowPrivateNetwork: true,
      liveModels: false, models: ["pin-model"],
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      ...overrides,
    };
  }

  function config(p: Partial<OcxProviderConfig> = {}, overrides: Partial<OcxConfig> = {}): OcxConfig {
    return { port: 0, defaultProvider: "fixture", providers: { fixture: provider(p) },
      multiAgentGuidanceEnabled: false, ...overrides };
  }

  async function request(c: OcxConfig, inbound: "chat" | "responses", extra: Record<string, unknown> = {}, headers: HeadersInit = {}) {
    const body = inbound === "chat"
      ? { model: "fixture/pin-model", messages: [{ role: "user", content: "hello" }], stream: false, reasoning_effort: "low", ...extra }
      : { model: "fixture/pin-model", input: "hello", stream: false, reasoning: { effort: "low", summary: "auto" }, ...extra };
    const req = new Request(`http://localhost/v1/${inbound === "chat" ? "chat/completions" : "responses"}`, {
      method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
      body: JSON.stringify(body),
    });
    const response = inbound === "chat"
      ? await handleChatCompletions(req, c, { model: "", provider: "" })
      : await handleResponses(req, c, { model: "", provider: "" }, { abortSignal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    return captured.at(-1)!.body;
  }

  for (const inbound of ["chat", "responses"] as const) {
    test(`${inbound}: ultra pin maps to max on the Chat wire`, async () => {
      const wire = await request(config({ pinnedReasoningEffort: "ultra" }), inbound);
      expect(wire.reasoning_effort).toBe("max");
    });

    test(`${inbound}: none omits effort instead of sending none`, async () => {
      const wire = await request(config({ pinnedReasoningEffort: "none" }), inbound);
      expect(Object.hasOwn(wire, "reasoning_effort")).toBe(false);
    });

    test(`${inbound}: minimal pin uses the existing low wire mapping`, async () => {
      expect((await request(config({ pinnedReasoningEffort: "minimal" }), inbound)).reasoning_effort).toBe("low");
    });

    test(`${inbound}: provider-model > provider-wide > global`, async () => {
      const c = config({ pinnedReasoningEffort: "high", modelPinnedReasoningEfforts: { "pin-model": "xhigh" } },
        { modelPinnedEfforts: { "fixture/pin-model": "medium" } });
      expect((await request(c, inbound)).reasoning_effort).toBe("xhigh");
      delete c.providers.fixture!.modelPinnedReasoningEfforts;
      expect((await request(c, inbound)).reasoning_effort).toBe("high");
      delete c.providers.fixture!.pinnedReasoningEffort;
      expect((await request(c, inbound)).reasoning_effort).toBe("medium");
    });

    test(`${inbound}: exact selector > qualified destination > bare destination`, async () => {
      const c = config({ modelAliases: { "pin-model": "friendly" } }, {
        modelPinnedEfforts: { "fixture/friendly": "xhigh", "fixture/pin-model": "high", "pin-model": "medium" },
      });
      expect((await request(c, inbound, { model: "fixture/friendly" })).reasoning_effort).toBe("xhigh");
      delete c.modelPinnedEfforts!["fixture/friendly"];
      expect((await request(c, inbound, { model: "fixture/friendly" })).reasoning_effort).toBe("high");
      delete c.modelPinnedEfforts!["fixture/pin-model"];
      expect((await request(c, inbound, { model: "fixture/friendly" })).reasoning_effort).toBe("medium");
    });

    test(`${inbound}: qualified global lookup retains case-fold semantics`, async () => {
      const c = config({}, { modelPinnedEfforts: { "FIXTURE/PIN-MODEL": "high", "pin-model": "medium" } });
      expect((await request(c, inbound)).reasoning_effort).toBe("high");
    });

    test(`${inbound}: provider model selector fallback precedes provider-wide pin`, async () => {
      const c = config({ modelAliases: { "pin-model": "friendly" }, pinnedReasoningEffort: "high",
        modelPinnedReasoningEfforts: { "fixture/friendly": "medium" } });
      expect((await request(c, inbound, { model: "fixture/friendly" })).reasoning_effort).toBe("medium");
    });

    test(`${inbound}: applicable child cap follows pin, before wire alias`, async () => {
      const c = config({ pinnedReasoningEffort: "ultra", reasoningEffortMap: { medium: "enabled" } },
        { effortCap: "high", subagentEffortCap: "medium" });
      const wire = await request(c, inbound, {}, { "x-openai-subagent": "collab_spawn" });
      expect(wire.reasoning_effort).toBe("enabled");
    });

    test(`${inbound}: v2 main cap follows pin; v1 main leaves it alone`, async () => {
      const c = config({ pinnedReasoningEffort: "max" }, { effortCap: "medium" });
      const tools = inbound === "chat"
        ? [{ type: "function", function: { name: "spawn_agent", parameters: { type: "object", properties: {} } } }]
        : [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {} } }];
      expect((await request(c, inbound, { tools })).reasoning_effort).toBe("medium");
      c.multiAgentMode = "v1";
      expect((await request(c, inbound, { tools })).reasoning_effort).toBe("max");
    });

    test(`${inbound}: cap below all supported rungs omits pinned effort`, async () => {
      const c = config({ pinnedReasoningEffort: "max", reasoningEfforts: ["high", "max"] }, { subagentEffortCap: "low" });
      expect(Object.hasOwn(await request(c, inbound, {}, { "x-openai-subagent": "collab_spawn" }), "reasoning_effort")).toBe(false);
    });
  }

  test("Responses passthrough none preserves reasoning.summary", async () => {
    const wire = await request(config({ adapter: "openai-responses", pinnedReasoningEffort: "none" }), "responses");
    expect(wire.reasoning).toEqual({ summary: "auto" });
  });

  test("Responses passthrough maps a pinned ultra through its declared ladder", async () => {
    const wire = await request(config({ adapter: "openai-responses", pinnedReasoningEffort: "ultra" }), "responses");
    expect(wire.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  test("native Chat without pins preserves caller wire spelling and existing cap behavior", async () => {
    const c = config({ reasoningEfforts: ["low"], reasoningEffortMap: { max: "enabled" } }, { effortCap: "low", subagentEffortCap: "low" });
    expect((await request(c, "chat", { reasoning_effort: "ultra" }, { "x-openai-subagent": "collab_spawn" })).reasoning_effort).toBe("ultra");
    expect(Object.hasOwn(await request(c, "chat", { reasoning_effort: undefined }), "reasoning_effort")).toBe(false);
  });

  test("unpinned Responses keeps its existing applicable cap", async () => {
    expect((await request(config({}, { subagentEffortCap: "medium" }), "responses",
      { reasoning: { effort: "max", summary: "auto" } }, { "x-openai-subagent": "collab_spawn" })).reasoning_effort).toBe("medium");
  });

  test("routed compaction skips pins and caps", async () => {
    const wire = await request(config({ pinnedReasoningEffort: "max" }, { subagentEffortCap: "low" }), "responses", {
      input: [{ role: "user", content: "summarize this" }, { type: "compaction_trigger" }],
      reasoning: { effort: "medium", summary: "auto" },
    }, { "x-openai-subagent": "collab_spawn" });
    expect(wire.reasoning_effort).toBe("medium");
  });

  test("synthetic rows retain effective effort and exclude synthetic global pin keys", async () => {
    const c = config({}, { cursorEffortRows: true, modelPinnedEfforts: { "fixture/pin-model--high": "max" } });
    expect((await request(c, "responses", { model: "fixture/pin-model--high" })).reasoning_effort).toBe("high");
    c.modelPinnedEfforts!["fixture/pin-model"] = "medium";
    expect((await request(c, "responses", { model: "fixture/pin-model--high" })).reasoning_effort).toBe("medium");
  });

  test("combo failover recomputes each destination's default without leaking the first pin", async () => {
    failFirst = true;
    const c = config({}, {
      providers: {
        first: provider({ pinnedReasoningEffort: "max", reasoningEfforts: ["low", "high", "max"] }),
        second: provider({ reasoningEfforts: ["low", "medium"] }),
      },
      defaultProvider: "first",
      modelPinnedEfforts: { "combo/pin-default": "low" },
      combos: { "pin-default": { strategy: "failover", defaultEffort: "high", targets: [
        { provider: "first", model: "pin-model" }, { provider: "second", model: "pin-model" },
      ] } },
    });
    const wire = await request(c, "responses", { model: "combo/pin-default", reasoning: { summary: "auto" } });
    expect(captured.map(({ body }) => body.reasoning_effort)).toEqual(["max", "medium"]);
    expect(wire.reasoning_effort).toBe("medium");
  });

  test("native repeated destinations restore only original effort and keep credential-retry decisions", async () => {
    const c = config({}, { providers: {
      first: provider({ pinnedReasoningEffort: "high" }),
      second: provider(),
      omit: provider({ pinnedReasoningEffort: "none" }),
      last: provider(),
    }, modelPinnedEfforts: { "first/pin-model": "xhigh", "last/pin-model": "medium" } });
    const body: Record<string, unknown> = { model: "first/pin-model", messages: [{ role: "user", content: "hello" }], reasoning_effort: "low", reasoning: { summary: "auto" } };
    const req = new Request("http://localhost/v1/chat/completions", { method: "POST" });
    async function send(name: string) {
      const response = await handleNativeChatCompletions({ req, config: c, logCtx: { model: "", provider: "" },
        route: routeModel(c, `${name}/pin-model`), chatBody: body, requestedModel: `${name}/pin-model`,
        requestedStream: false, translatorBudget: createTestTranslatorBudget() });
      expect(response.status, await response.text()).toBe(200);
    }
    await send("first");
    c.providers.first!.pinnedReasoningEffort = "max";
    await send("first");
    body.reasoning = { summary: "detailed" };
    body.temperature = 0.2;
    await send("second");
    await send("omit");
    await send("last");
    expect(captured.map(({ body }) => body.reasoning_effort)).toEqual(["high", "high", "low", undefined, "medium"]);
    expect(body.reasoning).toEqual({ summary: "detailed" });
    expect(body.temperature).toBe(0.2);
  });

  test("native same-target retry keeps the already normalized pin decision", async () => {
    failFirst = true;
    failureStatus = 429;
    const c = config({ pinnedReasoningEffort: "ultra",
      retryOn429: { attempts: 1, intervalMs: 100, maxIntervalMs: 100, respectRetryAfter: false } });
    onFirstSend = () => { c.providers.fixture!.pinnedReasoningEffort = "low"; };
    await request(c, "chat");
    expect(captured.map(({ body }) => body.reasoning_effort)).toEqual(["max", "max"]);
  });
});

// The normalization entry is request-owned and shared with the real Responses path.
// Use the parser and adapter serializer to observe repeated destination normalization.
describe("repeated Responses effort normalization", () => {
  test("restores pre-pin effective effort and raw presence while preserving unrelated edits", () => {
    for (const reasoning of [{ effort: "medium", summary: "auto" }, { summary: "auto" }]) {
      const parsed = parseRequest({ model: "first/pin-model", input: "hello", stream: false, reasoning });
      const first = { providerName: "first", modelId: "pin-model", provider: { adapter: "openai-chat" as const,
        baseUrl: "http://127.0.0.1:65534/v1", pinnedReasoningEffort: "high" } };
      const second = { providerName: "second", modelId: "pin-model", provider: { ...first.provider, pinnedReasoningEffort: undefined } };
      prepareEffortNormalization(parsed, first);
      parsed.modelId = first.modelId;
      applyPinnedEffort(parsed, first);
      const raw = parsed._rawBody as { reasoning: Record<string, unknown> };
      raw.reasoning.summary = "detailed";
      parsed.options.temperature = 0.2;
      prepareEffortNormalization(parsed, second);
      applyPinnedEffort(parsed, second);
      const wire = JSON.parse(withTestTranslatorBudget(createOpenAIChatAdapter(second.provider)).buildRequest(parsed).body);
      expect(wire.reasoning_effort).toBe("effort" in reasoning ? "medium" : undefined);
      expect(Object.hasOwn(raw.reasoning, "effort")).toBe("effort" in reasoning);
      expect(raw.reasoning.summary).toBe("detailed");
      expect(parsed.options.temperature).toBe(0.2);
      const omit = { ...second, providerName: "omit", provider: { ...second.provider, pinnedReasoningEffort: "none" } };
      prepareEffortNormalization(parsed, omit);
      applyPinnedEffort(parsed, omit);
      expect(raw.reasoning).toEqual({ summary: "detailed" });
      prepareEffortNormalization(parsed, second);
      applyPinnedEffort(parsed, second);
      expect(parsed.options.reasoning).toBe("effort" in reasoning ? "medium" : undefined);
    }
  });

  test("pre-namespace selectors are destination-scoped and restore parser-normalized effort independently of raw effort", () => {
    const parsed = parseRequest({ model: "first/pin-model", input: "hello", reasoning: { effort: "ultra", summary: "auto" } });
    const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "http://127.0.0.1:65534/v1" };
    const first = { providerName: "first", modelId: "pin-model", provider };
    const second = { ...first, providerName: "second" };
    const config = { port: 0, providers: { first: provider, second: provider },
      modelPinnedEfforts: { "first/pin-model": "high", "second/pin-model": "none" } };
    prepareEffortNormalization(parsed, first);
    parsed.modelId = first.modelId;
    applyPinnedEffort(parsed, first, config);
    expect(parsed.options.reasoning).toBe("high");
    prepareEffortNormalization(parsed, second);
    applyPinnedEffort(parsed, second, config);
    expect(parsed.options.reasoning).toBeUndefined();
    const third = { ...first, providerName: "third" };
    prepareEffortNormalization(parsed, third);
    applyPinnedEffort(parsed, third, config);
    expect(parsed.options.reasoning).toBe("max");
    expect(parsed._rawBody).toMatchObject({ reasoning: { effort: "ultra", summary: "auto" } });
    const wire = JSON.parse(withTestTranslatorBudget(createOpenAIChatAdapter(provider)).buildRequest(parsed).body);
    expect(wire.reasoning_effort).toBe("max");
  });
});
