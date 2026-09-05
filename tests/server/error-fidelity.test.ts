import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, formatErrorResponse } from "../../src/bridge";
import {
  adapterFailureFromMessage,
  classifyError,
  httpStatusFromTerminalError,
  isLocationUnsupportedMessage,
} from "../../src/lib/errors";
import { sanitizePassthroughHeaders } from "../../src/server";
import type { AdapterEvent } from "../../src/types";

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

describe("error fidelity", () => {
  test("classifyError maps Codex-recognized context/quota/rate failures", () => {
    expect(classifyError(400, "upstream_error", "Your input exceeds the context window")).toMatchObject({
      type: "invalid_request_error",
      code: "context_length_exceeded",
    });
    expect(classifyError(429, "upstream_error", "Rate limit reached for model")).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });
    expect(classifyError(402, "upstream_error", "You exceeded your current quota")).toMatchObject({
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
    expect(classifyError(403, "origin_rejected", "WebSocket upgrade blocked: non-local Origin")).toMatchObject({
      type: "invalid_request_error",
      code: "origin_rejected",
    });
    const subscription = "this model requires a subscription, upgrade for access: https://ollama.com/upgrade";
    expect(classifyError(403, "upstream_error", "Provider error 403")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
    expect(classifyError(403, "upstream_error", "Access denied")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
    expect(classifyError(403, "upstream_error", subscription)).toMatchObject({
      type: "permission_error",
      code: "subscription_required",
    });
    expect(classifyError(401, "upstream_error", subscription)).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(classifyError(403, "authentication_error", subscription)).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(classifyError(400, "permission_error", subscription)).toMatchObject({
      type: "permission_error",
      code: "subscription_required",
    });
    expect(classifyError(400, "upstream_error", subscription)).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    expect(classifyError(502, "upstream_error", "Kiro rate limit exceeded: ThrottlingException: rate limited")).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
    });
    expect(classifyError(502, "upstream_error", "Kiro authentication failed: AccessDeniedException: expired token")).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(classifyError(502, "upstream_error", "Kiro invalid request: ValidationException: model not found")).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request_error",
    });
    expect(classifyError(502, "upstream_error", "Kiro quota exhausted: monthly quota exceeded")).toMatchObject({
      type: "insufficient_quota",
      code: "insufficient_quota",
    });
  });

  test("formatErrorResponse returns OpenAI-compatible classified error envelope", async () => {
    const response = formatErrorResponse(429, "upstream_error", "Rate limit reached for model");
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Rate limit reached for model",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    });
  });

  test("streaming response.failed includes both error and last_error", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "error", message: "Your input exceeds the context window" },
    ]), "routed/model"));
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect(failed.error).toMatchObject({
      type: "invalid_request_error",
      code: "context_length_exceeded",
    });
    expect(failed.last_error).toEqual(failed.error);
  });

  test("sanitizePassthroughHeaders drops stale and hop-by-hop headers while preserving rate-limit metadata", () => {
    const sanitized = sanitizePassthroughHeaders(new Headers({
      "content-encoding": "gzip",
      "content-length": "12",
      "connection": "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "te": "trailers",
      "trailer": "x-checksum",
      "upgrade": "websocket",
      "x-ratelimit-limit-requests": "100",
      "openai-model": "gpt-5.5",
      "content-type": "application/json",
    }));
    expect(sanitized.has("content-encoding")).toBe(false);
    expect(sanitized.has("content-length")).toBe(false);
    expect(sanitized.has("connection")).toBe(false);
    expect(sanitized.has("keep-alive")).toBe(false);
    expect(sanitized.has("proxy-authenticate")).toBe(false);
    expect(sanitized.has("te")).toBe(false);
    expect(sanitized.has("trailer")).toBe(false);
    expect(sanitized.has("upgrade")).toBe(false);
    expect(sanitized.get("x-ratelimit-limit-requests")).toBe("100");
    expect(sanitized.get("openai-model")).toBe("gpt-5.5");
    expect(sanitized.get("content-type")).toBe("application/json");
  });
});

describe("overload and transient-429 classification (F3)", () => {
  test("location denials classify as permission_error / location_not_supported, not invalid_request (#3467)", async () => {
    const message = "Antigravity location not supported: User location is not supported for the API use.";
    expect(isLocationUnsupportedMessage(message)).toBe(true);
    expect(isLocationUnsupportedMessage("Precondition check failed.")).toBe(false);

    expect(classifyError(400, "upstream_error", message)).toMatchObject({
      type: "permission_error",
      code: "location_not_supported",
    });
    expect(classifyError(400, "location_not_supported", "denied")).toMatchObject({
      type: "permission_error",
      code: "location_not_supported",
    });
    // Raw upstream wording (no adapter normalization) classifies the same way.
    expect(classifyError(400, "upstream_error", "USER LOCATION IS NOT SUPPORTED for the API use.")).toMatchObject({
      code: "location_not_supported",
    });

    // The direct HTTP envelope keeps the upstream status.
    const response = formatErrorResponse(400, "upstream_error", message);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: unknown }).error).toMatchObject({
      type: "permission_error",
      code: "location_not_supported",
    });

    // Message-only adapter terminals and classified terminal envelopes agree on 403 (permission class).
    const failure = adapterFailureFromMessage(message);
    expect(failure.httpStatus).toBe(403);
    expect(failure.error).toMatchObject({ type: "permission_error", code: "location_not_supported" });
    expect(httpStatusFromTerminalError(failure.error)).toBe(403);
  });

  test("authentication and rate-limit signals outrank location wording", () => {
    expect(classifyError(401, "upstream_error", "location is not supported (token expired)")).toMatchObject({
      type: "authentication_error",
    });
    expect(classifyError(429, "upstream_error", "rate limit exceeded; location not supported")).toMatchObject({
      type: "rate_limit_error",
    });
    expect(adapterFailureFromMessage("Antigravity authentication failed: location is not supported").httpStatus).toBe(401);
  });

  test("503 / overloaded maps to the Codex-recognized server_is_overloaded", () => {
    expect(classifyError(503, "upstream_error", "The server is overloaded")).toMatchObject({
      type: "server_error",
      code: "server_is_overloaded",
    });
    expect(classifyError(500, "upstream_error", "model is currently overloaded")).toMatchObject({
      code: "server_is_overloaded",
    });
  });

  test("authoritative 5xx statuses outrank mixed location wording (#3467)", () => {
    const message = "User location is not supported for the API use.";
    for (const status of [500, 502, 503, 504]) {
      expect(classifyError(status, "upstream_error", message)).toEqual({
        message,
        type: "server_error",
        code: status === 503 ? "server_is_overloaded" : "upstream_server_error",
      });
    }
    expect(classifyError(503, "server_error", `Server temporarily unavailable: ${message}`)).toMatchObject({
      type: "server_error",
      code: "server_is_overloaded",
    });
  });

  test("explicit PERMISSION_DENIED wording keeps its reason beside location wording (#3467)", () => {
    const message = "PERMISSION_DENIED: User location is not supported for the API use.";
    expect(classifyError(400, "upstream_error", message)).toEqual({
      message,
      type: "permission_error",
      code: "permission_denied",
    });
    expect(adapterFailureFromMessage(message)).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "permission_denied" },
    });
    expect(classifyError(400, "PERMISSION_DENIED", "location not supported")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
  });

  test("transient 429 quota bucket stays retryable (rate_limit_exceeded), delay text preserved", () => {
    const r = classifyError(429, "upstream_error", "You have exceeded your quota for requests per min. Please try again in 5s");
    expect(r.code).toBe("rate_limit_exceeded");
    expect(r.message).toContain("try again in 5s");
  });

  test("real exhaustion still maps to fatal insufficient_quota", () => {
    expect(classifyError(402, "upstream_error", "You exceeded your current quota")).toMatchObject({
      code: "insufficient_quota",
    });
  });
});
