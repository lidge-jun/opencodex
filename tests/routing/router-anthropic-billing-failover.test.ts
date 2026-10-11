import { expect, test } from "bun:test";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";

const message = "Your credit balance is too low to access the Anthropic API.";
const envelope = (type = "invalid_request_error", text = message, code?: string) => JSON.stringify({
  type: "error", error: { type, message: text, ...(code !== undefined ? { code } : {}) },
});

test("exact Anthropic billing evidence precedes the invalid_request_error stop and cools the provider", () => {
  for (const status of [400, 402]) for (const type of ["invalid_request_error", "billing_error", "permission_error"]) {
    for (const carrier of [envelope(type), `Provider error ${status}: ${envelope(type)}`, message]) {
      expect(comboFailureDecision(status, carrier, { code: type })).toBe("hop");
      expect(comboFailureCooldownScope(status, carrier, { code: type })).toBe("provider");
    }
  }
});

test("billing prose without an accepted code, malformed JSON and unrelated refusals stay terminal", () => {
  for (const carrier of [message, envelope().slice(0, -1), envelope("invalid_request_error", `Diagnostic: ${message}`),
    envelope("invalid_request_error", `${message} Model denied.`), envelope("api_error"),
    envelope("invalid_request_error", message, "context_length_exceeded"),
    JSON.stringify({ response: JSON.parse(envelope()) })]) {
    expect(comboFailureDecision(400, carrier)).toBe("stop");
  }
  for (const code of ["context_length_exceeded", "invalid_api_key", "unsupported_parameter"]) {
    expect(comboFailureDecision(400, message, { code })).toBe("stop");
  }
  expect(comboFailureDecision(499, envelope(), { code: "invalid_request_error" })).toBe("stop");
  expect(comboFailureDecision(400, envelope(), { code: "origin_rejected" })).toBe("stop");
});
