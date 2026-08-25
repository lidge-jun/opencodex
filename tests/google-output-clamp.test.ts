import { describe, expect, test } from "bun:test";
import { clampGoogleMaxOutputTokens, maxOutputTokensForGoogleModel } from "../src/adapters/google";

describe("google maxOutputTokens clamp", () => {
  test("returns model-specific max output tokens limit", () => {
    expect(maxOutputTokensForGoogleModel("gemini-3.7-flash")).toBe(65536);
    expect(maxOutputTokensForGoogleModel("gemini-3.7-flash-tiered")).toBe(65536);
    expect(maxOutputTokensForGoogleModel("gemini-3-pro")).toBe(65535);
    expect(maxOutputTokensForGoogleModel("claude-3-7-sonnet")).toBe(64000);
    expect(maxOutputTokensForGoogleModel("claude-3-5-sonnet@20241022")).toBe(64000);
    expect(maxOutputTokensForGoogleModel("gpt-oss-120b")).toBe(32768);
  });

  test("an unrecognized model has no invented ceiling", () => {
    // A cap we cannot justify silently truncates the operator's explicit request. Aliases,
    // gateway ids, and models newer than this table must pass through untouched.
    expect(maxOutputTokensForGoogleModel("custom-unknown-model")).toBeUndefined();
    expect(clampGoogleMaxOutputTokens("custom-unknown-model", 128000)).toBe(128000);
    expect(maxOutputTokensForGoogleModel("some-gateway/gemini-3-pro")).toBeUndefined();
  });

  test("family matching does not fire on incidental substrings", () => {
    // "includes(pro)" matched my-prototype-model; "includes(oss)" matched crossover-v2.
    expect(maxOutputTokensForGoogleModel("my-prototype-model")).toBeUndefined();
    expect(maxOutputTokensForGoogleModel("crossover-v2")).toBeUndefined();
    expect(maxOutputTokensForGoogleModel("gemini-3-pro-preview")).toBe(65535);
    expect(maxOutputTokensForGoogleModel("gemini-3.5-flash")).toBe(65536);
  });

  test("downward clamps excessive requested tokens to model max", () => {
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", 128000)).toBe(65536);
    expect(clampGoogleMaxOutputTokens("gemini-3-pro", 100000)).toBe(65535);
    expect(clampGoogleMaxOutputTokens("claude-3-7-sonnet", 100000)).toBe(64000);
    expect(clampGoogleMaxOutputTokens("gpt-oss-120b", 64000)).toBe(32768);
  });

  test("preserves requested tokens when within model max", () => {
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", 4096)).toBe(4096);
    expect(clampGoogleMaxOutputTokens("gemini-3-pro", 8192)).toBe(8192);
    expect(clampGoogleMaxOutputTokens("claude-3-7-sonnet", 32000)).toBe(32000);
  });

  test("returns undefined when requested tokens is undefined or non-positive", () => {
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", undefined)).toBeUndefined();
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", 0)).toBeUndefined();
    expect(clampGoogleMaxOutputTokens("gemini-3.7-flash", -10)).toBeUndefined();
  });
});
