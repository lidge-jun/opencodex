/**
 * OpenCode Go Muse Spark 1.2 Contributor multimodal regression.
 *
 * Muse Spark answers /responses on Zen Go and accepts input_image parts, but the
 * registry declared no modelInputModalities for it, so the Codex catalog advertised
 * it text-only. The app gates image attachments client-side on input_modalities,
 * so a text-only entry blocks images ("This model does not support image inputs")
 * before the request ever reaches the proxy. These tests lock the declaration in
 * and prove the catalog advertises image input for Muse.
 */
import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../src/codex/catalog";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../src/providers/registry";
import { providerConfigSeed } from "../src/providers/derive";
import type { OcxProviderConfig } from "../src/types";

const MUSE_MODELS = ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor"] as const;

/** Seeded OpenCode Go provider config for the Muse Spark vision assertions. */
function opencodeGo(): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key" };
}

describe("OpenCode Go Muse Spark image input (#vision)", () => {
  test("registry declares Muse as text+image", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    for (const m of MUSE_MODELS) {
      expect(entry?.modelInputModalities?.[m]).toEqual(["text", "image"]);
    }
  });

  test("the registry seed carries Muse as text+image", () => {
    const prov = opencodeGo();
    for (const m of MUSE_MODELS) {
      expect(prov.modelInputModalities?.[m]).toEqual(["text", "image"]);
    }
  });

  test("applyProviderConfigHints advertises image input for Muse", () => {
    const prov = opencodeGo();
    for (const m of MUSE_MODELS) {
      const hinted = applyProviderConfigHints("opencode-go", prov, {
        id: m,
        provider: "opencode-go",
      });
      expect(hinted.inputModalities).toEqual(["text", "image"]);
    }
  });

  test("Muse is NOT in noVisionModels (it is natively multimodal, not sidecar-only)", () => {
    const prov = opencodeGo();
    for (const m of MUSE_MODELS) {
      expect(prov.noVisionModels ?? []).not.toContain(m);
      expect(prov.modelInputModalities?.[m]).toEqual(["text", "image"]);
    }
  });

  // The registry declaration only matters if it survives a live discovery row that
  // advertises Muse as text-only. Zen Go publishes no modality metadata, so a
  // discovered row can arrive with ["text"] or with nothing at all; in both cases the
  // configured value is authoritative (provider-fetch.ts applyProviderConfigHints reads
  // configuredInputModalities first). Without this the PR would pass while the catalog
  // still blocked image attachments in production.
  test("the configured declaration overrides a text-only discovered row", () => {
    const prov = opencodeGo();
    for (const m of MUSE_MODELS) {
      const hinted = applyProviderConfigHints("opencode-go", prov, {
        id: m,
        provider: "opencode-go",
        inputModalities: ["text"],
      });
      expect(hinted.inputModalities).toEqual(["text", "image"]);
    }
  });

  test("the configured declaration fills in a discovered row with no modalities", () => {
    const prov = opencodeGo();
    for (const m of MUSE_MODELS) {
      const hinted = applyProviderConfigHints("opencode-go", prov, {
        id: m,
        provider: "opencode-go",
      });
      expect(hinted.inputModalities).toEqual(["text", "image"]);
    }
  });
});
