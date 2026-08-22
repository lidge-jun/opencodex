import { describe, expect, test } from "bun:test";
import { isModelTextOnly } from "../src/vision";
import type { OcxProviderConfig } from "../src/types";

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { name: "test", baseUrl: "https://example.com", ...overrides } as OcxProviderConfig;
}

describe("isModelTextOnly (#1024)", () => {
  test("returns true for models in noVisionModels", () => {
    expect(isModelTextOnly(provider({ noVisionModels: ["text-model"] }), "text-model")).toBe(true);
  });

  test("returns true for models with explicit text-only modelInputModalities", () => {
    expect(isModelTextOnly(provider({ modelInputModalities: { "custom-model": ["text"] } }), "custom-model")).toBe(true);
  });

  test("returns false for models with image in modelInputModalities", () => {
    expect(isModelTextOnly(provider({ modelInputModalities: { "vision-model": ["text", "image"] } }), "vision-model")).toBe(false);
  });

  test("returns false for unknown models (no evidence)", () => {
    expect(isModelTextOnly(provider(), "unknown-model")).toBe(false);
  });

  test("returns false for empty modelInputModalities array", () => {
    expect(isModelTextOnly(provider({ modelInputModalities: { "m": [] } }), "m")).toBe(false);
  });

  test("noVisionModels takes precedence even when modelInputModalities includes image", () => {
    expect(isModelTextOnly(provider({
      noVisionModels: ["conflict-model"],
      modelInputModalities: { "conflict-model": ["text", "image"] },
    }), "conflict-model")).toBe(true);
  });

  test("suffixed model IDs are resolved through family lookup", () => {
    expect(isModelTextOnly(provider({ modelInputModalities: { "base-model": ["text"] } }), "base-model:extended")).toBe(true);
  });
});
