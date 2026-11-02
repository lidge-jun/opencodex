import { describe, expect, test } from "bun:test";
import { FREE_PROVIDER_DIRECTORY } from "../../src/providers/free-directory";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

// Sibling of provider-registry-parity.test.ts, which sits at the file-size ratchet threshold.
describe("free-provider directory: LLMTR", () => {
  test("the LLMTR row seeds only its standing free chat models and keeps the paid catalog discoverable", () => {
    // The row accepts a key and discovers the full /v1/models catalog, which is mostly paid. Only six
    // chat ids carry a zero list price with no end date (llmtr.com/v1/models and llmtr.com/pricing,
    // checked 2026-11-01); dated promotions and bring-your-own-key routes are not seeded.
    const row = FREE_PROVIDER_DIRECTORY.find(entry => entry.id === "llmtr");
    expect(row).toMatchObject({
      label: "LLMTR",
      adapter: "openai-chat",
      baseUrl: "https://llmtr.com/v1",
      authKind: "key",
      accessGroups: ["recurring-or-keyless"],
      supportLevel: "experimental",
      verification: "official",
      documentationUrl: "https://llmtr.com/docs/gateway/chat-completions/",
      modelsUrl: "https://llmtr.com/v1/models",
      dashboardUrl: "https://llmtr.com/dashboard/api-keys",
      discovery: "hybrid",
      liveModels: true,
      lastVerified: "2026-11-01",
    });
    expect(row?.keyOptional).toBeUndefined();
    expect(row?.models).toEqual([
      "qwen/qwen3.8-27b-free",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3.5-super-vl-free",
      "openai/gpt-oss-safeguard-20b",
      "agnes/agnes-2.5-flash",
      "agnes/agnes-3.0-flash",
    ]);
    const note = row?.note ?? "";
    expect(note).toContain("Only the six listed chat models are free");
    expect(note).toContain("An API key is still required");
    expect(note).toContain("daily quota");
    expect(note).toContain("dated promotions or bring-your-own-key routes");
    expect(note).toContain("every other discovered model is paid");
    expect(note).toContain("https://llmtr.com/pricing");
    // Directory-only: it must not become a canonical credential destination.
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "llmtr")).toBe(false);
  });
});
