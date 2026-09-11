import { describe, expect, test } from "bun:test";
import { catalogHintsFromModelsApiItem, discoveredPricingStatus } from "../../src/codex/catalog/provider-fetch";
import { deriveEntry } from "../../src/codex/catalog/sync";
import { clearModelCache } from "../../src/codex/model-cache";
import { listManagementModelRows } from "../../src/server/management/model-rows";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";
import type { OcxConfig } from "../../src/types";

/**
 * Regression coverage for #3666 — no way to filter free models in the Dashboard catalog.
 *
 * Live `/models` rows already carried `pricing`, but nothing downstream kept it:
 * `catalogHintsFromModelsApiItem` returned only window / modalities / reasoning / capabilities,
 * so `CatalogModel` had no cost field and both Dashboard lists could only substring-search. The
 * "Free" UI that existed was PROVIDER tier (`freeTier` / `keyOptional`), which is exactly why
 * OpenRouter — `freeTier` unset, paid and `:free` slugs mixed in one catalog — could not be
 * narrowed to $0 models.
 *
 * The classifier is deliberately fail-closed. Showing a paid model under a Free filter spends
 * the user's money; hiding a free one costs a click. So only a complete pair of non-negative
 * numeric rates classifies at all, and everything else stays unknown.
 */
describe("discovered model pricing classification (#3666)", () => {
  test("an OpenRouter free row classifies free from zero rate strings", () => {
    // OpenRouter quotes USD PER TOKEN as decimal strings; "0.00000000" is how it writes free.
    const item = { id: "google/gemma-3-1b-it:free", pricing: { prompt: "0.00000000", completion: "0" } };
    expect(discoveredPricingStatus(item)).toBe("free");
    expect(catalogHintsFromModelsApiItem("openrouter", item).pricingStatus).toBe("free");
  });

  test("numeric zeros classify free too", () => {
    expect(discoveredPricingStatus({ id: "local/free", pricing: { prompt: 0, completion: 0 } })).toBe("free");
  });

  test("a priced row classifies paid", () => {
    const item = { id: "anthropic/claude-sonnet-5", pricing: { prompt: "0.000003", completion: "0.000015" } };
    expect(discoveredPricingStatus(item)).toBe("paid");
    expect(catalogHintsFromModelsApiItem("openrouter", item).pricingStatus).toBe("paid");
  });

  test("a single non-zero rate is enough to be paid", () => {
    // A free prompt with a billed completion is still a model that charges.
    expect(discoveredPricingStatus({ id: "half", pricing: { prompt: "0", completion: "0.000001" } })).toBe("paid");
    expect(discoveredPricingStatus({ id: "half2", pricing: { prompt: "1e-6", completion: "0" } })).toBe("paid");
  });

  test("a provider that publishes no pricing is unknown, and the hint field is absent", () => {
    expect(discoveredPricingStatus({ id: "llama3.2" })).toBe("unknown");
    // Absent rather than present-and-"unknown": catalogHintsFromModelsApiItem's contract is that
    // an unknown property does not appear, which several provider contract tests deep-equal.
    expect(catalogHintsFromModelsApiItem("ollama", { id: "llama3.2" }).pricingStatus).toBeUndefined();
    expect(Object.hasOwn(catalogHintsFromModelsApiItem("ollama", { id: "llama3.2" }), "pricingStatus")).toBe(false);
  });

  test("a one-sided pair never classifies free", () => {
    expect(discoveredPricingStatus({ id: "prompt-only", pricing: { prompt: "0" } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "completion-only", pricing: { completion: 0 } })).toBe("unknown");
  });

  test("negative and non-numeric rates never classify free", () => {
    expect(discoveredPricingStatus({ id: "neg", pricing: { prompt: -1, completion: 0 } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "word", pricing: { prompt: "free", completion: "free" } })).toBe("unknown");
    // The shape test has to run before coercion: Number("") and Number(" ") are both 0, and
    // Number(true) is 1, so a bare Number() would have called each of these free or paid.
    expect(discoveredPricingStatus({ id: "empty", pricing: { prompt: "", completion: "" } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "blank", pricing: { prompt: " ", completion: " " } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "bool", pricing: { prompt: true, completion: true } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "nan", pricing: { prompt: Number.NaN, completion: 0 } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "inf", pricing: { prompt: Number.POSITIVE_INFINITY, completion: 0 } })).toBe("unknown");
    expect(discoveredPricingStatus({ id: "null", pricing: null })).toBe("unknown");
  });

  test("input/output are accepted as the rate names, and metadata.pricing is read", () => {
    expect(discoveredPricingStatus({ id: "io", pricing: { input: 0, output: 0 } })).toBe("free");
    expect(discoveredPricingStatus({ id: "io-paid", pricing: { input: "0.5", output: "1.5" } })).toBe("paid");
    expect(discoveredPricingStatus({ id: "nested", metadata: { pricing: { prompt: 0, completion: 0 } } })).toBe("free");
  });

  test("a :free id suffix is not evidence by itself", () => {
    // Nous ships :free slugs on a provider whose freeTier is false on purpose, so the naming
    // convention must never stand in for a published price.
    expect(discoveredPricingStatus({ id: "nousresearch/hermes-4-70b:free" })).toBe("unknown");
    expect(discoveredPricingStatus({
      id: "vendor/model:free",
      pricing: { prompt: "0.000002", completion: "0.000004" },
    })).toBe("paid");
  });

  test("the field is a management projection and never reaches the written Codex catalog", () => {
    const entry = deriveEntry(null, "openrouter/gemma-free", "desc", 10, {
      id: "gemma-free",
      provider: "openrouter",
      pricingStatus: "free",
    });
    expect(JSON.stringify(entry)).not.toContain("pricing");
  });
});

/**
 * The classifier above is only useful if the field survives the whole projection. It is set on a
 * discovery hint, merged by `applyProviderConfigHints`, spread by `listManagementModelRows`, and
 * read by the Dashboard and the CLI off `GET /api/models` — four hops, none of which names the
 * field explicitly, so any one of them could drop it without a single unit test noticing.
 */
describe("pricingStatus on the /api/models wire (#3666)", () => {
  const PROVIDER = "pricing-wire-test";

  function fixture(): OcxConfig {
    return withStubbedProviderFetch({
      port: 10100,
      modelCacheTtlMs: 0,
      providers: {
        [PROVIDER]: {
          adapter: "openai-chat",
          // A literal address: discovery pins the peer, so a hostname would need real DNS.
          baseUrl: "https://93.184.216.34/v1",
          apiKey: "sk-test",
        },
      },
    } as OcxConfig);
  }

  test("a discovered free row carries the field to the management row list", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({
      data: [
        { id: "gemma-free", pricing: { prompt: "0.00000000", completion: "0" } },
        { id: "sonnet-paid", pricing: { prompt: "0.000003", completion: "0.000015" } },
        { id: "unpriced" },
      ],
    })) as typeof fetch;
    try {
      const rows = await listManagementModelRows(fixture(), { entitlementWaitMs: 0 });
      const byId = (id: string) => rows.find(row => row.provider === PROVIDER && row.id === id);
      expect(byId("gemma-free")?.pricingStatus).toBe("free");
      expect(byId("sonnet-paid")?.pricingStatus).toBe("paid");
      // Absent, not "unknown": the same omission contract the hint follows reaches the wire, so
      // a client that treats a missing field as not-free is reading the intended signal.
      expect(byId("unpriced")).toBeDefined();
      expect(Object.hasOwn(byId("unpriced")!, "pricingStatus")).toBe(false);
      // Orthogonal to the operator's own overlay marker, which no row here has.
      expect(rows.every(row => !Object.hasOwn(row, "manualPricing"))).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      clearModelCache(PROVIDER);
    }
  });
});
