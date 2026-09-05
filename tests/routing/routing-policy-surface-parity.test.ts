import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { evidenceFromBody } from "../../src/routing/request-evidence";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import { readUsageEntries } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MODEL = "policy/daily";
const EXPECTED_RICH_EVIDENCE = {
  toolsRequired: true,
  imageInputRequired: true,
};

describe("routing policy request evidence parity (translator-level coverage)", () => {
  test("tools and image input produce the same evidence across Responses, Chat Completions, and Claude Messages", () => {
    const responsesBody = {
      model: MODEL,
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect this" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      }],
      tools: [{
        type: "function",
        name: "inspect",
        parameters: { type: "object", properties: {} },
      }],
    };

    const chatBody = chatCompletionsToResponsesBody({
      model: MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      }],
      tools: [{
        type: "function",
        function: {
          name: "inspect",
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    const claudeBody = anthropicToResponsesTranslation({
      model: MODEL,
      max_tokens: 128,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AA==",
            },
          },
        ],
      }],
      tools: [{
        name: "inspect",
        input_schema: { type: "object", properties: {} },
      }],
    }).body;

    expect(evidenceFromBody(responsesBody)).toEqual(EXPECTED_RICH_EVIDENCE);
    expect(evidenceFromBody(chatBody)).toEqual(EXPECTED_RICH_EVIDENCE);
    expect(evidenceFromBody(claudeBody)).toEqual(EXPECTED_RICH_EVIDENCE);
  });

  test("plain text without tools produces no hard routing evidence on every surface", () => {
    const responsesBody = {
      model: MODEL,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
    };

    const chatBody = chatCompletionsToResponsesBody({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    });

    const claudeBody = anthropicToResponsesTranslation({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    }).body;

    expect(evidenceFromBody(responsesBody)).toEqual({});
    expect(evidenceFromBody(chatBody)).toEqual({});
    expect(evidenceFromBody(claudeBody)).toEqual({});
  });
});

// ---- Handler-level parity tests (via dev handler entry points) ----

const actualResolver = await import("../../src/server/adapter-resolve");
let adapterFactory: ((provider: OcxProviderConfig) => ProviderAdapter) | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    return adapterFactory?.(provider) ?? actualResolver.resolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses, handleResponsesCompact } = await import("../../src/server/responses");
const { handleChatCompletions } = await import("../../src/server/chat-completions");
const { handleClaudeMessages } = await import("../../src/server/claude-messages");

afterEach(() => {
  adapterFactory = undefined;
});

function testConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.test/v1",
        authMode: "key",
        apiKey: "fixture-key",
        models: ["m1"],
        modelContextWindows: { m1: 200_000 },
        modelInputModalities: { m1: ["text", "image"] },
        parallelToolCalls: true,
      },
    },
    routingProfiles: {
      daily: { candidates: [{ provider: "a", model: "m1" }] },
    },
  } as OcxConfig;
}

function minimalSuccessAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "test-run-turn",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "test runTurn adapter does not use parseStream" };
    },
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "ok" });
      emit({ type: "done" });
    },
  };
}

describe("routing policy request evidence parity (via dev handlers)", () => {
  test("finalized Chat and Messages policy errors retain the rejected selector", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-policy-log-"));
    process.env.OPENCODEX_HOME = home;
    clearRequestLogsForTests();
    try {
      for (const [wire, handler, body] of [
        ["chat", handleChatCompletions, { model: "policy/missing", messages: [{ role: "user", content: "hello" }] }],
        ["messages", handleClaudeMessages, { model: "policy/missing", max_tokens: 64, messages: [{ role: "user", content: "hello" }] }],
      ] as const) {
        const requestId = `policy-log-${wire}`;
        const path = wire === "chat" ? "/v1/chat/completions" : "/v1/messages";
        const response = await handler(new Request(`http://localhost${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }), testConfig(), { model: "", provider: "" }, { requestId, start: Date.now() });
        expect(response.status).toBe(404);
        const entry = readUsageEntries().find(row => row.requestId === requestId);
        expect(entry?.requestedModel).toBe("policy/missing");
        expect(entry?.status).toBe(404);
      }
    } finally {
      clearRequestLogsForTests();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });
  test("missing and empty policies return compatible 404s on every wire before adapter resolution", async () => {
    let adapterCalls = 0;
    adapterFactory = provider => {
      adapterCalls += 1;
      return minimalSuccessAdapter(provider);
    };
    for (const model of ["policy/missing", "policy/"]) {
      for (const stream of [false, true]) {
        const bodies = [
          { path: "/v1/responses", handler: handleResponses, body: { model, stream, input: "hello" } },
          { path: "/v1/chat/completions", handler: handleChatCompletions, body: { model, stream, messages: [{ role: "user", content: "hello" }] } },
          { path: "/v1/messages", handler: handleClaudeMessages, body: { model, stream, max_tokens: 64, messages: [{ role: "user", content: "hello" }] } },
          { path: "/v1/responses/compact", handler: handleResponsesCompact, body: { model, stream, input: "hello" } },
        ];
        for (const { path, handler, body } of bodies) {
          const log: RequestLogContext = { model: "", provider: "" };
          const response = await handler(new Request(`http://localhost${path}`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          }), testConfig(), log);
          expect(response.status).toBe(404);
          const payload = await response.json() as { error: { type: string; message: string } };
          expect(payload.error.type).toBe("invalid_request_error");
          expect(payload.error.message).toStartWith("Unknown routing policy:");
          expect(log.routeDecision).toBeUndefined();
          expect(adapterCalls).toBe(0);
        }
      }
    }
  });
  test("rich evidence (tools + image) produces identical route decision across all three surfaces", async () => {
    adapterFactory = minimalSuccessAdapter;
    const config = testConfig();

    // Responses: native input[] shape
    const responsesLogCtx: RequestLogContext = { model: "", provider: "" };
    const responsesReq = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect this" },
            { type: "input_image", image_url: "data:image/png;base64,AA==" },
          ],
        }],
        tools: [{
          type: "function",
          name: "inspect",
          parameters: { type: "object", properties: {} },
        }],
      }),
    });
    const responsesResponse = await handleResponses(responsesReq, config, responsesLogCtx);
    await responsesResponse.text();

    // Chat Completions: OpenAI messages[] shape
    const chatLogCtx: RequestLogContext = { model: "", provider: "" };
    const chatReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        }],
        tools: [{
          type: "function",
          function: {
            name: "inspect",
            parameters: { type: "object", properties: {} },
          },
        }],
      }),
    });
    const chatResponse = await handleChatCompletions(chatReq, config, chatLogCtx);
    await chatResponse.text();

    // Claude Messages: Anthropic messages[] shape
    const claudeLogCtx: RequestLogContext = { model: "", provider: "" };
    const claudeReq = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "fixture-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 128,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "AA==",
              },
            },
          ],
        }],
        tools: [{
          name: "inspect",
          input_schema: { type: "object", properties: {} },
        }],
      }),
    });
    const claudeResponse = await handleClaudeMessages(claudeReq, config, claudeLogCtx);
    await claudeResponse.text();

    // All three surfaces should select the same provider/model
    expect(responsesLogCtx.provider).toBe("a");
    expect(responsesLogCtx.model).toBe("m1");
    expect(chatLogCtx.provider).toBe("a");
    expect(chatLogCtx.model).toBe("m1");
    expect(claudeLogCtx.provider).toBe("a");
    expect(claudeLogCtx.model).toBe("m1");

    // All three surfaces should report satisfied requirements for tools and image
    expect(responsesLogCtx.routeDecision).toBeDefined();
    expect(chatLogCtx.routeDecision).toBeDefined();
    expect(claudeLogCtx.routeDecision).toBeDefined();

    const responsesToolsReq = responsesLogCtx.routeDecision!.requirements.find(r => r.id === "request-tools");
    const responsesImageReq = responsesLogCtx.routeDecision!.requirements.find(r => r.id === "request-image-input");
    expect(responsesToolsReq?.outcome).toBe("satisfied");
    expect(responsesImageReq?.outcome).toBe("satisfied");

    const chatToolsReq = chatLogCtx.routeDecision!.requirements.find(r => r.id === "request-tools");
    const chatImageReq = chatLogCtx.routeDecision!.requirements.find(r => r.id === "request-image-input");
    expect(chatToolsReq?.outcome).toBe("satisfied");
    expect(chatImageReq?.outcome).toBe("satisfied");

    const claudeToolsReq = claudeLogCtx.routeDecision!.requirements.find(r => r.id === "request-tools");
    const claudeImageReq = claudeLogCtx.routeDecision!.requirements.find(r => r.id === "request-image-input");
    expect(claudeToolsReq?.outcome).toBe("satisfied");
    expect(claudeImageReq?.outcome).toBe("satisfied");
  });

  test("plain text with no tools produces no hard requirements on every surface", async () => {
    adapterFactory = minimalSuccessAdapter;
    const config = testConfig();

    // Responses: simple text input
    const responsesLogCtx: RequestLogContext = { model: "", provider: "" };
    const responsesReq = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        }],
      }),
    });
    const responsesResponse = await handleResponses(responsesReq, config, responsesLogCtx);
    await responsesResponse.text();

    // Chat Completions: simple text message
    const chatLogCtx: RequestLogContext = { model: "", provider: "" };
    const chatReq = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const chatResponse = await handleChatCompletions(chatReq, config, chatLogCtx);
    await chatResponse.text();

    // Claude Messages: simple text message
    const claudeLogCtx: RequestLogContext = { model: "", provider: "" };
    const claudeReq = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "fixture-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    const claudeResponse = await handleClaudeMessages(claudeReq, config, claudeLogCtx);
    await claudeResponse.text();

    // All three surfaces should select the same provider/model
    expect(responsesLogCtx.provider).toBe("a");
    expect(responsesLogCtx.model).toBe("m1");
    expect(chatLogCtx.provider).toBe("a");
    expect(chatLogCtx.model).toBe("m1");
    expect(claudeLogCtx.provider).toBe("a");
    expect(claudeLogCtx.model).toBe("m1");

    // All three surfaces should have NO request-tools or request-image-input requirements
    expect(responsesLogCtx.routeDecision).toBeDefined();
    expect(chatLogCtx.routeDecision).toBeDefined();
    expect(claudeLogCtx.routeDecision).toBeDefined();

    const responsesHasTools = responsesLogCtx.routeDecision!.requirements.some(r => r.id === "request-tools");
    const responsesHasImage = responsesLogCtx.routeDecision!.requirements.some(r => r.id === "request-image-input");
    expect(responsesHasTools).toBe(false);
    expect(responsesHasImage).toBe(false);

    const chatHasTools = chatLogCtx.routeDecision!.requirements.some(r => r.id === "request-tools");
    const chatHasImage = chatLogCtx.routeDecision!.requirements.some(r => r.id === "request-image-input");
    expect(chatHasTools).toBe(false);
    expect(chatHasImage).toBe(false);

    const claudeHasTools = claudeLogCtx.routeDecision!.requirements.some(r => r.id === "request-tools");
    const claudeHasImage = claudeLogCtx.routeDecision!.requirements.some(r => r.id === "request-image-input");
    expect(claudeHasTools).toBe(false);
    expect(claudeHasImage).toBe(false);
  });
});
