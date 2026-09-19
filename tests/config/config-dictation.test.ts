import { describe, expect, test } from "bun:test";
import { dictationConfigError, dictationConfigValueError } from "../../src/config/dictation";

const CUSTOM = { url: "wss://dictation.example.test/stream" };

describe("dictation boundary validation", () => {
  test("accepts the reserved target and a well-formed custom provider", () => {
    expect(dictationConfigValueError(undefined)).toBeNull();
    expect(dictationConfigValueError(null)).toBeNull();
    expect(dictationConfigValueError({})).toBeNull();
    expect(dictationConfigValueError({ default: "openai" })).toBeNull();
    expect(dictationConfigValueError({ default: "custom", providers: { custom: CUSTOM } })).toBeNull();
    expect(dictationConfigValueError({
      default: "custom",
      byModel: { "zai/glm-5.3-flash": "custom", "openai/gpt-5.6-luna": "openai" },
      providers: { custom: { ...CUSTOM, headers: { authorization: "Bearer ${TOKEN}" }, protocols: ["dictation-v1"] } },
    })).toBeNull();
  });

  test("rejects non-object roots and unknown keys", () => {
    expect(dictationConfigValueError("custom")).toContain("must be an object");
    expect(dictationConfigValueError(["custom"])).toContain("must be an object");
    expect(dictationConfigValueError({ dictation: {} })).toContain("unknown key");
    expect(dictationConfigValueError({ byModel: {} })).toBeNull();
  });

  test("rejects non-string targets and targets naming an absent provider", () => {
    expect(dictationConfigValueError({ default: 7 })).toContain("dictation.default: must be a string");
    expect(dictationConfigValueError({ default: "ghost", providers: {} })).toContain("not a configured provider");
    expect(dictationConfigValueError({ byModel: { m: 7 } })).toContain("dictation.byModel.m: must be a string");
    expect(dictationConfigValueError({ byModel: { m: "ghost" } })).toContain("not a configured provider");
    // "openai" stays the reserved target even when a configured provider shares the name.
    expect(dictationConfigValueError({ default: "openai", providers: { openai: CUSTOM } })).toBeNull();
  });

  test("rejects malformed provider entries", () => {
    expect(dictationConfigValueError({ providers: { custom: "wss://x" } })).toContain("must be an object");
    expect(dictationConfigValueError({ providers: { custom: { ...CUSTOM, extra: 1 } } })).toContain("unknown key");
    expect(dictationConfigValueError({ providers: { custom: {} } })).toContain("url: must be a non-empty string");
    expect(dictationConfigValueError({ providers: { custom: { url: 5 } } })).toContain("url: must be a non-empty string");
    expect(dictationConfigValueError({ providers: { custom: { ...CUSTOM, headers: [] } } })).toContain("headers: must be an object");
    expect(dictationConfigValueError({ providers: { custom: { ...CUSTOM, headers: { a: 1 } } } })).toContain("must be a string");
    expect(dictationConfigValueError({ providers: { custom: { ...CUSTOM, protocols: "x" } } })).toContain("array of strings");
    expect(dictationConfigValueError({ providers: { custom: { ...CUSTOM, protocols: [1] } } })).toContain("array of strings");
  });

  test("whole-config wrapper only inspects the dictation key", () => {
    expect(dictationConfigError({ providers: {} })).toBeNull();
    expect(dictationConfigError({ dictation: { default: "ghost" } })).toContain("schema_invalid: dictation.default");
    expect(dictationConfigError(null)).toBeNull();
  });
});
