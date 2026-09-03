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

const MUSE_MODEL = "muse-spark-1.2-contributor";
const MUSE_13_MODEL = "muse-spark-1.3-contributor";

/** Seeded OpenCode Go provider config for the Muse Spark vision assertions. */
function opencodeGo(): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key" };
}

describe("OpenCode Go Muse Spark image input (#vision)", () => {
  test("registry declares Muse as text+image", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelInputModalities?.[MUSE_MODEL]).toEqual(["text", "image"]);
  });

  test("the registry seed carries Muse as text+image", () => {
    const prov = opencodeGo();
    expect(prov.modelInputModalities?.[MUSE_MODEL]).toEqual(["text", "image"]);
  });

  test("applyProviderConfigHints advertises image input for Muse", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("Muse is NOT in noVisionModels (it is natively multimodal, not sidecar-only)", () => {
    const prov = opencodeGo();
    expect(prov.noVisionModels ?? []).not.toContain(MUSE_MODEL);
    expect(prov.modelInputModalities?.[MUSE_MODEL]).toEqual(["text", "image"]);
  });

  // The registry declaration only matters if it survives a live discovery row that
  // advertises Muse as text-only. Zen Go publishes no modality metadata, so a
  // discovered row can arrive with ["text"] or with nothing at all; in both cases the
  // configured value is authoritative (provider-fetch.ts applyProviderConfigHints reads
  // configuredInputModalities first). Without this the PR would pass while the catalog
  // still blocked image attachments in production.
  test("the configured declaration overrides a text-only discovered row", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
      inputModalities: ["text"],
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  test("the configured declaration fills in a discovered row with no modalities", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_MODEL,
      provider: "opencode-go",
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });

  // 1.3 shipped 2026-09-02 on the same Zen Go roster with the same spec as 1.2.
  // Zen publishes no modality metadata, so without its own declaration the newer
  // model would regress to the exact text-only block 1.2 was fixed for.
  test("Muse Spark 1.3 Contributor carries the same text+image declaration", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-go");
    expect(entry?.modelInputModalities?.[MUSE_13_MODEL]).toEqual(["text", "image"]);
    const prov = opencodeGo();
    expect(prov.modelInputModalities?.[MUSE_13_MODEL]).toEqual(["text", "image"]);
    expect(prov.noVisionModels ?? []).not.toContain(MUSE_13_MODEL);
  });

  test("1.3's configured declaration overrides a text-only discovered row", () => {
    const prov = opencodeGo();
    const hinted = applyProviderConfigHints("opencode-go", prov, {
      id: MUSE_13_MODEL,
      provider: "opencode-go",
      inputModalities: ["text"],
    });
    expect(hinted.inputModalities).toEqual(["text", "image"]);
  });
});
