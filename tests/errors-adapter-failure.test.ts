import { describe, expect, test } from "bun:test";
import {
  adapterFailureFromMessage,
  classifyError,
  parseRetryAfterFromMessage,
} from "../src/lib/errors";
import { bufferCompactResponse } from "../src/server/responses";

describe("adapterFailureFromMessage", () => {
  test("maps resource_exhausted to 429 rate_limit_error", () => {
    const message = "Cursor rate limit exceeded: Cursor Connect error resource_exhausted: too many requests";
    expect(adapterFailureFromMessage(message)).toMatchObject({
      httpStatus: 429,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
  });

  test("parses retry-after hints from upstream text", () => {
    const message = "rate limit exceeded: try again in 12.5 seconds";
    expect(parseRetryAfterFromMessage(message)).toBe(13);
    expect(adapterFailureFromMessage(message).error.message).toContain("Please try again in 13s.");
  });

  test("maps authentication failures to 401", () => {
    expect(adapterFailureFromMessage("Cursor authentication failed: unauthorized")).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error" },
    });
  });

  test("maps forbidden and subscription gates to 403 permission errors", () => {
    expect(adapterFailureFromMessage("Provider stream error: forbidden")).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "permission_denied" },
    });
    expect(adapterFailureFromMessage(
      "this model requires a subscription, upgrade for access: https://ollama.com/upgrade",
    )).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "subscription_required" },
    });
  });

  test("generic access denied is permission, while credential-qualified access denied is auth", () => {
    expect(adapterFailureFromMessage("Access denied")).toMatchObject({
      httpStatus: 403,
      error: { type: "permission_error", code: "permission_denied" },
    });
    expect(adapterFailureFromMessage("AccessDeniedException: security token expired")).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });

  test("authentication cues win over subscription wording", () => {
    expect(adapterFailureFromMessage(
      "authentication failed: invalid token; upgrade subscription for access",
    )).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });

  test("standalone authentication cues remain authentication errors", () => {
    expect(adapterFailureFromMessage("Authentication required")).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });

  test("maps client-closed web-search aborts to 499 client_closed_request", () => {
    expect(adapterFailureFromMessage("client closed request during web-search")).toMatchObject({
      httpStatus: 499,
      error: { type: "invalid_request_error", code: "client_closed_request" },
    });
    expect(adapterFailureFromMessage("Client cancelled request")).toMatchObject({
      httpStatus: 499,
      error: { code: "client_closed_request" },
    });
    expect(adapterFailureFromMessage("search request canceled by client")).toMatchObject({
      httpStatus: 499,
      error: { code: "client_closed_request" },
    });
  });

  test("preserves explicit client_cancelled JSON error type from compact/combo paths", () => {
    expect(classifyError(499, "client_cancelled", "Client cancelled request")).toMatchObject({
      type: "client_cancelled",
      code: "client_cancelled",
    });
  });

  test("upstream failures that merely mention a closed client stay 502 (matcher is narrow)", () => {
    // A real upstream error wording — must NOT be reclassified as a client cancel.
    expect(adapterFailureFromMessage("upstream HTTP client closed idle connection")).toMatchObject({
      httpStatus: 502,
      error: { code: "upstream_server_error" },
    });
    expect(adapterFailureFromMessage("connection closed by upstream client pool")).toMatchObject({
      httpStatus: 502,
    });
  });

  test("an aborted compact request activates the 499 client_cancelled branch", async () => {
    // Drive the real compact cancellation path: a mid-stream abort while buffering.
    const controller = new AbortController();
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("{\"partial\":"));
        controller.abort(); // client goes away mid-buffer
        streamController.enqueue(new TextEncoder().encode("true}"));
        streamController.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const response = await bufferCompactResponse(upstream, controller.signal);

    expect(response.status).toBe(499);
    const body = await response.json() as { error?: { type?: string; code?: string } };
    expect(body.error).toMatchObject({ type: "client_cancelled", code: "client_cancelled" });
  });
});
