import { describe, expect, test } from "bun:test";
import { shouldExposeRoutedModel } from "../../src/codex/catalog";

describe("routed catalog compatibility exclusions", () => {
  test("filters incompatible slugs while keeping live control models", () => {
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "hy3-preview" })).toBe(false);
    // Issue #2330: uncallable or stale OpenCode Go models
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "mimo-v2-omni" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "mimo-v2-pro" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "deepseek", id: "deepseek-v4-pro" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "deepseek-v4-pro" })).toBe(false);
    expect(shouldExposeRoutedModel({ provider: "opencode-free", id: "deepseek-v4-flash-free" })).toBe(true);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "grok-4.6" })).toBe(true);
    expect(shouldExposeRoutedModel({ provider: "opencode-go", id: "glm-5.2" })).toBe(true);
  });
});
