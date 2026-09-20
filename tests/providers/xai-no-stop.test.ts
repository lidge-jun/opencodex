import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { XAI_MODELS } from "../../src/providers/registry/model-seeds";

describe("xAI noStopModels", () => {
  test("seeds every listed Grok Chat Completions id so Claude auto-mode stop_sequences are dropped", () => {
    const xai = PROVIDER_REGISTRY.find(provider => provider.id === "xai");
    expect(xai?.noStopModels).toEqual([...XAI_MODELS]);
    expect(xai?.noStopModels).toContain("grok-4.6");
  });
});
