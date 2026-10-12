import { describe, expect, test } from "bun:test";
import { ENCRYPTED_FUNCTION_OUTPUT_REJECTION, isRateLimitOrQuotaFailureMessage, upstreamErrorMessageFromPayload } from "../../src/lib/errors";
import { codexQuotaFailureMessage } from "../../src/server/responses/core-codex-account";
import { isEncryptedFunctionOutputRejection } from "../../src/server/responses/core-opaque-recovery";

describe("upstream diagnostic message fallback", () => {
  test.each([null, 123, false, {}, [], "", " \t\n"].map(message => [message]))("skips unusable message %j", message => {
    expect(upstreamErrorMessageFromPayload({ error: { message }, response: { error: { message: "provider detail" } } })).toBe("provider detail");
  });
  test("retains established precedence and original text", () => {
    expect(upstreamErrorMessageFromPayload({ error: { message: "  first  " }, last_error: { message: "second" }, response: { error: { message: "third" } } })).toBe("  first  ");
    expect(upstreamErrorMessageFromPayload({ error: { message: "" }, last_error: { message: "second" }, response: { error: { message: "third" } } })).toBe("second");
  });
  test("flat messages are admitted only for error events", () => {
    expect(upstreamErrorMessageFromPayload({ type: "error", error: { message: false }, message: "flat detail" })).toBe("flat detail");
    expect(upstreamErrorMessageFromPayload({ type: "response.completed", message: "ordinary output" })).toBeUndefined();
    expect(upstreamErrorMessageFromPayload({ response: { incomplete_details: { message: "incomplete detail" } } })).toBe("incomplete detail");
  });
  test.each([null, [], "message", 10, { error: { message: " " } }].map(payload => [payload]))("has no message for %j", payload => {
    expect(upstreamErrorMessageFromPayload(payload)).toBeUndefined();
  });
});

// Recovery consumers read the same helper, so a blank primary message must not hide the
// fallback that decides whether a resend or alternate account is warranted.
describe("recovery consumers see the fallback message", () => {
  const blankPrimary = (fallback: string) => JSON.stringify({ error: { message: "" }, response: { error: { message: fallback } } });

  test("encrypted function output rejection behind a blank primary message", () => {
    expect(isEncryptedFunctionOutputRejection(blankPrimary(ENCRYPTED_FUNCTION_OUTPUT_REJECTION))).toBe(true);
    expect(isEncryptedFunctionOutputRejection(blankPrimary("model overloaded"))).toBe(false);
  });

  test("quota failure behind a blank primary message", () => {
    const quota = codexQuotaFailureMessage(blankPrimary("You exceeded your current quota"));
    expect(quota).toBe("You exceeded your current quota");
    expect(isRateLimitOrQuotaFailureMessage(quota!)).toBe(true);
    const unrelated = codexQuotaFailureMessage(blankPrimary("invalid tool schema"));
    expect(unrelated).toBe("invalid tool schema");
    expect(isRateLimitOrQuotaFailureMessage(unrelated!)).toBe(false);
  });

  test("a nonblank primary message still wins over a conflicting fallback", () => {
    const body = JSON.stringify({ error: { message: "invalid tool schema" }, response: { error: { message: "You exceeded your current quota" } } });
    expect(codexQuotaFailureMessage(body)).toBe("invalid tool schema");
    expect(isEncryptedFunctionOutputRejection(JSON.stringify({ error: { message: "model overloaded" }, response: { error: { message: ENCRYPTED_FUNCTION_OUTPUT_REJECTION } } }))).toBe(false);
  });
});
