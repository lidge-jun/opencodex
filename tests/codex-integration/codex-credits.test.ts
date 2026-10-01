import { beforeEach, describe, expect, test } from "bun:test";
import { codexCreditsDtoField, codexCreditsFor, hasCodexCreditsObservation, parseCodexCredits, pruneCodexCredits, rememberCodexCredits, resetCodexCreditsForTests } from "../../src/codex/credits";

beforeEach(resetCodexCreditsForTests);

describe("Codex credits boundary parser", () => {
  test.each(["62500", "62498.725", "0", "000.050", 125.5, 0])("preserves decimal balance %s", balance => {
    expect(parseCodexCredits({ balance })).toEqual({ balance: String(balance) });
  });
  test.each([[1e-7, "0.0000001"], [1e21, "1000000000000000000000"], [62498.725, "62498.725"]] as const)(
    "normalizes numeric balance %p to a plain decimal string", (balance, expected) => {
      const parsed = parseCodexCredits({ balance });
      expect(parsed).toEqual({ balance: expected });
      expect(parsed?.balance).toMatch(/^\d+(\.\d+)?$/);
    });
  test.each([-1, Infinity, NaN, "-1", "1e3", " 25", "25 ", "", "garbage", true, null])("drops invalid balance %s", balance => {
    expect(parseCodexCredits({ balance })).toBeNull();
  });
  test("absent, null, malformed and empty observations remain distinct", () => {
    expect(parseCodexCredits(undefined)).toBeUndefined();
    for (const value of [null, {}, [], "invalid", 0]) expect(parseCodexCredits(value)).toBeNull();
  });
  test("projects only typed display fields and copies ranges", () => {
    expect(parseCodexCredits({ has_credits: false, unlimited: true, overage_limit_reached: false,
      approx_local_messages: [0, 12.5], approx_cloud_messages: [10, 20], private: "ignored" })).toEqual({
      hasCredits: false, unlimited: true, overageLimitReached: false,
      approxLocalMessages: [0, 12.5], approxCloudMessages: [10, 20],
    });
  });
  test.each([[1], [1, 2, 3], [-1, 2], [1, Infinity], ["1", 2], [NaN, 2]].map(range => [range]))("drops malformed range %j", range => {
    expect(parseCodexCredits({ balance: "3", approx_local_messages: range, approx_cloud_messages: range,
      has_credits: "true", unlimited: 1, overage_limit_reached: null })).toEqual({ balance: "3" });
  });
});

describe("identity-bound process-local credits", () => {
  test("an answer without credits is an observation, distinct from never observed", () => {
    expect(hasCodexCreditsObservation("pool", "identity-a")).toBe(false);
    rememberCodexCredits("pool", "identity-a", undefined);
    expect(hasCodexCreditsObservation("pool", "identity-a")).toBe(true);
    expect(codexCreditsFor("pool", "identity-a")).toBeUndefined();
    expect(hasCodexCreditsObservation("pool", "identity-b")).toBe(false);
    expect(hasCodexCreditsObservation("pool", null)).toBe(false);
    rememberCodexCredits("pool", "identity-a", { balance: "2" });
    rememberCodexCredits("pool", "identity-b", undefined);
    expect(codexCreditsFor("pool", "identity-b")).toBeUndefined();
    expect(hasCodexCreditsObservation("pool", "identity-b")).toBe(true);
  });
  test("omission keeps, null clears, and replacement overwrites the observation", () => {
    rememberCodexCredits("pool", "identity-a", { balance: "4" });
    rememberCodexCredits("pool", "identity-a", undefined);
    expect(codexCreditsFor("pool", "identity-a")).toEqual({ balance: "4" });
    rememberCodexCredits("pool", "identity-a", { balance: "0" });
    expect(codexCreditsFor("pool", "identity-a")).toEqual({ balance: "0" });
    rememberCodexCredits("pool", "identity-a", null);
    expect(codexCreditsFor("pool", "identity-a")).toBeUndefined();
  });
  test.each(["identity-b", null])("identity mismatch %s retires the entry permanently", identity => {
    rememberCodexCredits("__main__", "identity-a", { balance: "7" });
    expect(codexCreditsFor("__main__", identity)).toBeUndefined();
    expect(codexCreditsFor("__main__", "identity-a")).toBeUndefined();
  });
  test("pruning retains only live account ids", () => {
    rememberCodexCredits("live", "identity", { unlimited: true });
    rememberCodexCredits("removed", "identity", { balance: "2" });
    pruneCodexCredits(["live"]);
    expect(codexCreditsFor("live", "identity")).toEqual({ unlimited: true });
    expect(codexCreditsFor("removed", "identity")).toBeUndefined();
  });
  test("DTO exposure requires an explicit opt-in and a current observation", () => {
    rememberCodexCredits("pool", "identity", { balance: "12.5" });
    expect(codexCreditsDtoField({}, "pool", "identity")).toEqual({});
    expect(codexCreditsDtoField({ showCodexCredits: false }, "pool", "identity")).toEqual({});
    expect(codexCreditsDtoField({ showCodexCredits: true }, "pool", "identity")).toEqual({ credits: { balance: "12.5" } });
    expect(codexCreditsDtoField({ showCodexCredits: true }, "pool", "other")).toEqual({});
  });
  test("readers and callers cannot mutate retained observations", () => {
    const credits = { balance: "1" };
    rememberCodexCredits("pool", "identity", credits);
    credits.balance = "2";
    const read = codexCreditsFor("pool", "identity")!;
    read.balance = "3";
    expect(codexCreditsFor("pool", "identity")).toEqual({ balance: "1" });
  });
});
