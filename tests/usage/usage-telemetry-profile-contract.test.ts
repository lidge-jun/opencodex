import { describe, expect, test } from "bun:test";
import {
  PROFILE_MAX_DAY_TOKENS,
  validateProfileCreateV1,
  validateProfileDayV1,
  validateProfileDisplayName,
  validateProfileHandle,
} from "../../src/telemetry/profile/contract";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

function day(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    day: "2026-11-08",
    requests: 3,
    tokens: { input: 100, cacheRead: 50, cacheWrite: 0, output: 30, reasoning: 20 },
    families: [
      { family: "claude-opus", requests: 2, tokens: 150 },
      { family: "gpt-6", requests: 1, tokens: 50 },
    ],
    ...overrides,
  };
}

describe("public profile contract", () => {
  test("handles are lowercase, 3-24 chars, hyphen-inner, not reserved and not numeric-only", () => {
    expect(validateProfileHandle("  Jun-Dev ")).toEqual({ ok: true, value: "jun-dev" });
    for (const bad of ["ab", "-abc", "abc-", "a--b", "1234", "a".repeat(25), "opencodex", "admin", "jun_dev", "jün", 42]) {
      expect(validateProfileHandle(bad).ok).toBe(false);
    }
  });

  test("display names allow letters in any script but no markup, links or control characters", () => {
    expect(validateProfileDisplayName(" 김준 Lee ")).toEqual({ ok: true, value: "김준 Lee" });
    expect(validateProfileDisplayName("J. R. O'Neil-Smith").ok).toBe(true);
    for (const bad of ["", " ", "a".repeat(33), "<b>x</b>", "visit example.com", "x\u0000y", "two  spaces", "https://x", "a@b"]) {
      expect(validateProfileDisplayName(bad).ok).toBe(false);
    }
  });

  test("create bodies have exactly the four keys and a palette avatar", () => {
    expect(validateProfileCreateV1({ schemaVersion: 1, handle: "jun", displayName: "Jun", avatar: "blue" }).ok).toBe(true);
    expect(validateProfileCreateV1({ schemaVersion: 1, handle: "jun", displayName: "Jun", avatar: "https://x/a.png" }).ok).toBe(false);
    expect(validateProfileCreateV1({ schemaVersion: 1, handle: "jun", displayName: "Jun", avatar: "blue", email: "a@b.c" }).ok).toBe(false);
  });

  test("a day is accepted only with consistent totals, closed families and exact keys", () => {
    expect(validateProfileDayV1(day(), NOW).ok).toBe(true);
    expect(validateProfileDayV1(day({ installDayHash: "0".repeat(64) }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ requests: 4 }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ families: [{ family: "claude-opus", requests: 3, tokens: 199 }] }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ families: [{ family: "my-private-model", requests: 3, tokens: 200 }] }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({
      families: [{ family: "gpt-6", requests: 2, tokens: 150 }, { family: "gpt-6", requests: 1, tokens: 50 }],
    }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ requests: 0, families: [] }), NOW).ok).toBe(false);
  });

  test("only completed UTC days from the last seven are submittable", () => {
    expect(validateProfileDayV1(day({ day: "2026-11-09" }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ day: "2026-11-10" }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ day: "2026-11-02" }), NOW).ok).toBe(true);
    expect(validateProfileDayV1(day({ day: "2026-11-01" }), NOW).ok).toBe(false);
    expect(validateProfileDayV1(day({ day: "2026-02-30" }), NOW).ok).toBe(false);
  });

  test("a day over the plausibility cap is rejected", () => {
    const huge = PROFILE_MAX_DAY_TOKENS;
    expect(validateProfileDayV1(day({
      requests: 1,
      tokens: { input: huge, cacheRead: 1, cacheWrite: 0, output: 0, reasoning: 0 },
      families: [{ family: "gpt-6", requests: 1, tokens: huge + 1 }],
    }), NOW).ok).toBe(false);
  });
});

