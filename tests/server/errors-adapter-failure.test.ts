import { describe, expect, test } from "bun:test";
import {
  adapterFailureFromMessage,
  classifyError,
  extractPolicyRefusalText,
  isUpstreamPolicyRefusal,
  parseRetryAfterFromMessage,
} from "../../src/lib/errors";
import { bufferCompactResponse } from "../../src/server/responses";
import { rewriteUpstreamPolicyRefusal } from "../../src/server/responses/policy-refusal";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { collectSse } from "../helpers/responses-conformance";
import { repoPath } from "../helpers/repo-root";

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

describe("xAI policy-refusal 403", () => {
  test("detects the xAI refusal sentence and not plan/entitlement 403s", () => {
    expect(isUpstreamPolicyRefusal(403, "I can't help with that request.")).toBe(true);
    expect(isUpstreamPolicyRefusal(403, JSON.stringify({ error: "I can't help with that request." }))).toBe(true);
    expect(isUpstreamPolicyRefusal(403, "Provider error 403: I can't help with that request.")).toBe(true);
    expect(isUpstreamPolicyRefusal(200, "I can't help with that request.")).toBe(false);
    expect(isUpstreamPolicyRefusal(403, "You have run out of credits or need a Grok subscription.")).toBe(false);
    expect(isUpstreamPolicyRefusal(403, "The account is not allowed to use this model")).toBe(false);
    expect(isUpstreamPolicyRefusal(403, "forbidden")).toBe(false);
    expect(isUpstreamPolicyRefusal(403, "I can't help with that request!!!")).toBe(true);
    expect(isUpstreamPolicyRefusal(
      403,
      "I can't help with that request. You need a Grok subscription.",
    )).toBe(false);
    expect(isUpstreamPolicyRefusal(
      403,
      "Please retry later; I can't help with that request in this context.",
    )).toBe(false);
    expect(isUpstreamPolicyRefusal(403, "")).toBe(false);
    expect(isUpstreamPolicyRefusal(403, "   ")).toBe(false);
  });

  test("extracts the refusal sentence from JSON and prefixed bodies", () => {
    expect(extractPolicyRefusalText('{"error":"I can\'t help with that request."}'))
      .toBe("I can't help with that request.");
    expect(extractPolicyRefusalText("Provider error 403: I can't help with that request."))
      .toBe("I can't help with that request.");
    expect(extractPolicyRefusalText("")).toBe("");
    expect(extractPolicyRefusalText("   ")).toBe("");
  });

  // The xAI plan and credit phrases guard only the refusal matcher. Adding them to the global
  // subscription classifier turned these message-only errors into 403s elsewhere.
  test("xAI plan and credit wording keeps its existing global classification", () => {
    for (const message of ["You need a Grok subscription to use this model.", "You have run out of credits."]) {
      expect(adapterFailureFromMessage(message).httpStatus).toBe(502);
      expect(isUpstreamPolicyRefusal(403, message)).toBe(false);
    }
  });

  // The proxy's own error text is `Provider error <status>: <upstream JSON>`, so the prefix and
  // the JSON arrive together; stripping only the prefix left a JSON literal to match against.
  test("unwraps a JSON body that still carries the Provider error prefix", () => {
    const body = 'Provider error 403: {"error":"I can\'t help with that request."}';
    expect(extractPolicyRefusalText(body)).toBe("I can't help with that request.");
    expect(isUpstreamPolicyRefusal(403, body)).toBe(true);
  });

  // runAdmittedHttpTurn releases a lease the handler did not transfer as soon as it returns,
  // which would leave the refusal stream outside active-turn accounting while it is delivered.
  test("a streamed refusal keeps its turn lease until the body is read", async () => {
    const budget = createTranslatorBudget();
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    try {
      const response = rewriteUpstreamPolicyRefusal({
        status: 403,
        errorText: JSON.stringify({ error: "I can't help with that request." }),
        stream: true,
        modelId: "grok-4.6",
        destinationIsXai: true,
        translatorBudget: budget,
        turnAdmissionLease: lease!,
      });
      expect(lease!.isTransferred()).toBe(true);
      const active = getActiveTurnCount();
      await response!.text();
      expect(getActiveTurnCount()).toBe(active - 1);
    } finally {
      lease?.release();
      budget.dispose();
    }
  });

  test("rewriteUpstreamPolicyRefusal returns Codex incomplete/content_filter for both wires", async () => {
    const budget = createTranslatorBudget();
    try {
      // Another provider's 403 with the same sentence stays an error: only xAI is rewritten.
      expect(rewriteUpstreamPolicyRefusal({
        status: 403,
        errorText: JSON.stringify({ error: "I can't help with that request." }),
        stream: false,
        modelId: "gpt-5.5",
        destinationIsXai: false,
        translatorBudget: budget,
      })).toBeNull();

      expect(rewriteUpstreamPolicyRefusal({
        status: 403,
        errorText: "You have run out of credits or need a Grok subscription.",
        stream: false,
        modelId: "grok-4.6",
        destinationIsXai: true,
        translatorBudget: budget,
      })).toBeNull();

      const jsonResponse = rewriteUpstreamPolicyRefusal({
        status: 403,
        errorText: JSON.stringify({ error: "I can't help with that request." }),
        stream: false,
        modelId: "grok-4.6",
        destinationIsXai: true,
        translatorBudget: budget,
      });
      expect(jsonResponse?.status).toBe(200);
      const json = await jsonResponse!.json() as {
        status: string;
        incomplete_details?: { reason?: string };
        output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
      };
      expect(json.status).toBe("incomplete");
      expect(json.incomplete_details).toEqual({ reason: "content_filter" });
      const texts = (json.output ?? []).flatMap(item =>
        (item.content ?? []).map(part => part.text).filter((text): text is string => typeof text === "string"),
      );
      expect(texts.join("")).toContain("I can't help with that request.");

      const streamResponse = rewriteUpstreamPolicyRefusal({
        status: 403,
        errorText: "Provider error 403: I can't help with that request.",
        stream: true,
        modelId: "grok-4.6",
        destinationIsXai: true,
        translatorBudget: budget,
      });
      expect(streamResponse?.status).toBe(200);
      expect(streamResponse?.headers.get("content-type")).toContain("text/event-stream");
      const frames = await collectSse(streamResponse!.body!);
      const terminal = frames.find(frame => frame.event === "response.incomplete");
      expect(terminal).toBeDefined();
      const response = terminal!.data.response as { status?: string; incomplete_details?: { reason?: string } };
      expect(response.status).toBe("incomplete");
      expect(response.incomplete_details).toEqual({ reason: "content_filter" });
    } finally {
      budget.dispose();
    }
  });

  test("adapter-dispatch and passthrough-delivery both rewrite non-combo policy 403s", async () => {
    const { readFile } = await import("node:fs/promises");
    const dispatch = await readFile(repoPath("src/server/responses/adapter-dispatch.ts"), "utf8");
    const passthrough = await readFile(repoPath("src/server/responses/passthrough-delivery.ts"), "utf8");
    for (const source of [dispatch, passthrough]) {
      const overflow = source.indexOf("if (upstreamResponse.status === 413)");
      const rewrite = source.indexOf("rewriteUpstreamPolicyRefusal({", overflow);
      expect(overflow).toBeGreaterThan(-1);
      expect(rewrite).toBeGreaterThan(overflow);
      expect(source.slice(rewrite, rewrite + 400)).toContain("destinationIsXai: isXaiResponsesDestination(route.provider)");
    }
    const combo = passthrough.indexOf("if (options.comboAttempt)");
    const rewrite = passthrough.indexOf("rewriteUpstreamPolicyRefusal({");
    expect(combo).toBeGreaterThan(-1);
    expect(combo).toBeLessThan(rewrite);
  });
});
