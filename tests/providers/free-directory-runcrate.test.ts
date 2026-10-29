import { describe, expect, test } from "bun:test";
import { FREE_PROVIDER_DIRECTORY } from "../../src/providers/free-directory";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

// Sibling of provider-registry-parity.test.ts, which sits at the file-size ratchet threshold.
describe("free-provider directory: Runcrate", () => {
  test("the Runcrate row bounds its free allowance and keeps the paid catalog discoverable", () => {
    // The row accepts a key and discovers the full /v1/models catalog, which is mostly paid. Only
    // six named models have a free allowance (runcrate.ai/inference/free and free_tier in /v1/models,
    // checked 2026-10-27), so the note must carry those bounds instead of advertising the whole catalog as free.
    const row = FREE_PROVIDER_DIRECTORY.find(entry => entry.id === "runcrate");
    expect(row).toMatchObject({
      label: "Runcrate",
      adapter: "openai-chat",
      baseUrl: "https://api.runcrate.ai/v1",
      authKind: "key",
      accessGroups: ["recurring-or-keyless"],
      supportLevel: "experimental",
      verification: "official",
      documentationUrl: "https://www.runcrate.ai/docs/models/chat-completions",
      modelsUrl: "https://api.runcrate.ai/v1/models",
      dashboardUrl: "https://www.runcrate.ai/dashboard/api-keys",
      discovery: "hybrid",
      liveModels: true,
      lastVerified: "2026-10-27",
    });
    expect(row?.keyOptional).toBeUndefined();
    expect(row?.models).toEqual([
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "zai-org/GLM-5.3-Flash",
      "zai-org/GLM-5.3",
      "openai/gpt-oss-120b",
      "Qwen/Qwen3.8-Flash",
    ]);
    const note = row?.note ?? "";
    expect(note).toContain("Only the six listed open models have a free allowance");
    expect(note).toContain("GitHub account at least 30 days old");
    expect(note).toContain("per session and per week");
    expect(note).toContain("Every other discovered model is paid");
    expect(note).toContain("continues as paid traffic");
    expect(note).toContain("https://www.runcrate.ai/inference/free");
    // Directory-only: it must not become a canonical credential destination.
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "runcrate")).toBe(false);
  });
});
