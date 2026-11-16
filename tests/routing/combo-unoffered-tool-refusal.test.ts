import { describe, expect, test } from "bun:test";
import {
  comboFailureCooldownScope,
  comboFailureDecision,
} from "../../src/combos/failover";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";

describe("unoffered tool-call refusal", () => {
  const verdict = "The model called a function that was not offered in tools.";
  // The reported carrier: an aggregator re-wraps the model backend's 400 as
  // `type: "upstream_error"` with `code: null`, then the proxy wraps that envelope again.
  const reported = JSON.stringify({
    error: { message: `Provider error 400: ${verdict}`, type: "upstream_error", code: null },
  });

  test("hops without cooling through every carrier the report shows", () => {
    for (const message of [
      reported,
      `Provider error 400: ${reported}`,
      `data: ${reported}`,
      `Provider error 400: data: ${reported}`,
      verdict,
      `Provider error 400: ${verdict}`,
      JSON.stringify({ message: verdict, type: "upstream_error", code: null }),
      JSON.stringify({ error: verdict, type: "upstream_error", code: null }),
    ]) {
      expect(comboFailureDecision(400, message)).toBe("hop");
      expect(comboFailureCooldownScope(400, message)).toBe("none");
    }
    expect(comboFailureDecision(400, reported, { code: "upstream_error" })).toBe("hop");
    expect(comboFailureCooldownScope(400, reported, { code: "upstream_error" })).toBe("none");
  });

  test("request-validation spellings of the same verdict still hop", () => {
    for (const type of ["invalid_request_error", "upstream_error"]) {
      for (const param of [undefined, "tools", "tool_choice"]) {
        const body = JSON.stringify({
          error: { message: verdict, type, code: null, ...(param ? { param } : {}) },
        });
        expect(comboFailureDecision(400, body)).toBe("hop");
        expect(comboFailureCooldownScope(400, body)).toBe("none");
      }
    }
  });

  test("echoed or competing evidence stays terminal", () => {
    for (const message of [
      // The verdict quoted inside a validation message is reflected text, not a provider verdict.
      JSON.stringify({ error: { message: `Invalid value: "${verdict}"`, type: "invalid_request_error", code: null } }),
      // Trailing content means the sentence is not the whole verdict.
      JSON.stringify({ error: { message: `${verdict} Request id: abc`, type: "upstream_error", code: null } }),
      // A param naming an unrelated field contradicts the refusal.
      JSON.stringify({ error: { message: verdict, type: "invalid_request_error", code: null, param: "messages" } }),
      // A competing diagnostic carrier could hide a hard refusal; fail closed.
      JSON.stringify({ error: { message: verdict, type: "upstream_error", code: null }, details: { code: "cyber_policy" } }),
      // A contradicting root message keeps the root authoritative.
      JSON.stringify({ message: "different failure", type: "upstream_error", error: { message: verdict, type: "upstream_error", code: null } }),
      // A carrier-prefixed root message is peeled and its contents must still support the
      // verdict; `Provider error 400:` alone does not launder a contradiction.
      JSON.stringify({ message: "Provider error 400: Invalid value for tools", type: "upstream_error", error: { message: verdict, type: "upstream_error", code: null } }),
      JSON.stringify({ message: "data: {\"error\":{\"message\":\"different failure\"}}", type: "upstream_error", error: { message: verdict, type: "upstream_error", code: null } }),
      // Codes and types outside the closed sets stay terminal. (`permission_denied` and
      // `rate_limit_exceeded` would hop through their own structured-code rules regardless of
      // the message, so they cannot pin this classifier shut.)
      JSON.stringify({ error: { message: verdict, type: "made_up_type", code: null } }),
      JSON.stringify({ error: { message: verdict, type: "upstream_error", code: "future_unknown_code" } }),
    ]) {
      expect(comboFailureDecision(400, message)).toBe("stop");
    }
  });

  test("non-400 statuses and foreign outer codes stay on the existing rules", () => {
    expect(comboFailureDecision(422, reported)).toBe("stop");
    expect(comboFailureDecision(400, verdict, { code: "unsupported_value" })).toBe("stop");
    expect(comboFailureDecision(400, reported, { code: "rate_limit_exceeded" })).toBe("stop");
  });

  test("the parser control-marker verdict hops the same way", () => {
    const markerVerdict = "The model returned an unexpected parser control marker; no output was published.";
    const markerBody = JSON.stringify({
      error: { message: `Provider error 400: ${markerVerdict}`, type: "upstream_error", code: null },
    });
    for (const message of [markerBody, `Provider error 400: ${markerBody}`, markerVerdict]) {
      expect(comboFailureDecision(400, message)).toBe("hop");
      expect(comboFailureCooldownScope(400, message)).toBe("none");
    }
    // Reflected inside a validation message it stays terminal, same as the tool-call verdict.
    expect(comboFailureDecision(400, JSON.stringify({
      error: { message: `Invalid value: "${markerVerdict}"`, type: "invalid_request_error", code: null },
    }))).toBe("stop");
  });

  test("a long refusal envelope still hops: the intact bounded body is classified, not the display prefix", async () => {
    // Padding past the 500-char display limit must not turn a valid verdict into truncated,
    // unparseable JSON. consumeComboFailure classifies body.text separately and hands the
    // verdict to both decisions while classificationText stays the display prefix.
    const padding = "x".repeat(600);
    const longBody = JSON.stringify({
      id: `chatcmpl-${padding}`,
      error: { message: `Provider error 400: ${verdict}`, type: "upstream_error", code: null },
    });
    expect(longBody.length).toBeGreaterThan(500);
    const failure = await consumeComboFailure(new Response(longBody, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(failure.classificationText.length).toBeLessThanOrEqual(500);
    expect(failure.unofferedToolCallRefusal).toBe(true);
    expect(comboFailureDecision(400, failure.classificationText, {
      code: failure.upstreamCode,
      unofferedToolCallRefusal: failure.unofferedToolCallRefusal,
    })).toBe("hop");
    expect(comboFailureCooldownScope(400, failure.classificationText, {
      code: failure.upstreamCode,
      unofferedToolCallRefusal: failure.unofferedToolCallRefusal,
    })).toBe("none");
    // Without the intact-body verdict the truncated text fails closed, as before.
    expect(comboFailureDecision(400, failure.classificationText, {
      code: failure.upstreamCode,
    })).toBe("stop");
  });

  test("AI-SDK gateway carrier with object param hops", () => {
    const verdict = "The model returned an unexpected parser control marker; no output was published.";
    const body = JSON.stringify({
      error: {
        message: verdict,
        type: "AI_APICallError",
        param: {
          error: verdict, statusCode: 400, name: "AI_APICallError",
          message: verdict, isRetryable: false, type: "AI_APICallError",
        },
      },
      providerMetadata: { gateway: { routing: { originalModelId: "humansand/ampersand-v0.1" } } },
    });
    expect(comboFailureDecision(400, body)).toBe("hop");
    expect(comboFailureCooldownScope(400, body)).toBe("none");
    // A param object carrying a different claim stays terminal.
    const contradicted = JSON.stringify({
      error: {
        message: verdict, type: "AI_APICallError",
        param: { error: "different failure", statusCode: 400, type: "AI_APICallError" },
      },
    });
    expect(comboFailureDecision(400, contradicted)).toBe("stop");
    // A matching param.error cannot mask a contradicting param.message.
    const mixed = JSON.stringify({
      error: {
        message: verdict, type: "AI_APICallError",
        param: { error: verdict, message: "Invalid value for tools", statusCode: 400 },
      },
    });
    expect(comboFailureDecision(400, mixed)).toBe("stop");
    expect(comboFailureCooldownScope(400, mixed)).toBe("target");
  });
});
