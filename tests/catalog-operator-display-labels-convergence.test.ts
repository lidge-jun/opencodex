import { describe, expect, test } from "bun:test";

import { applyOperatorDisplayLabels } from "../src/codex/catalog/display-labels";
import { CODEX_CUSTOM_MODEL_CATALOG_KIND } from "../src/codex/catalog/parsing";
import { buildCatalogEntries } from "../src/codex/catalog/sync";
import { validateConfigCandidate } from "../src/config";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import type { OcxConfig } from "../src/types/config";

/**
 * End-to-end cover for #2201: an operator label loaded through the *real* config
 * validator must reach `entry.display_name`, and must reach nothing else.
 *
 * The unit file beside this one pins `resolveModelDisplayLabel` in isolation. This
 * one exists because that is not the claim worth making — the claim is that the
 * value survives `validateConfigCandidate`, the label pass, and catalog assembly,
 * and that routing identity is byte-identical on the way through. Asserting the
 * resolver alone would pass even if the label never reached the picker.
 */

const NATIVE_SLUG = "gpt-5.5";
const NVIDIA_ID = "deepseek-ai/deepseek-v4-flash-0731";
/** What #2201 reports: the routed slug is what the operator sees today. */
const ROUTED_SLUG = "nvidia/deepseek-ai-deepseek-v4-flash-0731";

function template(): Record<string, unknown> {
  return {
    slug: NATIVE_SLUG,
    display_name: NATIVE_SLUG,
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, an agent based on GPT-5.",
    tool_mode: "code",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  };
}

/** Load through the real validator, so a test can never assert on a shape the loader would reject. */
function loadConfig(providerConfig: Record<string, unknown>): OcxConfig {
  const result = validateConfigCandidate({
    defaultProvider: "nvidia",
    providers: { nvidia: { adapter: "openai", baseUrl: "https://nim.example/v1", ...providerConfig } },
  });
  if (!result.ok) throw new Error(`fixture rejected by the config validator: ${result.error}`);
  return result.config;
}

function entriesFor(models: CatalogModel[], config: OcxConfig): Record<string, Record<string, unknown>> {
  const labeled = applyOperatorDisplayLabels(models, config);
  const built = buildCatalogEntries(
    template() as unknown as Parameters<typeof buildCatalogEntries>[0],
    [NATIVE_SLUG],
    labeled as unknown as Parameters<typeof buildCatalogEntries>[2],
    [],
    false,
  ) as unknown as Record<string, unknown>[];
  return Object.fromEntries(built.map(entry => [String(entry.slug), entry]));
}

const discovered = (): CatalogModel[] => [
  { provider: "nvidia", id: NVIDIA_ID, owned_by: "nvidia" } as CatalogModel,
];

describe("operator display labels through catalog assembly", () => {
  test("today's behaviour, so the fix is measured against something", () => {
    const entries = entriesFor(discovered(), loadConfig({}));
    // This is the defect #2201 describes: the label IS the routed slug.
    expect(entries[ROUTED_SLUG]?.display_name).toBe(ROUTED_SLUG);
  });

  test("an operator label reaches display_name and leaves routing identity alone", () => {
    const config = loadConfig({ modelDisplayNames: { [NVIDIA_ID]: "DeepSeek V4 Flash" } });
    const entries = entriesFor(discovered(), config);
    const row = entries[ROUTED_SLUG];

    expect(row?.display_name).toBe("DeepSeek V4 Flash");
    // Routing identity, unchanged: the slug is still the routed slug and is still
    // the key the entry is found under, so cost lookup, disabled-model lookup and a
    // saved selection all continue to resolve against the same string.
    expect(row?.slug).toBe(ROUTED_SLUG);
    expect(Object.keys(entries).sort()).toEqual([NATIVE_SLUG, ROUTED_SLUG].sort());
    // The native row is not a CatalogModel, so an upstream marketing name is untouched.
    expect(entries[NATIVE_SLUG]?.display_name).toBe(NATIVE_SLUG);
  });

  test("every field except display_name is byte-identical to the unlabelled build", () => {
    const before = entriesFor(discovered(), loadConfig({}))[ROUTED_SLUG] ?? {};
    const after = entriesFor(
      discovered(),
      loadConfig({ modelDisplayNames: { [NVIDIA_ID]: "DeepSeek V4 Flash" } }),
    )[ROUTED_SLUG] ?? {};

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const differing = Object.keys(after).filter(
      key => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
    );
    expect(differing).toEqual(["display_name"]);
  });

  test("removing the label deterministically restores the derived label", () => {
    const labelled = entriesFor(
      discovered(),
      loadConfig({ modelDisplayNames: { [NVIDIA_ID]: "DeepSeek V4 Flash" } }),
    );
    expect(labelled[ROUTED_SLUG]?.display_name).toBe("DeepSeek V4 Flash");

    // Both documented ways to take a label back off land on the same result.
    for (const cleared of [{}, { modelDisplayNames: {} }, { modelDisplayNames: { [NVIDIA_ID]: null } }]) {
      const entries = entriesFor(discovered(), loadConfig(cleared));
      expect(entries[ROUTED_SLUG]?.display_name).toBe(ROUTED_SLUG);
    }
  });

  test("the key space is the native model id, not the routed slug", () => {
    const config = loadConfig({ modelDisplayNames: { [ROUTED_SLUG]: "Wrong Key Space" } });
    const entries = entriesFor(discovered(), config);
    // A miss must be inert, not a partial relabel.
    expect(entries[ROUTED_SLUG]?.display_name).toBe(ROUTED_SLUG);
  });

  test("a label the loader drops cannot reach the catalog", () => {
    // `bad/label` would read as a routed slug, so the schema drops it on load and
    // the picker keeps the derived label rather than showing a second slug.
    const config = loadConfig({ modelDisplayNames: { [NVIDIA_ID]: "bad/label" } });
    expect(config.providers.nvidia?.modelDisplayNames).toBeUndefined();
    expect(entriesFor(discovered(), config)[ROUTED_SLUG]?.display_name).toBe(ROUTED_SLUG);
  });

  test("one unusable label does not cost the operator their other labels", () => {
    const other: CatalogModel = { provider: "nvidia", id: "moonshotai/kimi-k3", owned_by: "nvidia" } as CatalogModel;
    const config = loadConfig({
      modelDisplayNames: { [NVIDIA_ID]: "bad/label", "moonshotai/kimi-k3": "Kimi K3" },
    });
    const entries = entriesFor([...discovered(), other], config);

    expect(entries["nvidia/moonshotai-kimi-k3"]?.display_name).toBe("Kimi K3");
    expect(entries[ROUTED_SLUG]?.display_name).toBe(ROUTED_SLUG);
  });

  test("an existing custom-model label survives, which is #2201's migration rule", () => {
    const custom: CatalogModel = {
      provider: "nvidia",
      id: NVIDIA_ID,
      owned_by: "nvidia",
      displayName: "My Existing Custom Label",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
    } as CatalogModel;
    const config = loadConfig({ modelDisplayNames: { [NVIDIA_ID]: "Provider Map Value" } });

    const entries = entriesFor([custom], config);
    expect(entries[ROUTED_SLUG]?.display_name).toBe("My Existing Custom Label");
    expect(entries[ROUTED_SLUG]?.opencodex_catalog_kind).toBe(CODEX_CUSTOM_MODEL_CATALOG_KIND);
  });
});
