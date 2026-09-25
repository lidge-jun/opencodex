import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboTargetCooldowns,
  comboFailureCooldownScope,
  comboFailureDecision,
  coolComboTarget,
  isComboTargetInCooldown,
  COMBO_REQUEST_RATE_COOLDOWN_MS,
} from "../../src/combos/failover";

/**
 * The ChatGPT Codex backend reports a depleted plan window as HTTP 502 `upstream_server_error`
 * carrying the prose `The usage limit has been reached`, never the documented 429. The
 * quota-cap predicate is gated on 429, so a dead account took the generic 60-second cooldown and
 * was re-offered every minute: 942 doomed sends in 72h of production ledger, each surfacing as
 * `adapter_eof`, plus 94 downstream `503 No available targets`. See #5860.
 *
 * The fix is duration only. Delete the exhaustion arm of `coolComboTarget`'s `cooldownMs` chain
 * and the ten-minute assertions below go back to 60 seconds.
 */
const combo = "codex-exhaustion-burn-test";
const target = { provider: "openai", model: "gpt-6-astra" };
const now = Date.UTC(2026, 8, 24, 12, 0, 0);
const EXHAUSTED = "The usage limit has been reached";

afterEach(() => clearComboTargetCooldowns(combo));

describe("a depleted Codex plan window", () => {
  test.each([
    ["502 prose", 502, "upstream_server_error", EXHAUSTED],
    ["429 structured code", 429, "usage_limit_exceeded", "quota"],
    ["structured usage_limit_reached", 502, "usage-limit-reached", "upstream error"],
    ["vendor 5-hour window", 429, "1308", "Usage limit reached for 5 hour"],
  ])("cools the target for ten minutes, not 60s (%s)", (_label, status, code, message) => {
    coolComboTarget(combo, target, { now, status, code, message });
    // The whole point: still cooling a minute later, when the 60s default would have expired.
    expect(isComboTargetInCooldown(combo, target, now + 60_000)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 10 * 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 10 * 60_000)).toBe(false);
  });

  test("hops without blacking out the whole provider", () => {
    // Scope and decision are untouched by this change: a Codex 502 still resolves `target` scope
    // and `hop` through the existing `status >= 500` path, which is why the status-blind prose
    // match is kept out of `isProviderScopedQuotaCap`.
    expect(comboFailureCooldownScope(502, EXHAUSTED, { code: "upstream_server_error" })).toBe("target");
    expect(comboFailureDecision(502, EXHAUSTED, { code: "upstream_server_error" })).toBe("hop");
  });

  test("an unrelated 502 keeps the 60-second default", () => {
    coolComboTarget(combo, target, { now, status: 502, code: "upstream_server_error", message: "bad gateway" });
    expect(isComboTargetInCooldown(combo, target, now + 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 60_000)).toBe(false);
  });

  test("a bare 1308 code with no prose still takes the exhaustion hold", () => {
    coolComboTarget(combo, target, { now, status: 429, code: "1308", message: "" });
    expect(isComboTargetInCooldown(combo, target, now + 10 * 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 10 * 60_000)).toBe(false);
  });

  test("a request-rate code carrying usage-limit prose takes the exhaustion hold, not 5 seconds", () => {
    // The two predicates overlap: `1302` is a request-rate code, but the prose says the window is
    // spent. `coolComboTarget` tests exhaustion first, so the longer hold wins -- this is the case
    // the combos guide calls out, and it would silently regress if the arms were ever reordered.
    coolComboTarget(combo, target, { now, status: 429, code: "1302", message: EXHAUSTED });
    expect(isComboTargetInCooldown(combo, target, now + COMBO_REQUEST_RATE_COOLDOWN_MS)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 10 * 60_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 10 * 60_000)).toBe(false);
  });

  test("an explicit server Retry-After still outranks the exhaustion default", () => {
    coolComboTarget(combo, target, { now, status: 502, code: "upstream_server_error", message: EXHAUSTED, retryAfter: "30" });
    expect(isComboTargetInCooldown(combo, target, now + 30_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 30_000)).toBe(false);
  });

  test("an operator's configured cooldownMs still outranks the exhaustion default", () => {
    coolComboTarget(combo, target, { now, status: 502, code: "upstream_server_error", message: EXHAUSTED, cooldownMs: 5_000 });
    expect(isComboTargetInCooldown(combo, target, now + 5_000 - 1)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 5_000)).toBe(false);
  });
});
