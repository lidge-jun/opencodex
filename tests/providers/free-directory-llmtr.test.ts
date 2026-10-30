import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fixturePath } from "../helpers/repo-root";
import { FREE_PROVIDER_DIRECTORY } from "../../src/providers/free-directory";
import { extractProviderModelItems, providerModelDiscoverySpecError, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

// Sibling of provider-registry-parity.test.ts, which sits at the file-size ratchet threshold.
describe("free-provider directory: LLMTR", () => {
  test("the LLMTR row bounds its free models and keeps the paid catalog discoverable", () => {
    // The row accepts a key. Live discovery keeps chat rows from /v1/models and drops the rest.
    // Six chat ids were the standing zero-price set on 2026-10-29 (public GET /v1/models and the
    // model cards): three reset on a daily quota and three were listed free with no end date. Dated
    // promotions and EVREN bring-your-own-key rows also list a zero price, so the note must carry
    // those bounds instead of advertising the whole catalog as free.
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
      lastVerified: "2026-10-29",
    });
    expect(row?.keyOptional).toBeUndefined();
    expect(row?.models).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai/gpt-oss-safeguard-20b",
      "qwen/qwen3.8-27b-free",
      "nvidia/nemotron-3.5-super-vl-free",
      "agnes/agnes-3.0-flash",
      "agnes/agnes-2.5-flash",
    ]);
    const note = row?.note ?? "";
    expect(note).toContain("qwen/qwen3.8-27b-free");
    expect(note).toContain("daily quota");
    expect(note).toContain("A key is still required");
    expect(note).toContain("dated promotions");
    expect(note).toContain("EVREN bring-your-own-key");
    expect(note).toContain("Models that are neither listed above nor covered by those promotions or routes are paid");
    expect(note).toContain("llmtr/qwen3-8-27b");
    expect(note).toContain("https://llmtr.com/pricing");
    expect(row?.modelDiscovery).toEqual({
      filter: {
        allOf: [
          { path: ["supported_operations"], containsAll: ["CHAT_COMPLETIONS"] },
          { path: ["supported_endpoints"], containsAll: ["/v1/chat/completions"] },
        ],
      },
    });
    expect(providerModelDiscoverySpecError(row!.modelDiscovery!)).toBeNull();
    // Directory-only: it must not become a canonical credential destination.
    expect(PROVIDER_REGISTRY.some(entry => entry.id === "llmtr")).toBe(false);
  });

  test("live discovery keeps chat rows and drops image, embedding, rerank, video, and responses-only rows", () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://llmtr.com/v1" };
    const discovery = resolveProviderModelDiscovery("llmtr", provider);
    expect(discovery.spec).toEqual(FREE_PROVIDER_DIRECTORY.find(entry => entry.id === "llmtr")?.modelDiscovery);
    // A renamed row still points at the fixed destination, so it keeps the same filter.
    expect(resolveProviderModelDiscovery("llmtr-gateway", provider).spec).toEqual(discovery.spec);
    expect(resolveProviderModelDiscovery("llmtr", { ...provider, baseUrl: "https://llmtr.com/v1/" }).spec).toEqual(discovery.spec);
    expect(resolveProviderModelDiscovery("llmtr", { adapter: "openai-chat", baseUrl: "https://example.test/v1" }).spec).toBeUndefined();
    expect(resolveProviderModelDiscovery("llmtr", { ...provider, adapter: "anthropic" }).spec).toBeUndefined();
    expect(resolveProviderModelDiscovery("llmtr", { ...provider, authMode: "oauth" }).spec).toBeUndefined();

    const catalog = JSON.parse(readFileSync(fixturePath("llmtr-model-discovery.json"), "utf8")) as unknown;
    const result = extractProviderModelItems(catalog, discovery);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.items.map(item => item.id)).toEqual([
      "qwen/qwen3.8-27b-free",
      "llmtr/qwen3-8-27b",
      "google/gemini-3.8-flash",
    ]);
  });
});
