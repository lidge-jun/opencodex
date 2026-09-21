import { describe, expect, test } from "bun:test";
import { liveVoiceConfigError, liveVoiceConfigValueError } from "../../src/config/live-voice";
import type { OcxProviderConfig } from "../../src/types";

const PROVIDERS = {
  "my-voice": {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    liveUrl: "wss://voice.example.test/live",
  },
  "my-other": {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    liveUrl: "wss://other.example.test/live",
    liveHeaders: { authorization: "${TOKEN}" },
  },
} satisfies Record<string, OcxProviderConfig>;

describe("live voice boundary validation", () => {
  test("accepts the reserved target and a custom provider with an endpoint", () => {
    expect(liveVoiceConfigValueError(undefined, PROVIDERS)).toBeNull();
    expect(liveVoiceConfigValueError(null, PROVIDERS)).toBeNull();
    expect(liveVoiceConfigValueError({}, PROVIDERS)).toBeNull();
    expect(liveVoiceConfigValueError({ provider: "openai" }, PROVIDERS)).toBeNull();
    expect(liveVoiceConfigValueError({ provider: "my-voice" }, PROVIDERS)).toBeNull();
    expect(liveVoiceConfigValueError({
      provider: "my-voice",
      byModel: { "zai/glm-5.3-flash": "my-other", "gpt-6-astra": "openai" },
    }, PROVIDERS)).toBeNull();
  });

  test("rejects non-object roots and unknown keys", () => {
    expect(liveVoiceConfigValueError("custom", PROVIDERS)).toContain("must be an object");
    expect(liveVoiceConfigValueError(["custom"], PROVIDERS)).toContain("must be an object");
    expect(liveVoiceConfigValueError({ default: "openai" }, PROVIDERS)).toContain("unknown key");
    expect(liveVoiceConfigValueError({ providers: {} }, PROVIDERS)).toContain("unknown key");
  });

  test("rejects non-string and unknown targets", () => {
    expect(liveVoiceConfigValueError({ provider: 7 }, PROVIDERS)).toContain("liveVoice.provider: must be a string");
    expect(liveVoiceConfigValueError({ provider: "ghost" }, PROVIDERS)).toContain("is not configured");
    expect(liveVoiceConfigValueError({ byModel: { m: 7 } }, PROVIDERS)).toContain("liveVoice.byModel.m: must be a string");
    expect(liveVoiceConfigValueError({ byModel: { m: "ghost" } }, PROVIDERS)).toContain("is not configured");
  });

  test("rejects a registry-managed provider id even when configured", () => {
    const providers = { anthropic: { ...PROVIDERS["my-voice"] } };
    expect(liveVoiceConfigValueError({ provider: "anthropic" }, providers)).toContain("must name a custom provider");
    expect(liveVoiceConfigValueError({ byModel: { m: "anthropic" } }, providers)).toContain("must name a custom provider");
    // "openai" stays reserved even when a configured provider shares the name.
    expect(liveVoiceConfigValueError({ provider: "openai" }, { openai: { ...PROVIDERS["my-voice"] } })).toBeNull();
  });

  test("rejects a custom target without a usable endpoint", () => {
    const bare = { bare: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } };
    expect(liveVoiceConfigValueError({ provider: "bare" }, bare)).toContain("has no live voice endpoint");
    const badHeaders = {
      "my-other": { ...PROVIDERS["my-other"], liveHeaders: { a: 1 } },
    } as unknown as Record<string, OcxProviderConfig>;
    expect(liveVoiceConfigValueError({ provider: "my-other" }, badHeaders)).toContain("liveHeaders must be an object of strings");
  });

  test("whole-config wrapper validates against the config providers", () => {
    expect(liveVoiceConfigError({ providers: PROVIDERS })).toBeNull();
    expect(liveVoiceConfigError({ liveVoice: { provider: "ghost" }, providers: PROVIDERS })).toContain("schema_invalid: liveVoice.provider");
    expect(liveVoiceConfigError({ liveVoice: { provider: "my-voice" }, providers: PROVIDERS })).toBeNull();
    expect(liveVoiceConfigError(null)).toBeNull();
  });
});
