import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { bridgeToResponsesSSE, formatErrorResponse } from "../src/bridge";
import {
  chatCompletionsErrorBody,
  chatCompletionsErrorResponse,
  responsesSseToChatCompletionsSse as responsesSseToChatCompletionsSseProduction,
} from "../src/chat/outbound";
import { comboFailureDecision } from "../src/combos/failover";
import {
  adapterFailureFromMessage,
  classifyError,
  CYBER_POLICY_ERROR_CODE,
  httpStatusFromTerminalError,
} from "../src/lib/errors";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";
import { consumeComboFailure } from "../src/server/responses/core";
import type { AdapterEvent } from "../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

function responsesSseToChatCompletionsSse(
  upstream: ReadableStream<Uint8Array>,
  model: string,
) {
  return responsesSseToChatCompletionsSseProduction(upstream, model, {
    translatorBudget: createTestTranslatorBudget(),
  });
}

/** Cursor agent transcript (2026-07-24): mangled provider prefix + OpenAI cyber flag copy. */
const CURSOR_SESSION_CYBER_MESSAGE =
  "Unable to reach the model provider OpenAI flagged this request for potential high-risk cybersecurity activity. Please try a less sensitive prompt. Learn more [here](https://platform.openai.com/docs/guides/safety-checks/cybersecurity).";

const OPENAI_CYBER_MESSAGE =
  "OpenAI flagged this request for potential high-risk cybersecurity activity. Please try a less sensitive prompt.";

const CODEX_FALLBACK_MESSAGE = "This request has been flagged for possible cybersecurity risk.";

const CYBER_ERROR_BODY = {
  error: {
    message: OPENAI_CYBER_MESSAGE,
    type: "invalid_request",
    param: null,
    code: CYBER_POLICY_ERROR_CODE,
  },
};

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

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

async function collectAdapter(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("cyber_policy error fidelity", () => {
  test("classifyError maps cyber messages and explicit type to cyber_policy", () => {
    expect(classifyError(400, "upstream_error", OPENAI_CYBER_MESSAGE)).toMatchObject({
      type: "invalid_request_error",
      code: CYBER_POLICY_ERROR_CODE,
    });
    expect(classifyError(502, "upstream_error", CURSOR_SESSION_CYBER_MESSAGE)).toMatchObject({
      code: CYBER_POLICY_ERROR_CODE,
    });
    expect(classifyError(400, "upstream_error", CODEX_FALLBACK_MESSAGE)).toMatchObject({
      code: CYBER_POLICY_ERROR_CODE,
    });
    expect(classifyError(400, CYBER_POLICY_ERROR_CODE, "blocked")).toMatchObject({
      code: CYBER_POLICY_ERROR_CODE,
    });
  });

  test("unrelated 400 stays non-cyber", () => {
    expect(classifyError(400, "upstream_error", "missing required parameter: model")).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    // Bare model-id collision must not become a cyber refusal.
    expect(classifyError(404, "upstream_error", "No provider configured for model: cyber_policy").code)
      .not.toBe(CYBER_POLICY_ERROR_CODE);
  });

  test("adapterFailureFromMessage prefers HTTP 400 + cyber_policy (not 502)", () => {
    expect(adapterFailureFromMessage(OPENAI_CYBER_MESSAGE)).toMatchObject({
      httpStatus: 400,
      error: { type: "invalid_request_error", code: CYBER_POLICY_ERROR_CODE },
    });
    expect(adapterFailureFromMessage(CURSOR_SESSION_CYBER_MESSAGE)).toMatchObject({
      httpStatus: 400,
      error: { code: CYBER_POLICY_ERROR_CODE },
    });
  });

  test("formatErrorResponse remaps status to 400 and preserves explicit upstream code", async () => {
    const fromMessage = formatErrorResponse(502, "upstream_error", OPENAI_CYBER_MESSAGE);
    expect(fromMessage.status).toBe(400);
    await expect(fromMessage.json()).resolves.toEqual({
      error: {
        message: OPENAI_CYBER_MESSAGE,
        type: "invalid_request_error",
        code: CYBER_POLICY_ERROR_CODE,
      },
    });

    const fromCode = formatErrorResponse(502, "upstream_error", "blocked by safety", {
      code: CYBER_POLICY_ERROR_CODE,
    });
    expect(fromCode.status).toBe(400);
    await expect(fromCode.json()).resolves.toMatchObject({
      error: { code: CYBER_POLICY_ERROR_CODE, type: "invalid_request_error" },
    });
  });

  test("passthrough HTTP 400 cyber body is relayed verbatim", async () => {
    const body = JSON.stringify(CYBER_ERROR_BODY);
    const response = formatPassthroughUpstreamError(400, body);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(body);
  });

  test("consumeComboFailure preserves cyber_policy code as HTTP 400", async () => {
    const upstream = new Response(JSON.stringify(CYBER_ERROR_BODY), { status: 400 });
    const failure = await consumeComboFailure(upstream);
    expect(failure.response.status).toBe(400);
    expect(failure.upstreamCode).toBe(CYBER_POLICY_ERROR_CODE);
    await expect(failure.response.json()).resolves.toMatchObject({
      error: { code: CYBER_POLICY_ERROR_CODE, type: "invalid_request_error" },
    });
  });

  test("bridged openai-chat SSE cyber error becomes response.failed with cyber_policy", async () => {
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    });
    const upstream = new Response([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      `data: ${JSON.stringify(CYBER_ERROR_BODY)}\n\n`,
    ].join(""));
    const events = await collectAdapter(adapter.parseStream(upstream));
    expect(events.find(e => e.type === "error")).toMatchObject({
      message: OPENAI_CYBER_MESSAGE,
      code: CYBER_POLICY_ERROR_CODE,
      status: 400,
    });

    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
      {
        type: "error",
        message: OPENAI_CYBER_MESSAGE,
        code: CYBER_POLICY_ERROR_CODE,
        status: 400,
      },
    ]), "openai/gpt-5.4"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({
      type: "invalid_request_error",
      code: CYBER_POLICY_ERROR_CODE,
      message: OPENAI_CYBER_MESSAGE,
    });
    expect(failed.last_error).toEqual(failed.error);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("message-only cyber adapter error still classifies (no silent 502)", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "error", message: OPENAI_CYBER_MESSAGE },
    ]), "openai/gpt-5.4"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({ code: CYBER_POLICY_ERROR_CODE });
  });

  test("chat completions error envelope preserves cyber_policy and model_not_found", async () => {
    expect(chatCompletionsErrorBody(400, OPENAI_CYBER_MESSAGE, "invalid_request_error", CYBER_POLICY_ERROR_CODE)).toEqual({
      error: {
        message: OPENAI_CYBER_MESSAGE,
        type: "invalid_request_error",
        param: null,
        code: CYBER_POLICY_ERROR_CODE,
      },
    });
    expect(chatCompletionsErrorBody(404, "model not found", "invalid_request_error")).toEqual({
      error: {
        message: "model not found",
        type: "invalid_request_error",
        param: null,
        code: "model_not_found",
      },
    });
    const response = chatCompletionsErrorResponse(502, OPENAI_CYBER_MESSAGE, "server_error");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: CYBER_POLICY_ERROR_CODE, param: null },
    });
    // Non-cyber classification must not rewrite HTTP status.
    const rateLimited = chatCompletionsErrorResponse(502, "Rate limit reached for model", "server_error");
    expect(rateLimited.status).toBe(502);
    await expect(rateLimited.json()).resolves.toMatchObject({
      error: { type: "server_error", code: null },
    });
  });

  test("Responses SSE cyber response.failed maps to chat completions error frame with code", async () => {
    const responsesSse = [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.failed\n",
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            message: OPENAI_CYBER_MESSAGE,
            type: "invalid_request_error",
            code: CYBER_POLICY_ERROR_CODE,
          },
        },
      })}\n\n`,
    ].join("");
    const chatSse = responsesSseToChatCompletionsSse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(responsesSse));
          controller.close();
        },
      }),
      "gpt-5.4",
    );
    const frames = await collectSse(chatSse);
    const errorFrame = frames.find(frame => frame.data.error);
    expect(errorFrame?.data.error).toMatchObject({
      code: CYBER_POLICY_ERROR_CODE,
      type: "invalid_request_error",
      message: OPENAI_CYBER_MESSAGE,
    });
  });

  test("openai-chat cyber_policy forces HTTP 400 even when upstream status is 5xx", async () => {
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "key",
    });
    const streamEvents = await collectAdapter(adapter.parseStream(new Response([
      `data: ${JSON.stringify({
        error: { message: OPENAI_CYBER_MESSAGE, code: CYBER_POLICY_ERROR_CODE, status: 502 },
      })}\n\n`,
    ].join(""))));
    expect(streamEvents.find(e => e.type === "error")).toMatchObject({
      code: CYBER_POLICY_ERROR_CODE,
      status: 400,
    });

    const nonStream = await adapter.parseResponse!(new Response(JSON.stringify({
      error: { message: OPENAI_CYBER_MESSAGE, code: CYBER_POLICY_ERROR_CODE, status: 500 },
    })));
    expect(nonStream).toEqual([{
      type: "error",
      message: OPENAI_CYBER_MESSAGE,
      code: CYBER_POLICY_ERROR_CODE,
      status: 400,
    }]);
  });

  test("httpStatusFromTerminalError and combo failover treat cyber as non-retryable 400", () => {
    expect(httpStatusFromTerminalError({
      type: "invalid_request_error",
      code: CYBER_POLICY_ERROR_CODE,
      message: OPENAI_CYBER_MESSAGE,
    })).toBe(400);
    expect(comboFailureDecision(400, OPENAI_CYBER_MESSAGE)).toBe("stop");
    expect(comboFailureDecision(502, OPENAI_CYBER_MESSAGE)).toBe("stop");
    // Structured code wins even when the truncated message lacks cyber wording.
    expect(comboFailureDecision(502, "Provider error 502: " + "x".repeat(600), {
      code: CYBER_POLICY_ERROR_CODE,
    })).toBe("stop");
  });
});
