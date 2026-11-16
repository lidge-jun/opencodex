import { describe, expect, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import type { OcxConfig } from "../../src/types";

function withProvider(provider: Record<string, unknown>): OcxConfig {
  return {
    ...getDefaultConfig(),
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "synthetic",
        ...provider,
      },
    },
  } as OcxConfig;
}

describe("anthropic thinking display policy config", () => {
  test("accepts a model-keyed summarized entry, mirroring other model maps", () => {
    const result = validateConfigCandidate(withProvider({
      modelThinkingDisplay: { "claude-opus-5-5": "summarized" },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.providers.anthropic!.modelThinkingDisplay).toEqual({ "claude-opus-5-5": "summarized" });
  });

  test("accepts every documented value at provider and model level", () => {
    for (const value of ["auto", "summarized", "updates", "omitted"] as const) {
      expect(validateConfigCandidate(withProvider({ thinkingDisplay: value })).ok).toBe(true);
      expect(validateConfigCandidate(withProvider({ modelThinkingDisplay: { "claude-opus-5-5": value } })).ok).toBe(true);
    }
  });

  test("rejects an unknown provider-level value with a clear message", () => {
    const result = validateConfigCandidate(withProvider({ thinkingDisplay: "always" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("thinkingDisplay");
  });

  test("rejects an unknown model-level value with a clear message", () => {
    const result = validateConfigCandidate(withProvider({
      modelThinkingDisplay: { "claude-opus-5-5": "verbose" },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("modelThinkingDisplay");
  });

  test("rejects a non-object model map and non-string values", () => {
    for (const value of [[], "summarized", { "claude-opus-5-5": true }]) {
      const result = validateConfigCandidate(withProvider({ modelThinkingDisplay: value }));
      expect(result.ok).toBe(false);
    }
  });
});
