import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("google-antigravity");
});

describe("Google Antigravity static catalog", () => {
  test("registry seed surfaces its static models without live discovery", async () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "google-antigravity")!;
    const staticModels = entry.models!;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.resolve(Response.json({ data: [{ id: "unexpected-live-model" }] }));
    }) as typeof fetch;

    const models = await gatherRoutedModels(withStubbedProviderFetch({
      providers: {
        "google-antigravity": {
          ...providerConfigSeed(entry),
          authMode: "key",
          apiKey: "test-token",
          liveModels: false,
        },
      },
    }));

    expect(fetchCalls).toBe(0);
    expect(models.filter(model => model.provider === entry.id).map(model => model.id).sort()).toEqual([...staticModels].sort());
  });
});
