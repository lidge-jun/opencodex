import { describe, expect, test } from "bun:test";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";

/**
 * A Claude subscription that has spent its included usage AND its extra-usage balance answers with
 * a plain HTTP 400 `invalid_request_error`. Read as a bad request it ended the combo chain, so the
 * `anthropic-apikey` / `zayu-claude` lanes behind it were never tried and the client saw the raw
 * upstream error. It is account state, not request shape: hop, and cool the whole provider.
 */
const EXTRA_USAGE = "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
const envelope = (text: string) => JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: text },
  request_id: "req_test",
});

describe("Anthropic 'out of extra usage' 400", () => {
  for (const code of [undefined, null, "invalid_request_error"] as const) {
    test(`hops to the next target and cools the provider (code ${String(code)})`, () => {
      const message = `Provider error 400: ${envelope(EXTRA_USAGE)}`;
      expect(comboFailureDecision(400, message, { code })).toBe("hop");
      expect(comboFailureCooldownScope(400, message, { code })).toBe("provider");
    });
  }

  test("a validation 400 that merely quotes the sentence still stops the chain", () => {
    const message = `Provider error 400: ${envelope(`messages.0: ${EXTRA_USAGE}`)}`;
    expect(comboFailureDecision(400, message, { code: "invalid_request_error" })).toBe("stop");
    expect(comboFailureCooldownScope(400, message, { code: "invalid_request_error" })).toBe("target");
  });
});
