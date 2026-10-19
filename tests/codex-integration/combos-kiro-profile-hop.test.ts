import { describe, expect, test } from "bun:test";
import { comboFailureDecision } from "../../src/combos/failover";

// Moved byte for byte out of combos.test.ts ("combo failure policy and advancement"), which sits at
// the 2000-line ratchet threshold.
describe("combo failure policy: Kiro account-profile refusal", () => {
  test("only a Kiro target hops on its improperly-formed validator 400", () => {
    // A Kiro 400 that names its own validator rejection is account-scoped: after the account layer
    // has no login left to rotate to, the next combo target is the only chance to serve the turn.
    const improper = JSON.stringify({ message: "ValidationException: Improperly formed request" });
    const kiro = { failedAdapter: "kiro" };
    expect(comboFailureDecision(400, improper, kiro)).toBe("hop");
    expect(comboFailureDecision(400, `Provider error 400: ${improper}`, kiro)).toBe("hop");
    expect(comboFailureDecision(400, JSON.stringify({ message: "Improperly formed request" }), kiro)).toBe("stop");
    expect(comboFailureDecision(400, "ValidationException: model not found", kiro)).toBe("stop");
    // Tokens in unrelated fields, or a failed target that is not Kiro (or unknown), never hop.
    expect(comboFailureDecision(400, JSON.stringify({ metadata: "ValidationException", message: "Improperly formed request" }), kiro)).toBe("stop");
    expect(comboFailureDecision(400, JSON.stringify({ error: { message: "Kiro invalid request: ValidationException: Improperly formed request" } }), kiro)).toBe("hop");
    expect(comboFailureDecision(400, "Kiro invalid request: ValidationException: Improperly formed request", kiro)).toBe("hop");
    expect(comboFailureDecision(400, "Kiro invalid request: ValidationException: Improperly formed request", { failedAdapter: "openai-chat" })).toBe("stop");
    expect(comboFailureDecision(400, improper)).toBe("stop");
    expect(comboFailureDecision(400, improper, { failedAdapter: "openai-chat" })).toBe("stop");
    expect(comboFailureDecision(400, improper, { failedAdapter: "anthropic" })).toBe("stop");
  });
});
