import { describe, expect, test } from "bun:test";
import { CliUsageError, takeIntegerOption } from "../../src/cli/runtime-api";

describe("CLI integer options", () => {
  test.each(["", " ", ",", "_", "0x10", "1e3", "1.0", "1.5", "1__2", "1,,2", "_12", "12_", "9007199254740993", "-9007199254740993"])("rejects %j", raw => {
    expect(() => takeIntegerOption(["--limit", raw], "--limit")).toThrow(CliUsageError);
  });
  test.each([["0", 0], ["-12", -12], ["+12", 12], [" 42 ", 42], ["1_000", 1000], ["1,000", 1000], ["9007199254740991", Number.MAX_SAFE_INTEGER]] as const)("accepts %s", (raw, expected) => {
    expect(takeIntegerOption(["--limit", raw], "--limit")).toBe(expected);
  });
  test("keeps per-command minimum and missing-option semantics", () => {
    expect(() => takeIntegerOption(["--limit", "0"], "--limit", { min: 1 })).toThrow(CliUsageError);
    expect(takeIntegerOption([], "--limit")).toBeUndefined();
    const args = ["--limit", "20", "--json"];
    expect(takeIntegerOption(args, "--limit", { min: 1 })).toBe(20);
    expect(args).toEqual(["--json"]);
  });
});
