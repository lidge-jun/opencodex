import { describe, expect, test } from "bun:test";
import { isModelAllowed, parseModelAllowlist } from "../src/models";

describe("model allowlists", () => {
  test("parses comma-separated exact model ids", () => {
    expect(parseModelAllowlist("gpt-4o, gpt-4o-mini")).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  test("matches model ids exactly", () => {
    const allowlist = new Set(["gpt-4o", "gpt-4o-mini"]);
    expect(isModelAllowed(allowlist, "gpt-4o")).toBe(true);
    expect(isModelAllowed(allowlist, "gpt-4o-mini")).toBe(true);
    expect(isModelAllowed(allowlist, "GPT-4o-mini")).toBe(false);
    expect(isModelAllowed(allowlist, "gpt-4.1")).toBe(false);
  });
});
