import { describe, expect, test } from "bun:test";
import { readRootTomlString } from "../src/codex/paths";

describe("auto_review_model config key (#1225)", () => {
  test("readRootTomlString resolves the root-level key next to approvals_reviewer", () => {
    const config = [
      'approvals_reviewer = "auto_review"',
      'auto_review_model = "opencode-go/deepseek-v4-flash"',
      "",
      "[profiles.test]",
      'model = "gpt-5.6-luna"',
    ].join("\n");
    expect(readRootTomlString(config, "auto_review_model")).toBe("opencode-go/deepseek-v4-flash");
    // Keys inside tables must not leak into root resolution.
    expect(readRootTomlString(config, "model")).toBeNull();
  });

  test("a config without the key resolves null (override stays untouched)", () => {
    expect(readRootTomlString('model = "gpt-5.6-luna"\n', "auto_review_model")).toBeNull();
  });
});
