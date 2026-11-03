import { describe, expect, test } from "bun:test";
import {
  classifyUpstreamCondition, isUpstreamCondition, UPSTREAM_CONDITIONS, upstreamConditionMessage,
} from "../../src/lib/upstream-condition";

// A provider key with no recognizable prefix, so pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";

describe("classifyUpstreamCondition", () => {
  test("structured tokens map to their condition", () => {
    expect(classifyUpstreamCondition({ status: 400, code: "context_length_exceeded" })).toBe("context_overflow");
    expect(classifyUpstreamCondition({ status: 403, code: "unsupported_country_region_territory" })).toBe("location_unsupported");
    expect(classifyUpstreamCondition({ status: 403, code: "organization_verification_required" })).toBe("account_verification_required");
    expect(classifyUpstreamCondition({ status: 429, code: "insufficient_quota" })).toBe("billing_exhausted");
    expect(classifyUpstreamCondition({ status: 404, code: "model_not_found" })).toBe("model_unavailable");
    expect(classifyUpstreamCondition({ status: 429, type: "rate_limit_error" })).toBe("rate_limited");
    expect(classifyUpstreamCondition({ status: 529, type: "overloaded_error" })).toBe("upstream_unavailable");
    expect(classifyUpstreamCondition({ status: 400, code: " Context_Length_Exceeded " })).toBe("context_overflow");
  });

  test("keyword evidence classifies 4xx failures", () => {
    expect(classifyUpstreamCondition({ status: 400, message: "prompt is too long: 210000 tokens > 200000 maximum" })).toBe("context_overflow");
    expect(classifyUpstreamCondition({ status: 400, message: "This model's maximum context length is 8192 tokens." })).toBe("context_overflow");
    expect(classifyUpstreamCondition({ status: 400, message: "User location is not supported for the API use." })).toBe("location_unsupported");
    expect(classifyUpstreamCondition({ status: 403, message: "Your organization must be verified to stream this model." })).toBe("account_verification_required");
    expect(classifyUpstreamCondition({ status: 400, message: "Your credit balance is too low" })).toBe("billing_exhausted");
    expect(classifyUpstreamCondition({ status: 400, message: "The model does not exist" })).toBe("model_unavailable");
  });

  test("context overflow from text needs the combo router's definite verdict", () => {
    // A validation error that quotes the caller's own value is not an overflow.
    const sdkValidation = "Error code: 400 - {'error': {'message': \"Invalid 'tools[0].function.name': 'prompt is too long'. Expected a string that matches the pattern.\", 'type': 'invalid_request_error', 'param': 'tools[0].function.name', 'code': 'invalid_value'}}";
    expect(classifyUpstreamCondition({ status: 400, message: sdkValidation })).toBe("request_rejected");
    expect(classifyUpstreamCondition({ status: 400, message: "Invalid tool name: prompt is too long" })).toBe("request_rejected");
    expect(classifyUpstreamCondition({ status: 400, message: "This prompt is too long for the model" })).toBe("request_rejected");
    // 401/403 bodies that quote context prose speak about the credential.
    expect(classifyUpstreamCondition({ status: 403, message: "maximum context length reached for this key" })).toBe("access_denied");
  });

  test("account usage-limit codes are billing exhaustion whatever the message says", () => {
    expect(classifyUpstreamCondition({ status: 400, code: "1308", message: "Bad request" })).toBe("billing_exhausted");
    expect(classifyUpstreamCondition({ status: 400, code: "usage_limit_exceeded", message: "Bad request" })).toBe("billing_exhausted");
    expect(classifyUpstreamCondition({ status: 429, type: "usage_limit_exceeded" })).toBe("billing_exhausted");
  });

  test("conflicting evidence follows the documented precedence", () => {
    // 401 is authoritative over billing or upgrade wording.
    expect(classifyUpstreamCondition({ status: 401, code: "insufficient_quota", message: "billing required" })).toBe("auth_failed");
    // A 429 naming a rate limit stays a rate limit even when it also mentions quota.
    expect(classifyUpstreamCondition({ status: 429, message: "Rate limit reached; quota exceeded for this minute" })).toBe("rate_limited");
    // Quota wording without rate wording on a 429 is exhaustion.
    expect(classifyUpstreamCondition({ status: 429, message: "You exceeded your current quota" })).toBe("billing_exhausted");
    // A 5xx stays a server failure whatever its text says.
    expect(classifyUpstreamCondition({ status: 500, message: "location is not supported" })).toBe("upstream_failed");
    expect(classifyUpstreamCondition({ status: 503, message: "insufficient quota" })).toBe("upstream_unavailable");
    // Structured tokens win over keywords.
    expect(classifyUpstreamCondition({ status: 400, code: "model_not_found", message: "prompt is too long" })).toBe("model_unavailable");
  });

  test("bare statuses fall back to a fixed condition", () => {
    expect(classifyUpstreamCondition({ status: 401 })).toBe("auth_failed");
    expect(classifyUpstreamCondition({ status: 402 })).toBe("billing_exhausted");
    expect(classifyUpstreamCondition({ status: 403 })).toBe("access_denied");
    expect(classifyUpstreamCondition({ status: 404 })).toBe("model_unavailable");
    expect(classifyUpstreamCondition({ status: 429 })).toBe("rate_limited");
    expect(classifyUpstreamCondition({ status: 529 })).toBe("upstream_unavailable");
    expect(classifyUpstreamCondition({ status: 503 })).toBe("upstream_unavailable");
    expect(classifyUpstreamCondition({ status: 502 })).toBe("upstream_failed");
    expect(classifyUpstreamCondition({ status: 422 })).toBe("request_rejected");
    expect(classifyUpstreamCondition({ status: 200 })).toBeUndefined();
    expect(classifyUpstreamCondition({ status: Number.NaN })).toBeUndefined();
  });

  test("oversized tokens are ignored rather than truncated into a match", () => {
    expect(classifyUpstreamCondition({ status: 400, code: "context_length_exceeded" + "x".repeat(200) })).toBe("request_rejected");
  });

  test("results and messages never carry input bytes", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const condition = classifyUpstreamCondition({ status, code: PROVIDER_KEY, type: PROVIDER_KEY, reason: PROVIDER_KEY,
        message: "invalid key " + PROVIDER_KEY });
      expect(isUpstreamCondition(condition)).toBe(true);
      expect(upstreamConditionMessage(condition!)).not.toContain(PROVIDER_KEY);
    }
  });

  test("messages are proxy constants and name only a well-formed configured provider id", () => {
    for (const condition of UPSTREAM_CONDITIONS) {
      expect(upstreamConditionMessage(condition)).toMatch(/^[A-Z][^\n]*\.$/);
      expect(upstreamConditionMessage(condition, "openai")).toEndWith("(provider: openai)");
      expect(upstreamConditionMessage(condition, "bad id\nwith text")).toBe(upstreamConditionMessage(condition));
    }
    expect(isUpstreamCondition("constructor")).toBe(false);
  });
});
