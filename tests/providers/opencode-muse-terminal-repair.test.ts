import { describe, expect, test } from "bun:test";
import {
  getProviderRegistryEntry,
  providerModelResponsesTerminalRepair,
} from "../../src/providers/registry";

describe("OpenCode muse-spark terminal repair registry policy", () => {
  test("opencode-go exposes 5s grace repair for muse-spark models", () => {
    const entry = getProviderRegistryEntry("opencode-go");
    expect(entry).toBeDefined();

    for (const modelId of ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor"]) {
      const policy = providerModelResponsesTerminalRepair(
        "opencode-go",
        { baseUrl: "https://opencode.ai/zen/go/v1", adapter: "openai-chat", authMode: "key" },
        modelId,
      );
      expect(policy).toEqual({ graceMs: 5_000 });
    }
  });

  test("opencode-zen exposes 5s grace repair for free muse-spark models", () => {
    const entry = getProviderRegistryEntry("opencode-zen");
    expect(entry).toBeDefined();

    for (const modelId of ["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]) {
      const policy = providerModelResponsesTerminalRepair(
        "opencode-zen",
        { baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat", authMode: "key" },
        modelId,
      );
      expect(policy).toEqual({ graceMs: 5_000 });
    }
  });
});
