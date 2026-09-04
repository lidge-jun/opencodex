import { afterEach, describe, expect, test } from "bun:test";
import { buildCatalogEntries, gatherRoutedModels as gatherRoutedModelsDirect, upstreamNativeEntry } from "../../src/codex/catalog";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import { resetCatalogRuntimeStateForTests, resetOpenAiApiCatalogWarningStateForTests } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetOpenAiApiCatalogWarningStateForTests();
  resetCatalogRuntimeStateForTests();
});

const originalFetch = globalThis.fetch;

/**
 * A serialized row that declares `support_verbosity: false` must not also carry a
 * `default_verbosity`. Codex seeds its picker from `default_verbosity`, so leaving the
 * strict-fields fallback in place re-creates the dead toggle that the explicit opt-out
 * (#2578 architecture) removed. All field names here are the SERIALIZED Codex spellings —
 * `supports_verbosity` does not exist in this format, which is exactly how an earlier
 * assertion passed while every routed row advertised the control.
 */
describe("catalog — default_verbosity is dropped when verbosity is unsupported", () => {
  test("GREEN: an opted-out routed row carries no verbosity default", async () => {
    const models = await gatherRoutedModels({
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          liveModels: false,
          models: ["grok-4.6"],
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);
    const xai = entries.find(e => e.slug === "xai/grok-4.6");
    expect(xai?.support_verbosity).toBe(false);
    expect(xai?.default_verbosity).toBeUndefined();
  });

  test("GREEN: a Kiro opted-out row carries no verbosity default either", async () => {
    const models = await gatherRoutedModels({
      providers: {
        kiro: {
          adapter: "kiro",
          baseUrl: "https://runtime.us-east-1.kiro.dev",
          authMode: "oauth",
          liveModels: false,
          models: ["gpt-5.6-sol"],
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);
    const kiro = entries.find(e => e.slug === "kiro/gpt-5.6-sol");
    expect(kiro?.support_verbosity).toBe(false);
    expect(kiro?.default_verbosity).toBeUndefined();
  });

  test("CONTROL: rows that never declare a capability keep the permissive default", async () => {
    const models = await gatherRoutedModels({
      providers: {
        plain: {
          adapter: "openai-responses",
          baseUrl: "https://plain.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["plain-model"],
        },
      },
    });
    const entries = buildCatalogEntries(null, [], models);
    const plain = entries.find(e => e.slug === "plain/plain-model");
    expect(plain?.support_verbosity).toBe(true);
    expect(plain?.default_verbosity).toBe("low");
  });

  test("CONTROL: a native OpenAI row keeps verbosity and its default", () => {
    const template = upstreamNativeEntry("gpt-5.6-sol");
    expect(template).not.toBeNull();
    const entries = buildCatalogEntries(template, ["gpt-5.6-sol"], []);
    const native = entries.find(e => e.slug === "gpt-5.6-sol");
    expect(native?.support_verbosity).toBe(true);
    expect(native?.default_verbosity).toBe("low");
  });
});
