import { describe, expect, test } from "bun:test";
import { upstreamErrorMessageFromPayload } from "../../src/lib/errors";

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
