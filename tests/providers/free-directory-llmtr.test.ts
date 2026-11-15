import { describe, expect, test } from "bun:test";
import { FREE_PROVIDER_DIRECTORY } from "../../src/providers/free-directory";
import { resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

// Sibling of provider-registry-parity.test.ts, which sits at the file-size ratchet threshold.
describe("free-provider directory: LLMTR", () => {
  test("LLMTR is listed as a reference row with no runtime destination", () => {
    const row = FREE_PROVIDER_DIRECTORY.find(entry => entry.id === "llmtr");
    expect(row).toMatchObject({
      label: "LLMTR",
      accessGroups: ["recurring-or-keyless"],
      supportLevel: "reference",
      verification: "unverified",
      baseUrl: "",
      discovery: "unsupported",
      liveModels: false,
    });
    expect(row?.lastVerified).toBeUndefined();
    expect(row?.models).toBeUndefined();
    expect(row?.modelsUrl).toBeUndefined();
    expect(row?.note).toContain("Reference entry only");
    // Directory-only: it must not become a canonical credential destination.
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "llmtr")).toBe(false);
  });

  test("a provider pointed at LLMTR's host gets no directory discovery filter", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://llmtr.com/v1", authMode: "key" };
    expect(resolveProviderModelDiscovery("llmtr", provider).spec).toBeUndefined();
  });
});
