import { describe, expect, test } from "bun:test";
import { dictationConfigError, dictationConfigValueError } from "../../src/config/dictation";
import type { OcxProviderConfig } from "../../src/types";

const PROVIDERS = {
  "my-dictation": {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    dictationUrl: "wss://dictation.example.test/stream",
  },
  "my-other": {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    dictationUrl: "wss://other.example.test/stream",
    dictationHeaders: { authorization: "${TOKEN}" },
    dictationProtocols: ["dictation-v1"],
  },
} satisfies Record<string, OcxProviderConfig>;

describe("dictation boundary validation", () => {
  test("accepts the reserved target and a custom provider with an endpoint", () => {
    expect(dictationConfigValueError(undefined, PROVIDERS)).toBeNull();
    expect(dictationConfigValueError(null, PROVIDERS)).toBeNull();
    expect(dictationConfigValueError({}, PROVIDERS)).toBeNull();
    expect(dictationConfigValueError({ provider: "openai" }, PROVIDERS)).toBeNull();
    expect(dictationConfigValueError({ provider: "my-dictation" }, PROVIDERS)).toBeNull();
    expect(dictationConfigValueError({
      provider: "my-dictation",
      byModel: { "zai/glm-5.3-flash": "my-other", "gpt-6-astra": "openai" },
    }, PROVIDERS)).toBeNull();
  });

  test("rejects non-object roots and unknown keys", () => {
    expect(dictationConfigValueError("custom", PROVIDERS)).toContain("must be an object");
    expect(dictationConfigValueError(["custom"], PROVIDERS)).toContain("must be an object");
    expect(dictationConfigValueError({ default: "openai" }, PROVIDERS)).toContain("unknown key");
    expect(dictationConfigValueError({ providers: {} }, PROVIDERS)).toContain("unknown key");
  });

  test("rejects non-string and unknown targets", () => {
    expect(dictationConfigValueError({ provider: 7 }, PROVIDERS)).toContain("dictation.provider: must be a string");
    expect(dictationConfigValueError({ provider: "ghost" }, PROVIDERS)).toContain("is not configured");
    expect(dictationConfigValueError({ byModel: { m: 7 } }, PROVIDERS)).toContain("dictation.byModel.m: must be a string");
    expect(dictationConfigValueError({ byModel: { m: "ghost" } }, PROVIDERS)).toContain("is not configured");
  });

  test("rejects a registry-managed provider id even when configured", () => {
    const providers = { anthropic: { ...PROVIDERS["my-dictation"] } };
    expect(dictationConfigValueError({ provider: "anthropic" }, providers)).toContain("must name a custom provider");
    expect(dictationConfigValueError({ byModel: { m: "anthropic" } }, providers)).toContain("must name a custom provider");
    // "openai" stays reserved even when a configured provider shares the name.
    expect(dictationConfigValueError({ provider: "openai" }, { openai: { ...PROVIDERS["my-dictation"] } })).toBeNull();
  });

  test("rejects a custom target without a usable endpoint", () => {
    const bare = { bare: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } };
    expect(dictationConfigValueError({ provider: "bare" }, bare)).toContain("has no dictation endpoint");
    const badHeaders = {
      "my-other": { ...PROVIDERS["my-other"], dictationHeaders: { a: 1 } },
    } as unknown as Record<string, OcxProviderConfig>;
    expect(dictationConfigValueError({ provider: "my-other" }, badHeaders)).toContain("dictationHeaders must be an object of strings");
    const badProtocols = {
      "my-other": { ...PROVIDERS["my-other"], dictationProtocols: "x" },
    } as unknown as Record<string, OcxProviderConfig>;
    expect(dictationConfigValueError({ provider: "my-other" }, badProtocols)).toContain("dictationProtocols must be an array of strings");
  });

  test("whole-config wrapper validates against the config providers", () => {
    expect(dictationConfigError({ providers: PROVIDERS })).toBeNull();
    expect(dictationConfigError({ dictation: { provider: "ghost" }, providers: PROVIDERS })).toContain("schema_invalid: dictation.provider");
    expect(dictationConfigError({ dictation: { provider: "my-dictation" }, providers: PROVIDERS })).toBeNull();
    expect(dictationConfigError(null)).toBeNull();
  });
});
