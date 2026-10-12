import { describe, expect, test } from "bun:test";
import { modelAdapterRecordConfigError } from "../../src/config/provider-validation";
import { isWirePinnedModel, pinnedWireAdapter } from "../../src/types";

const provider = {
  adapter: "openai-chat",
  authMode: "key",
  baseUrl: "https://api.commandcode.ai/provider/v1",
};

describe("Command Code Claude wire pin validation", () => {
  test("rejects a configured Chat adapter on pinned Claude ids", () => {
    for (const modelId of ["claude-opus-5-5", "Claude-Opus-5-5"]) {
      expect(isWirePinnedModel("commandcode", modelId, provider)).toBe(true);
      expect(pinnedWireAdapter("commandcode", modelId, provider)).toBe("anthropic");
      expect(modelAdapterRecordConfigError(
        { [modelId]: "openai-chat" }, "modelAdapters", "commandcode", provider,
      )).toContain("only speaks one wire");
    }
  });

  test("leaves MiMo and another provider's Claude ids configurable", () => {
    expect(modelAdapterRecordConfigError(
      { "xiaomi/mimo-v2.6-flash": "openai-chat" }, "modelAdapters", "commandcode", provider,
    )).toBeNull();
    for (const providerName of ["command-code", "openrouter"]) {
      expect(isWirePinnedModel(providerName, "claude-opus-5-5", provider)).toBe(false);
      expect(modelAdapterRecordConfigError(
        { "claude-opus-5-5": "openai-chat" }, "modelAdapters", providerName, provider,
      )).toBeNull();
    }
  });

  test("a custom provider reusing the commandcode name for another endpoint is not pinned", () => {
    const custom = { ...provider, baseUrl: "https://gateway.example.test/v1" };
    expect(isWirePinnedModel("commandcode", "claude-opus-5-5", custom)).toBe(false);
    expect(pinnedWireAdapter("commandcode", "claude-opus-5-5", custom)).toBeUndefined();
    expect(modelAdapterRecordConfigError(
      { "claude-opus-5-5": "openai-chat" }, "modelAdapters", "commandcode", custom,
    )).toBeNull();
    // A trailing slash or host case on the canonical endpoint is still the same destination.
    expect(isWirePinnedModel("commandcode", "claude-opus-5-5", { baseUrl: "https://API.commandcode.ai/provider/v1/" })).toBe(true);
    // Without a provider to check, only exact pins apply.
    expect(isWirePinnedModel("commandcode", "claude-opus-5-5")).toBe(false);
  });
});
