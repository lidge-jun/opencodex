import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../src/bridge";
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
import { handleResponses } from "../src/server/responses";
import type { AdapterEvent, OcxConfig } from "../src/types";
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

const SECRET_CYBER_MESSAGE = `${OPENAI_CYBER_MESSAGE} Authorization: ${["Bear", "er"].join("")} cybersecret123456`;
const REDACTED_CYBER_MESSAGE = `${OPENAI_CYBER_MESSAGE} Authorization: Bearer [REDACTED]`;

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
      type: CYBER_POLICY_ERROR_CODE,
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
      error: { type: CYBER_POLICY_ERROR_CODE, code: CYBER_POLICY_ERROR_CODE },
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
        type: CYBER_POLICY_ERROR_CODE,
        code: CYBER_POLICY_ERROR_CODE,
      },
    });

    const fromCode = formatErrorResponse(502, "server_error", "blocked by safety", {
      code: CYBER_POLICY_ERROR_CODE,
      retryAfter: "120",
    });
    expect(fromCode.status).toBe(400);
    expect(fromCode.headers.get("retry-after")).toBeNull();
    await expect(fromCode.json()).resolves.toMatchObject({
      error: { code: CYBER_POLICY_ERROR_CODE, type: "server_error" },
    });
  });

  test("passthrough HTTP 400 cyber body is relayed verbatim", async () => {
    const body = JSON.stringify(CYBER_ERROR_BODY);
    const response = formatPassthroughUpstreamError(400, body, {
      headers: new Headers({ "content-type": "application/json", "retry-after": "120" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("retry-after")).toBeNull();

    const codeOnlyBody = JSON.stringify({
      error: { message: "blocked by policy", type: "server_error", code: CYBER_POLICY_ERROR_CODE },
    });
    const codeOnlyResponse = formatPassthroughUpstreamError(400, codeOnlyBody, {
      headers: new Headers({ "content-type": "application/json", "retry-after": "120" }),
    });
    expect(await codeOnlyResponse.text()).toBe(codeOnlyBody);
    expect(codeOnlyResponse.headers.get("retry-after")).toBeNull();
  });

  test("consumeComboFailure preserves cyber_policy code as HTTP 400", async () => {
    const upstream = new Response(JSON.stringify(CYBER_ERROR_BODY), {
      status: 400,
      headers: { "retry-after": "120" },
    });
    const failure = await consumeComboFailure(upstream);
    expect(failure.response.status).toBe(400);
    expect(failure.response.headers.get("retry-after")).toBeNull();
    expect(failure.upstreamCode).toBe(CYBER_POLICY_ERROR_CODE);
    await expect(failure.response.json()).resolves.toMatchObject({
      error: {
        code: CYBER_POLICY_ERROR_CODE,
        type: "invalid_request",
        message: OPENAI_CYBER_MESSAGE,
      },
    });
  });

  test("ordinary Responses HTTP failure preserves structured cyber type and exact safe message", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          error: {
            message: SECRET_CYBER_MESSAGE,
            type: "server_error",
            code: CYBER_POLICY_ERROR_CODE,
          },
        }, { status: 400, headers: { "retry-after": "120" } });
      },
    });
    const config = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          apiKey: "fixture-key",
          allowPrivateNetwork: true,
        },
      },
    } as OcxConfig;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock/test-model", input: "hello", stream: false }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(response.headers.get("retry-after")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: {
          message: REDACTED_CYBER_MESSAGE,
          type: "server_error",
          code: CYBER_POLICY_ERROR_CODE,
        },
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("message-only combo cyber failures preserve structured type and redact the message", async () => {
    const upstream = new Response(JSON.stringify({
      error: { type: "server_error", message: SECRET_CYBER_MESSAGE },
    }), { status: 400 });
    const failure = await consumeComboFailure(upstream);
    expect(failure.response.status).toBe(400);
    expect(failure.upstreamCode).toBe(CYBER_POLICY_ERROR_CODE);
    await expect(failure.response.json()).resolves.toMatchObject({
      error: {
        type: "server_error",
        code: CYBER_POLICY_ERROR_CODE,
        message: REDACTED_CYBER_MESSAGE,
      },
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

    expect(events.find(e => e.type === "error")).toMatchObject({ errorType: "invalid_request" });
    const frames = await collectSse(bridgeToResponsesSSE(replay(events), "openai/gpt-5.4"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({
      type: "invalid_request",
      code: CYBER_POLICY_ERROR_CODE,
      message: OPENAI_CYBER_MESSAGE,
    });
    expect(failed.last_error).toEqual(failed.error);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("message-only cyber adapter error still classifies (no silent 502)", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "error", message: SECRET_CYBER_MESSAGE, retryable: true },
    ]), "openai/gpt-5.4"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({
      type: CYBER_POLICY_ERROR_CODE,
      code: CYBER_POLICY_ERROR_CODE,
      message: REDACTED_CYBER_MESSAGE,
    });
    expect(failed.retryable).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("cybersecret123456");

    const buffered = buildResponseJSON([
      { type: "error", message: SECRET_CYBER_MESSAGE, retryable: true },
    ], "openai/gpt-5.4");
    expect(buffered).toMatchObject({
      status: "failed",
      retryable: false,
      error: { code: CYBER_POLICY_ERROR_CODE, message: REDACTED_CYBER_MESSAGE },
    });
  });

  test("thrown cyber failures are redacted and explicitly non-retryable", async () => {
    async function* throwingEvents(): AsyncGenerator<AdapterEvent> {
      throw new Error(SECRET_CYBER_MESSAGE);
    }
    const frames = await collectSse(bridgeToResponsesSSE(throwingEvents(), "openai/gpt-5.4"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed).toMatchObject({
      status: "failed",
      retryable: false,
      error: {
        type: CYBER_POLICY_ERROR_CODE,
        code: CYBER_POLICY_ERROR_CODE,
        message: REDACTED_CYBER_MESSAGE,
      },
    });
    expect(JSON.stringify(failed)).not.toContain("cybersecret123456");
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
    expect(chatCompletionsErrorBody(400, OPENAI_CYBER_MESSAGE)).toEqual({
      error: {
        message: OPENAI_CYBER_MESSAGE,
        type: CYBER_POLICY_ERROR_CODE,
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
      error: { type: "server_error", code: CYBER_POLICY_ERROR_CODE, param: null },
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
            message: SECRET_CYBER_MESSAGE,
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
      message: REDACTED_CYBER_MESSAGE,
    });
    expect(JSON.stringify(errorFrame?.data)).not.toContain("cybersecret123456");
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

describe("#2488 nested policy identity is not hidden by an outer envelope", () => {
  /**
   * normalizeUpstreamErrorText took the FIRST candidate carrying any string field, while
   * isCyberPolicyBody scans EVERY candidate. A generic outer wrapper therefore won over a
   * nested cyber_policy, so the failure read as an ordinary retryable upstream error - a retry
   * across a safety boundary. Both detectors must agree on the same body.
   */
  const nestedBody = JSON.stringify({
    error: { message: "Upstream request failed" },
    response: {
      last_error: {
        code: CYBER_POLICY_ERROR_CODE,
        type: "policy_violation",
        message: "blocked by policy",
      },
    },
  });

  test("a nested policy code is found behind a generic outer envelope", async () => {
    const failure = await consumeComboFailure(new Response(nestedBody, { status: 502 }));
    expect(failure.upstreamCode).toBe(CYBER_POLICY_ERROR_CODE);
    expect(failure.response.status).toBe(400);
    expect(failure.response.headers.get("retry-after")).toBeNull();
  });

  test("a generic nested error keeps ordinary upstream classification", async () => {
    const genericBody = JSON.stringify({
      error: { message: "Upstream request failed" },
      response: { last_error: { code: "server_error", message: "boom" } },
    });
    const failure = await consumeComboFailure(new Response(genericBody, { status: 502 }));
    expect(failure.upstreamCode).not.toBe(CYBER_POLICY_ERROR_CODE);
    expect(failure.response.status).toBe(502);
  });
});

