import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { parseRequest } from "../../src/responses/parser";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { responsesJsonToChatCompletion, responsesSseToChatCompletionsSse } from "../../src/chat/outbound";
import { foldChatCompletion } from "../../src/protocols/encoders/chat";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses/core";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { RequestLogContext } from "../../src/server/request-log";
import { protocolTraceForRequest } from "../../src/protocols/trace";
import type { AdapterEvent, OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

type Rec = Record<string, any>;
const THOUGHT = "FIXTURE_RAW_REASONING";
const ANSWER = "FIXTURE_ANSWER";
const originalFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let releaseSpend: () => void;
let bodies: string[];
let inlineTags: boolean;
let sidecar: "web-search" | "video" | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  codexHome = installIsolatedCodexHome("ocx-chat-raw-codex-");
  home = mkdtempSync(join(tmpdir(), "ocx-chat-raw-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  bodies = [];
  inlineTags = false;
  sidecar = undefined;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://chat-reasoning.invalid/v1/chat/completions");
    bodies.push(String(init?.body));
    if (JSON.parse(bodies.at(-1)!).stream !== true) return Response.json({
      choices: [{ index: 0, message: { role: "assistant", content: ANSWER, reasoning_content: THOUGHT }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const frames = [
      { choices: [{ index: 0, delta: inlineTags ? { content: `<think>${THOUGHT}</think>` } : { reasoning_content: THOUGHT } }] },
      { choices: [{ index: 0, delta: { content: ANSWER } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  releaseSpend?.();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  codexHome?.restore();
  if (home) removeTreeWithRetry(home);
});

function config(direct: boolean, hideRawReasoning = false, providerExtra: Rec = {}): OcxConfig {
  const value: OcxConfig = {
    port: 0, defaultProvider: "fixture",
    providers: { fixture: {
      adapter: "openai-chat", baseUrl: "https://chat-reasoning.invalid/v1", apiKey: "fixture-key",
      models: ["gpt-4o"], liveModels: false, hideRawReasoning,
      ...(inlineTags ? { inlineThinkTagModels: ["gpt-4o"] } : {}),
      ...providerExtra,
    } },
    protocols: { rollout: { directEncoders: direct } },
  };
  if (sidecar === "web-search") value.webSearchSidecar = { backend: "exa", exaApiKey: "fixture-search-key" };
  if (sidecar === "video") {
    value.images = { videoBridgeEnabled: true };
    value.providers.xai = {
      adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", apiKey: "fixture-video-key",
      models: ["grok-imagine-video"], liveModels: false,
    };
  }
  saveConfig(value);
  return value;
}

function chatBody(extra: Rec = {}): Rec {
  // store declines native passthrough; the reported defect is on the translated path.
  return { model: "fixture/gpt-4o", store: true, messages: [{ role: "user", content: "fixture" }], ...extra };
}

function frames(text: string): Rec[] {
  return text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
}

async function dispatch(direct: boolean, stream: boolean, extra: Rec = {}, hideRaw = false, headers: Rec = {}, providerExtra: Rec = {}) {
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(chatBody({ stream, ...extra })),
  }), config(direct, hideRaw, providerExtra), logCtx);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(protocolTraceForRequest(logCtx, logCtx.attempts)?.responsePath).toEqual(
    direct && !sidecar ? ["chat", "ir", "chat"] : ["chat", "ir", "responses-internal", "chat"],
  );
  expect(bodies).toHaveLength(1);
  const thought = stream
    ? frames(text).map(frame => frame.choices?.[0]?.delta?.reasoning_content ?? "").join("")
    : JSON.parse(text).choices[0].message.reasoning_content ?? "";
  const answer = stream
    ? frames(text).map(frame => frame.choices?.[0]?.delta?.content ?? "").join("")
    : JSON.parse(text).choices[0].message.content;
  expect(answer).toBe(ANSWER);
  return thought;
}

function assertSidecarRequest(): void {
  // Synthetic tool admission proves the sidecar executed even though the fixture never calls it.
  const body = JSON.parse(bodies[0]!);
  expect(body.tools.map((tool: Rec) => tool.function.name)).toEqual([sidecar === "web-search" ? "web_search" : "video_gen"]);
  expect(body).not.toHaveProperty("chatRawReasoningVisible");
  expect(body).not.toHaveProperty("reasoning");
  expect(body).not.toHaveProperty("reasoning_effort");
  expect(body).not.toHaveProperty("thinking");
}

describe("Chat raw reasoning through sidecar delivery (#7750)", () => {
  for (const path of ["web-search", "video"] as const) for (const direct of [false, true]) for (const stream of [true, false]) {
    const lane = `${path}, direct=${direct}, stream=${stream}`;
    const tools = path === "web-search" ? { tools: [{ type: "web_search" }] } : {};
    test(`${lane}: raw delivery preference leaves upstream bytes unchanged`, async () => {
      sidecar = path;
      await dispatch(direct, stream, tools);
      const visibleBody = bodies[0];
      assertSidecarRequest();
      bodies = [];
      expect(await dispatch(direct, stream, { ...tools, include_reasoning: false })).toBe("");
      expect(bodies[0]).toBe(visibleBody);
    });
    for (const policy of ["default", "include false", "provider hide"] as const) {
      test(`${lane}: ${policy}`, async () => {
        sidecar = path;
        const thought = await dispatch(direct, stream, { ...tools, ...(policy === "include false" ? { include_reasoning: false } : {}) }, policy === "provider hide");
        assertSidecarRequest();
        expect(thought).toBe(policy === "default" ? THOUGHT : "");
      });
    }
    for (const ingress of ["responses", "messages"] as const) {
      test(`${lane}: ${ingress} ingress keeps its omitted-reasoning default`, async () => {
        sidecar = path;
        const body = ingress === "responses"
          ? { model: "fixture/gpt-4o", input: "fixture", stream, ...tools }
          : { model: "fixture/gpt-4o", messages: [{ role: "user", content: "fixture" }], max_tokens: 64, stream,
            ...(path === "web-search" ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}) };
        const request = new Request(`http://localhost/v1/${ingress}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const cfg = config(direct);
        const response = ingress === "responses"
          ? await handleResponses(request, cfg, { model: "", provider: "" })
          : await handleClaudeMessages(request, cfg, { model: "", provider: "" });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain(THOUGHT);
        expect(text).toContain(ANSWER);
        expect(bodies).toHaveLength(1);
        // Responses does not activate the video loop for buffered requests; Chat/Messages
        // internally request SSE even when their caller asks for a buffered response.
        if (path !== "video" || ingress !== "responses" || stream) assertSidecarRequest();
      });
    }
  }
});

describe("Chat raw reasoning delivery without upstream opt-in (#7750)", () => {
  for (const direct of [false, true]) for (const stream of [true, false]) {
    const lane = `${direct ? "direct encoder" : "bridge"}, ${stream ? "SSE" : "buffered"}`;
    test(`${lane}: omitted reasoning delivers raw text and leaves the upstream body unchanged`, async () => {
      const thought = await dispatch(direct, stream);
      expect(JSON.parse(bodies[0]!)).not.toHaveProperty("reasoning");
      // Captured on unmodified origin/dev: pin the complete serialized upstream request.
      expect(bodies[0]).toBe('{"model":"gpt-4o","messages":[{"role":"user","content":"fixture"}],"stream":true,"stream_options":{"include_usage":true}}');
      expect(thought).toBe(THOUGHT);
    });
    for (const [name, extra] of [
      ["include false", { include_reasoning: false }],
      ["summary none", { reasoning: { summary: "none" } }],
      ["thinking disabled", { thinking: { type: "disabled" } }],
      ["reasoning disabled", { reasoning: { enabled: false } }],
      ["none effort", { reasoning_effort: "none" }],
      ["include false with effort", { include_reasoning: false, reasoning_effort: "high" }],
    ] as const) {
      test(`${lane}: ${name} hides raw text`, async () => {
        expect(await dispatch(direct, stream, extra)).toBe("");
      });
    }
    test(`${lane}: explicit summary retains precedence over include false`, async () => {
      expect(await dispatch(direct, stream, { include_reasoning: false, reasoning: { summary: "auto" } })).toBe(THOUGHT);
    });
    test(`${lane}: provider hideRawReasoning still wins`, async () => {
      expect(await dispatch(direct, stream, {}, true)).toBe("");
    });
    test(`${lane}: existing inline think tags use the same raw delivery default`, async () => {
      inlineTags = true;
      expect(await dispatch(direct, stream)).toBe(THOUGHT);
    });
    test(`${lane}: explicit enabled wins over none effort`, async () => {
      expect(await dispatch(direct, stream, { reasoning: { enabled: true, effort: "none" } })).toBe(THOUGHT);
    });
    test(`${lane}: a configured Droid default effort is not a caller hide request`, async () => {
      // The exported Droid header supplies a generation default, applied after routing; it must not
      // be read back as the caller's delivery choice.
      expect(await dispatch(direct, stream, {}, false,
        { "x-opencodex-droid-default-effort": "none" }, { reasoningEfforts: ["none", "low", "high"] })).toBe(THOUGHT);
    });
  }

  test("translation and parsed upstream controls retain their dev values", () => {
    expect(chatCompletionsToResponsesBody(chatBody())).not.toHaveProperty("reasoning");
    const plain = parseRequest(chatCompletionsToResponsesBody(chatBody()));
    expect(plain.options.hideThinkingSummary).toBe(true);
    expect(plain.options.reasoning).toBeUndefined();
    expect(plain.options.thinkingEnabled).toBeUndefined();
    const disabled = parseRequest(chatCompletionsToResponsesBody(chatBody({ thinking: { type: "disabled" } })));
    expect(disabled.options.thinkingEnabled).toBe(false);
    const effort = parseRequest(chatCompletionsToResponsesBody(chatBody({ include_reasoning: false, reasoning_effort: "high" })));
    expect(effort.options.reasoning).toBe("high");
    expect(effort.options.hideThinkingSummary).toBe(true);
  });

  for (const stream of [true, false]) test(`Responses ingress still hides omitted-summary raw reasoning, stream=${stream}`, async () => {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/gpt-4o", input: "fixture", stream }),
    }), config(false), { model: "", provider: "" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(THOUGHT);
    expect(text).toContain(ANSWER);
    expect(text).toContain("ocxr1:");
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("reasoning");
  });

  test("a plain Chat request to the Responses serializer gains no reasoning field", async () => {
    const cfg = config(false);
    cfg.providers.fixture!.adapter = "openai-responses";
    saveConfig(cfg);
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://chat-reasoning.invalid/v1/responses");
      bodies.push(String(init?.body));
      return new Response([
        { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: ANSWER },
        { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [
          { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: ANSWER }] },
        ] } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody({ stream: true })),
    }), cfg, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(ANSWER);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).not.toHaveProperty("reasoning");
  });

  test("the delivery override opens raw text only, including the JSON bridge fold", async () => {
    const events: AdapterEvent[] = [
      { type: "thinking_delta", thinking: "FIXTURE_SUMMARY" },
      { type: "reasoning_raw_delta", text: THOUGHT },
      { type: "text_delta", text: ANSWER }, { type: "done" },
    ];
    const replay = async function* () { yield* events; };
    const options = { translatorBudget: createTestTranslatorBudget(), hideThinkingSummary: true, chatRawReasoningVisible: true };
    const json = buildResponseJSON(events, "fixture", options);
    const buffered = responsesJsonToChatCompletion(json, "fixture", options.translatorBudget);
    expect((buffered as Rec).choices[0].message.reasoning_content).toBe(THOUGHT);
    const bridged = bridgeToResponsesSSE(replay(), "fixture", undefined, undefined, undefined, undefined, 2_000, options);
    const text = await new Response(responsesSseToChatCompletionsSse(bridged, "fixture", options)).text();
    expect(text).toContain(THOUGHT);
    expect(text).not.toContain("FIXTURE_SUMMARY");
    const direct = await (await foldChatCompletion(replay(), { ...options, model: "fixture" })).json() as Rec;
    expect(direct.choices[0].message.reasoning_content).toBe(THOUGHT);
  });
});
