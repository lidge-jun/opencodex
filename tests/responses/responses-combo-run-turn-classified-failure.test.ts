/**
 * A runTurn combo child hands the combo loop the failure its adapter already classified.
 * The child's status and code drive hop and cooldown decisions; the combo's own failure
 * consumer still decides what reaches the client.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MODEL = "claude-opus-5-5";
const SIBLING_MODEL = "claude-sonnet-5-5";
let childFailure: AdapterEvent | undefined;
let runTurnCalls = 0;
let fallbackCalls = 0;

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "cursor") return actualResolveAdapter(provider, cacheRetention);
    return {
      name: "cursor",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield { type: "error", message: "fixture uses runTurn" } as AdapterEvent; },
      async runTurn(_parsed: unknown, _incoming: unknown, emit: (event: AdapterEvent) => void) {
        runTurnCalls++;
        if (childFailure) {
          emit(childFailure);
          return;
        }
        emit({ type: "text_delta", text: "cursor answered" });
        emit({ type: "done" });
      },
    } as unknown as ProviderAdapter;
  },
}));

const { handleResponses } = await import("../../src/server/responses");
const { handleChatCompletions } = await import("../../src/server/chat-completions");
const { handleResponses: responsesCore } = await import("../../src/server/responses/core");
const { handleResponsesWithPolicyFallback } = await import("../../src/server/responses/policy-fallback");
const traeClient = await import("../../src/adapters/trae-cn/client");
const { formatErrorResponse } = await import("../../src/bridge");
const { SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE } = await import("../../src/lib/errors");
const { saveCredential } = await import("../../src/oauth/store");
const { clearComboSelectionState } = await import("../../src/combos/resolve");
const { clearComboTargetCooldowns } = await import("../../src/combos/failover");
const { clearGenericFailoverHealth } = await import("../../src/oauth/generic-account-failover");

function answer(init?: RequestInit): Response {
  fallbackCalls++;
  if ((JSON.parse(String(init?.body ?? "{}")) as { stream?: unknown }).stream !== true) {
    return Response.json({
      id: "msg_fallback", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: "fallback answered" }], stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 2 },
    });
  }
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    event("message_start", { type: "message_start", message: { id: "msg_fallback", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fallback answered" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    event("message_stop", { type: "message_stop" }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function config(targets: Array<{ provider: string; model: string }>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "cursor",
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: [MODEL, SIBLING_MODEL] },
      fallback: {
        adapter: "anthropic", baseUrl: "https://fallback.test", authMode: "key",
        apiKey: "fixture-fallback-key", models: [MODEL],
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => answer(init)) as typeof fetch,
      } as OcxProviderConfig,
    },
    combos: { "classified-chain": { alias: "chain/classified", strategy: "failover", targets } },
  } as OcxConfig;
}

async function respond(cfg: OcxConfig, stream: boolean) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chain/classified", input: "describe this", stream }),
  }), cfg, { model: "", provider: "" });
  return { status: response.status, text: await response.text() };
}

test("TRAE user images reach the routed vision sidecar instead of the pre-dispatch refusal", async () => {
  const routed = await import("../../src/vision/routed-describe");
  const describer = spyOn(routed, "describeImageRouted").mockResolvedValue({ text: "caption from fixture", elapsedMs: 1 });
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false, noVisionModels: ["test-model"] };
  cfg.providers.vision = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key",
    authMode: "key", models: ["vision-model"], inputModalities: ["text", "image"] };
  cfg.visionSidecar = { enabled: true, backend: "routed", model: "vision/vision-model" };
  const prompts: string[] = [];
  const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
    prompt: async (_model, text, emit) => { prompts.push(text); emit({ type: "text_delta", text: "described" }); emit({ type: "done" }); },
    close: async () => undefined });
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "trae-cn/test-model", stream: false,
        input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }] }),
    }), cfg, { model: "", provider: "" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(open).toHaveBeenCalledTimes(1); expect(prompts.join("\n")).toContain("caption from fixture");
    expect(prompts.join("\n")).not.toContain("aGVsbG8=");
  } finally { open.mockRestore(); describer.mockRestore(); }
});

test("TRAE does not treat a credential-free OpenAI preference as a dispatchable vision plan", async () => {
  const sidecarModule = await import("../../src/providers/openai-sidecar");
  const resolver = spyOn(sidecarModule, "resolveFirstUsableOpenAiSidecar").mockResolvedValue(undefined);
  const plannerModule = await import("../../src/vision/plan");
  const planner = spyOn(plannerModule, "planVisionSidecar").mockReturnValue(undefined);
  const routed = await import("../../src/vision/routed-describe");
  const describer = spyOn(routed, "describeImageRouted");
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  cfg.visionSidecar = { enabled: true, backend: "openai" };
  const open = spyOn(traeClient, "openTraeSession");
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "trae-cn/test-model", stream: false,
        input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }] }),
    }), cfg, { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("unsupported_input_modality");
    expect(describer).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
  } finally { open.mockRestore(); describer.mockRestore(); resolver.mockRestore(); planner.mockRestore(); }
});

test("TRAE reuses a credentialed OpenAI sidecar for ordinary user images", async () => {
  const sidecarModule = await import("../../src/providers/openai-sidecar");
  const resolver = spyOn(sidecarModule, "resolveFirstUsableOpenAiSidecar").mockResolvedValue({
    providerName: "openai", provider: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
    accountMode: "direct", authContext: { kind: "main", accountId: null }, headers: new Headers(),
  });
  const vision = await import("../../src/vision/describe");
  const describer = spyOn(vision, "describeImage").mockResolvedValue({ text: "caption from OpenAI fixture", elapsedMs: 1 });
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  cfg.visionSidecar = { enabled: true, backend: "openai" };
  const prompts: string[] = [];
  const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
    prompt: async (_model, text, emit) => { prompts.push(text); emit({ type: "text_delta", text: "described" }); emit({ type: "done" }); },
    close: async () => undefined });
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "trae-cn/test-model", stream: false,
        input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }] }),
    }), cfg, { model: "", provider: "" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(resolver).toHaveBeenCalledTimes(1); expect(describer).toHaveBeenCalledTimes(1);
    expect(prompts.join("\n")).toContain("caption from OpenAI fixture");
  } finally { open.mockRestore(); describer.mockRestore(); resolver.mockRestore(); }
});

test("TRAE rejects agent and tool-result images before any vision request", async () => {
  const routed = await import("../../src/vision/routed-describe");
  const describer = spyOn(routed, "describeImageRouted");
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  cfg.providers.vision = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key",
    authMode: "key", models: ["vision-model"], inputModalities: ["text", "image"] };
  cfg.visionSidecar = { enabled: true, backend: "routed", model: "vision/vision-model" };
  const open = spyOn(traeClient, "openTraeSession");
  const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
  try {
    for (const item of [
      { type: "agent_message", role: "user", content: [image] },
      { type: "function_call_output", call_id: "call_image", output: [image] },
    ]) {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "trae-cn/test-model", stream: false, input: [item] }),
      }), cfg, { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("unsupported_input_modality");
    }
    expect(describer).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  } finally { open.mockRestore(); describer.mockRestore(); }
});

test("TRAE rebuilt web-search images still refuse while ordinary search results may be removed", async () => {
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  cfg.providers.vision = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key",
    authMode: "key", models: ["vision-model"], inputModalities: ["text", "image"] };
  cfg.visionSidecar = { enabled: true, backend: "routed", model: "vision/vision-model" };
  const routed = await import("../../src/vision/routed-describe");
  const describer = spyOn(routed, "describeImageRouted");
  const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
    prompt: async (_model, _text, emit) => { emit({ type: "text_delta", text: "answered" }); emit({ type: "done" }); },
    close: async () => undefined });
  const search = { type: "function_call", call_id: "ws_fixture", name: "web_search", arguments: "{}" };
  try {
    const refused = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "trae-cn/test-model", stream: false, input: [search,
        { type: "function_call_output", call_id: "ws_fixture", output: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }] }),
    }), cfg, { model: "", provider: "" });
    expect(refused.status).toBe(400);
    expect(describer).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    const admitted = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "trae-cn/test-model", stream: false, input: [search,
        { type: "function_call_output", call_id: "ws_fixture", output: "result text" },
        { role: "user", content: "Question" }] }),
    }), cfg, { model: "", provider: "" });
    expect(admitted.status, await admitted.clone().text()).toBe(200);
  } finally { open.mockRestore(); describer.mockRestore(); }
});

test("Chat policy retry preserves normalized effort and instruction positions", async () => {
  const { restoreChatInstructionMedia } = await import("../../src/server/responses/chat-policy-media");
  const { chatToResponsesBody } = await import("../../src/protocols/codecs/chat");
  const original = { model: "policy/daily--high", stream: false, messages: [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "system", content: "first later instruction" },
    { role: "developer", content: [{ type: "text", text: "later instruction" },
      { type: "image_url", image_url: { url: "https://fixture.invalid/later.png" } }] },
    { role: "developer", content: "final later instruction" },
    { role: "user", content: "current question" },
  ] };
  const projected = chatToResponsesBody(original);
  const restored = restoreChatInstructionMedia(projected, original);
  const input = restored.input as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  expect(input.map(item => item.role)).toEqual(["user", "assistant", "developer", "developer", "developer", "user"]);
  expect(input[3]?.content?.some(part => part.type === "input_image")).toBe(true);
  expect(input[3]?.content?.filter(part => part.type === "input_text")).toHaveLength(1);
  const settings = { ...projected, model: "policy/daily", reasoning: { effort: "high" }, input: restored.input };
  expect(settings.reasoning).toEqual({ effort: "high" });
  expect(settings.model).toBe("policy/daily");

  const leadingOriginal = { model: "policy/daily", messages: [
    { role: "system", content: [{ type: "text", text: "leading media" },
      { type: "image_url", image_url: { url: "https://fixture.invalid/leading.png" } }] },
    { role: "user", content: "question" },
  ] };
  const leading = restoreChatInstructionMedia(chatToResponsesBody(leadingOriginal), leadingOriginal);
  expect((leading.input as Array<{ role: string }>).map(item => item.role)).toEqual(["developer", "user"]);
  expect(leading.instructions).toBeUndefined();

  const toolOriginal = { model: "policy/daily", messages: [
    { role: "user", content: "question" },
    { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "developer", content: "wait for the result" },
    { role: "developer", content: [{ type: "text", text: "inspect this" },
      { type: "image_url", image_url: { url: "https://fixture.invalid/tool.png" } }] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "user", content: "next question" },
  ] };
  const tool = restoreChatInstructionMedia(chatToResponsesBody(toolOriginal), toolOriginal);
  expect((tool.input as Array<{ role?: string; type: string }>).map(item => item.role ?? item.type)).toEqual([
    "user", "function_call", "function_call_output", "developer", "developer", "user",
  ]);
});

test("an effort-decorated non-policy Chat request does not retain an original-body clone", async () => {
  const upstream = Bun.serve({ port: 0, fetch: () => new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "accepted" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } }) });
  const cfg = config([]);
  cfg.defaultProvider = "capable"; cfg.cursorEffortRows = true;
  cfg.providers.capable = { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, apiKey: "fixture-key",
    authMode: "key", models: ["accept-model"], allowPrivateNetwork: true };
  try {
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capable/accept-model--high", stream: false,
        messages: [{ role: "user", content: "x".repeat(17 * 1024 * 1024) }] }),
    }), cfg, { model: "", provider: "" }, {});
    expect(response.status, await response.clone().text()).toBe(200);
  } finally { await upstream.stop(true); }
});

test("the policy-only original Chat clone is admitted by the replay budget", async () => {
  const cfg = config([]); cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  cfg.routingProfiles = { daily: { candidates: [{ provider: "trae-cn", model: "test-model" }] } };
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "policy/daily", stream: false,
      messages: [{ role: "user", content: "x".repeat(17 * 1024 * 1024) }] }),
  }), cfg, { model: "", provider: "" }, {});
  expect(response.status).toBe(413);
  const json = await response.json() as { error?: { code?: string } };
  expect(json.error?.code).toBe("translation_buffer_limit");
});

for (const media of ["image", "video"]) {
  test("Chat policy retry retains original instruction media: " + media, async () => {
    const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
    cfg.defaultProvider = "trae-cn";
    cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
      authMode: "key", models: ["test-model"], liveModels: false };
    cfg.providers.capable = { adapter: media === "video" ? "google" : "openai-chat", baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture-key", authMode: "key", models: ["accept-model"], inputModalities: ["text", "image", "video"] };
    cfg.routingProfiles = { daily: { candidates: [
      { provider: "trae-cn", model: "test-model" }, { provider: "capable", model: "accept-model" },
    ] } };
    cfg.cursorEffortRows = true;
    const requests: RequestInit[] = [];
    cfg.providers.capable.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init!);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const streamed = media === "video"
        ? new URL(url).pathname.endsWith(":streamGenerateContent")
        : Boolean(JSON.parse(String(init?.body)).stream);
      if (media === "video") {
        if (!streamed) return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "accepted" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
          const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
          return new Response([
            frame({ candidates: [{ content: { role: "model", parts: [{ text: "accepted" }] } }] }),
            frame({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }),
          ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      if (!streamed) return Response.json({ id: "chat-fixture", object: "chat.completion", model: "accept-model",
        choices: [{ index: 0, message: { role: "assistant", content: "accepted" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        "data: " + JSON.stringify({ id: "chat-fixture", object: "chat.completion.chunk", model: "accept-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }] }) + "\n\n";
      return new Response([chunk({ role: "assistant" }), chunk({ content: "accepted" }), chunk({}, "stop"), "data: [DONE]\n\n"].join(""),
        { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
      prompt: async (_model, _text, emit) => {
        emit({ type: "error", status: 400, errorType: "invalid_request_error", code: "unsupported_input_modality",
          message: "TRAE CN ACP supports text conversations only; media, documents and tool replay are not supported.", retryable: false });
      }, close: async () => undefined });
    const attachment = media === "image"
      ? { type: "image_url", image_url: { url: "https://fixture.invalid/image.png", detail: "high" } }
      : { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAAIGZ0eXBpc29t" } };
    const messages = [
      { role: "system", content: "Leading instruction" },
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "developer", content: "First later instruction" },
      { role: "system", content: [{ type: "text", text: "Inspect the attachment" }, attachment] },
      { role: "developer", content: "Final later instruction" },
      { role: "user", content: "Question" },
    ];
    try {
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "policy/daily--high", reasoning_effort: "low", stream: false, messages }),
      }), cfg, { model: "", provider: "" }, {});
      expect(response.status, await response.clone().text()).toBe(200);
      expect(requests).toHaveLength(1);
      const sent = JSON.parse(String(requests[0]?.body)) as {
        reasoning_effort?: string;
        messages?: Array<{ role?: string; content?: Array<{ type: string }> }>;
      };
      const wire = JSON.stringify(sent);
      const chronology = ["Earlier answer", "First later instruction", "Inspect the attachment", "Final later instruction", "Question"];
      const positions = chronology.map(text => wire.indexOf(text));
      expect(positions.every(position => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      expect(wire.indexOf("Inspect the attachment")).toBe(wire.lastIndexOf("Inspect the attachment"));
      if (media === "image") {
        expect(sent.reasoning_effort).toBe("high");
        expect(wire).toContain('"detail":"high"');
        expect(sent.messages!.some(message => message.role === "system" && Array.isArray(message.content)
          && message.content.some(part => part.type === "image_url"))).toBe(true);
        expect(sent.messages!.at(-1)?.content).toBe("Question");
      } else {
        expect(JSON.stringify(sent)).toContain("inline_data");
        expect(JSON.stringify(sent)).toContain("video/mp4");
      }
    } finally { open.mockRestore(); }
  });
}

for (const media of ["image", "video"]) for (const wire of ["responses", "chat"]) for (const combo of [false, true]) {
  test("TRAE instruction media are refused at HTTP ingress: media=" + media + ", wire=" + wire + ", combo=" + combo, async () => {
    const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
    cfg.defaultProvider = "trae-cn";
    cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
      authMode: "key", models: ["test-model"], liveModels: false };
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
      prompt: async (_model, _text, emit) => { emit({ type: "text_delta", text: "attachment was lost" }); emit({ type: "done" }); },
      close: async () => undefined,
    });
    const model = combo ? "chain/classified" : "trae-cn/test-model";
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/nkAAAAASUVORK5CYII=";
    const attachment = wire === "responses"
      ? media === "image" ? { type: "input_image", image_url: image } : { type: "input_video", video_url: "https://fixture.invalid/clip.mp4" }
      : media === "image" ? { type: "image_url", image_url: { url: image } } : { type: "video_url", video_url: { url: "https://fixture.invalid/clip.mp4" } };
    const body = wire === "responses" ? { model, stream: false, input: [
      { role: "system", content: [{ type: "input_text", text: "Describe the attachment" }, attachment] },
      { role: "user", content: "Question" },
    ] } : { model, stream: false, messages: [
      { role: "system", content: [{ type: "text", text: "Describe the attachment" }, attachment] },
      { role: "user", content: "Question" },
    ] };
    try {
      const request = new Request("http://localhost/v1/" + (wire === "responses" ? "responses" : "chat/completions"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const response = await (wire === "responses" ? handleResponses : handleChatCompletions)(request, cfg, { model: "", provider: "" });
      expect(response.status).toBe(400);
      const refused = await response.json() as { error: { code: string; type: string; message: string } };
      expect(refused.error).toMatchObject({ type: "invalid_request_error",
        code: wire === "responses" && !combo ? "unsupported_input_modality" : "invalid_request_error" });
      expect(refused.error.message).toContain("TRAE CN ACP supports text conversations only");
      expect(open).not.toHaveBeenCalled(); expect(fallbackCalls).toBe(0);
    } finally { open.mockRestore(); }
  });
}

test("policy can select another eligible target after a pre-dispatch TRAE media refusal", async () => {
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.defaultProvider = "trae-cn";
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  cfg.providers.capable = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key",
    authMode: "key", models: ["accept-model"], inputModalities: ["text", "image"] };
  const trace = { version: 1 as const, decisionId: "trae-media-policy", createdAt: 1, requestedModel: "policy/daily",
    routeKind: "policy" as const, profile: { id: "daily", revision: "fixture" }, requirements: [],
    candidates: [
      { provider: "trae-cn", model: "test-model", eligible: true, exclusions: [], score: { total: 1, components: {} } },
      { provider: "capable", model: "accept-model", eligible: true, exclusions: [], score: { total: 0.5, components: {} } },
    ], selected: { candidateIndex: 0, provider: "trae-cn", model: "test-model", reason: "highest-score" } };
  const input = [{ role: "system", content: [{ type: "input_image", image_url: "https://fixture.invalid/image.png" }] },
    { role: "user", content: "Question" }];
  const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new Error("fixture must not start CLI"));
  let calls = 0;
  try {
    const response = await handleResponsesWithPolicyFallback(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/daily", input, stream: false }),
    }), cfg, {}, {}, { runCore: async (req, next, context, options) => {
      const body = await req.json() as Record<string, unknown>;
      options.onRequestBodyParsed?.(body); calls++;
      if (calls === 1) {
        const concrete = new Request(req.url, { method: "POST", headers: req.headers,
          body: JSON.stringify({ ...body, model: "trae-cn/test-model" }) });
        const refused = await responsesCore(concrete, next, context, options);
        context.routeDecision = trace; context.requestedModel = "policy/daily";
        return refused;
      }
      expect(body.model).toBe("capable/accept-model"); expect(body.input).toEqual(input);
      return Response.json({ status: "completed" });
    } });
    expect(response.status).toBe(200); expect(calls).toBe(2); expect(open).not.toHaveBeenCalled();
    await response.text();
  } finally { open.mockRestore(); }
});

for (const wire of ["responses", "chat"]) {
  test("TRAE preserves supported text instruction aliases: wire=" + wire, async () => {
    const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
    cfg.defaultProvider = "trae-cn";
    cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
      authMode: "key", models: ["test-model"], liveModels: false };
    const prompts: string[] = [];
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
      prompt: async (_model, text, emit) => { prompts.push(text); emit({ type: "text_delta", text: "accepted" }); emit({ type: "done" }); },
      close: async () => undefined,
    });
    const content: unknown[] = [{ type: "text", text: "Plain alias" }, { type: "input_text", text: "Input alias" }];
    if (wire === "chat") content.push({ type: "output_text", text: "Output alias" }, "String instruction");
    const body = { model: "trae-cn/test-model", stream: false,
      [wire === "responses" ? "input" : "messages"]: [{ role: "system", content }, { role: "user", content: "Question" }] };
    try {
      const request = new Request("http://localhost/v1/" + (wire === "responses" ? "responses" : "chat/completions"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const response = await (wire === "responses" ? handleResponses : handleChatCompletions)(request, cfg, { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();
      expect(open).toHaveBeenCalledTimes(1); expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Plain alias"); expect(prompts[0]).toContain("Input alias");
      if (wire === "chat") { expect(prompts[0]).toContain("Output alias"); expect(prompts[0]).toContain("String instruction"); }
    } finally { open.mockRestore(); }
  });
}

test("cancelled runTurn streams retain received usage after the consumer stops draining", async () => {
  const controller = new AbortController();
  const usage = { inputTokens: 123, outputTokens: 456, totalTokens: 579 };
  let finishPrompt!: () => void;
  const pending = new Promise<void>(resolve => { finishPrompt = resolve; });
  let finished!: () => void;
  const completed = new Promise<void>(resolve => { finished = resolve; });
  const cfg = config([{ provider: "trae-cn", model: "test-model" }]);
  cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
    authMode: "key", models: ["test-model"], liveModels: false };
  const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({ models: ["test-model"],
    prompt: async (_model, _text, emit, _signal, dispatch) => {
      dispatch?.beforeSend(); dispatch?.onSend();
      emit({ type: "text_delta", text: "received" }); emit({ type: "done", usage });
      await pending;
    },
    close: async () => { finished(); },
  });
  const log = { model: "", provider: "" };
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: "chain/classified", input: "request", stream: true }),
    }), cfg, log);
    await response.body!.cancel();
    controller.abort(); finishPrompt(); await completed;
    for (let tick = 0; tick < 20 && !(log as unknown as { usage?: unknown }).usage; tick++) await new Promise(resolve => setTimeout(resolve, 5));
    expect((log as unknown as { usage?: unknown }).usage).toMatchObject(usage);
    expect(fallbackCalls).toBe(0);
  } finally { finishPrompt(); open.mockRestore(); }
});

let home = "";
let releaseSpendHome: (() => void) | undefined;
const originalHome = process.env.OPENCODEX_HOME;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-classified-failure-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  await saveCredential("cursor", { access: "cursor-access", refresh: "cursor-refresh", expires: Date.now() + 3_600_000, accountId: "cursor-account" });
  childFailure = undefined;
  runTurnCalls = 0;
  fallbackCalls = 0;
  clearComboSelectionState(); clearComboTargetCooldowns(); clearGenericFailoverHealth();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState(); clearComboTargetCooldowns(); clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

for (const stream of [false, true]) {
  test(`an empty TRAE completion stops the combo after its accepted prompt (stream=${stream})`, async () => {
    childFailure = { type: "error", status: 502, errorType: "upstream_error", code: "trae_empty_response",
      message: "TRAE CN ended without a text response.", retryable: false, usage: { inputTokens: 12, outputTokens: 0 } };
    const cfg = config([{ provider: "trae-cn", model: "test-model" }, { provider: "fallback", model: MODEL }]);
    cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true, authMode: "key", models: ["test-model"], liveModels: false };
    const open = spyOn(traeClient, "openTraeSession").mockResolvedValue({
      models: ["test-model"],
      async prompt(_model, _text, emit, _signal, dispatch) {
        runTurnCalls++;
        dispatch?.beforeSend();
        dispatch?.onSend();
        emit(childFailure!);
      },
      async close() {},
    });
    try {
      const response = await respond(cfg, stream);
      expect(response.status).toBe(502);
      // Client error projection keeps its closed public vocabulary.
      expect(JSON.parse(response.text).error.code).toBe("upstream_server_error");
      expect(runTurnCalls).toBe(1);
      expect(fallbackCalls).toBe(0);
    } finally { open.mockRestore(); }
  });

  test(`a TRAE startup failure may fail over before any prompt is dispatched (stream=${stream})`, async () => {
    const cfg = config([{ provider: "trae-cn", model: "test-model" }, { provider: "fallback", model: MODEL }]);
    cfg.providers["trae-cn"] = { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true, authMode: "key", models: ["test-model"], liveModels: false };
    const open = spyOn(traeClient, "openTraeSession").mockRejectedValue(new traeClient.TraeAcpError("TRAE CN CLI not found.", "cli_not_found"));
    try {
      const response = await respond(cfg, stream);
      expect(response.status).toBe(200);
      expect(response.text).toContain("fallback answered");
      expect(open).toHaveBeenCalledTimes(1);
      expect(runTurnCalls).toBe(0);
      expect(fallbackCalls).toBe(1);
    } finally { open.mockRestore(); }
  });

  for (const status of [400, 422]) {
    for (const code of [undefined, "invalid_argument"]) {
      test(`reflected quota prose stays terminal through runTurn (stream=${stream}, status=${status}, code=${code})`, async () => {
        childFailure = {
          type: "error", status, code, errorType: "invalid_request_error",
          message: "Invalid parameter: value quotes 'weekly usage quota exceeded; quota exhausted'",
        };
        const cfg = config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]);
        const response = await respond(cfg, stream);
        expect(response.status).toBe(status);
        expect(runTurnCalls).toBe(1);
        expect(fallbackCalls).toBe(0);
        // A validation error did not cool the healthy provider for a later valid request.
        childFailure = undefined;
        const next = await respond(cfg, stream);
        expect(next.status).toBe(200);
        expect(next.text).toContain("cursor answered");
        expect(runTurnCalls).toBe(2);
        expect(fallbackCalls).toBe(0);
      });
    }
    test(`a structured spent window survives runTurn formatting (stream=${stream}, status=${status})`, async () => {
      childFailure = { type: "error", status, code: "usage_limit_reached", message: "Account window spent" };
      const response = await respond(config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]), stream);
      expect(response.status).toBe(200);
      expect(runTurnCalls).toBe(1);
      expect(fallbackCalls).toBe(1);
      expect(response.text).toContain("fallback answered");
    });
  }
  test(`a child that cannot take image input hands the turn to the next target (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 400, errorType: "invalid_request_error", code: "unsupported_input_modality",
      retryable: false, message: "Claude Code CLI image input is not enabled because the CLI provider route has no verified multimodal contract.",
    };
    const response = await respond(config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]), stream);
    expect(response.status).toBe(200);
    expect(response.text).toContain("fallback answered");
    expect(runTurnCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  test(`a child's insufficient_quota verdict survives to the exhausted combo (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 429, errorType: "insufficient_quota", code: "insufficient_quota",
      retryable: false, message: "Qoder credits are exhausted for this account.",
    };
    const response = await respond(config([{ provider: "cursor", model: MODEL }]), stream);
    expect(response.status).toBe(429);
    expect(JSON.parse(response.text).error).toMatchObject({ type: "insufficient_quota", code: "insufficient_quota" });
  });

  // The consumer truncates the child message to 500 characters, so a refusal phrase past that
  // point survives only as the child's own cyber_policy code.
  test(`a cyber-policy refusal read from a long message still stops the combo (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 502, errorType: "upstream_error", code: "upstream_error",
      message: `${"Agent transcript detail. ".repeat(30)}This request was flagged for possible cybersecurity risk.`,
    };
    const response = await respond(config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]), stream);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text).error.code).toBe("cyber_policy");
    expect(fallbackCalls).toBe(0);
  });

  // A coding-agent CLI reports spent account quota as a generic 502 upstream_error; only the
  // message says quota. That verdict cools the whole provider, so the sibling model is skipped.
  test(`a quota verdict read from the message outranks a generic child code (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 502, errorType: "upstream_error", code: "upstream_error",
      message: `${"Agent transcript detail. ".repeat(30)}Account quota exhausted.`,
    };
    const response = await respond(config([
      { provider: "cursor", model: MODEL }, { provider: "cursor", model: SIBLING_MODEL }, { provider: "fallback", model: MODEL },
    ]), stream);
    expect(response.status).toBe(200);
    expect(response.text).toContain("fallback answered");
    expect(runTurnCalls).toBe(1);
  });

  // Without an errorType the adapter infers authentication_error from the message, so that
  // inferred type must not make the message look as if it added nothing.
  test(`a credential verdict inferred from an untyped child still cools the provider (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 502, code: "upstream_error",
      message: `${"Agent transcript detail. ".repeat(30)}Authentication failed.`,
    };
    const response = await respond(config([
      { provider: "cursor", model: MODEL }, { provider: "cursor", model: SIBLING_MODEL }, { provider: "fallback", model: MODEL },
    ]), stream);
    expect(response.status).toBe(200);
    expect(response.text).toContain("fallback answered");
    expect(runTurnCalls).toBe(1);
  });
}

test("a classified child failure keeps its verdict without displacing the formatter's own refusals", async () => {
  const quota = formatErrorResponse(429, "insufficient_quota", "credits exhausted", { code: "insufficient_quota", classified: true });
  expect(quota.status).toBe(429);
  expect((await quota.json()).error).toMatchObject({ type: "insufficient_quota", code: "insufficient_quota" });
  const storage = formatErrorResponse(429, "insufficient_quota", "ledger offline",
    { code: SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE, classified: true });
  expect(storage.status).toBe(503);
  expect((await storage.json()).error).toMatchObject({ type: "server_error", code: SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE });
  const cyber = formatErrorResponse(502, "upstream_error", "flagged", { code: "cyber_policy", classified: true });
  expect(cyber.status).toBe(400);
  expect((await cyber.json()).error.code).toBe("cyber_policy");
});
