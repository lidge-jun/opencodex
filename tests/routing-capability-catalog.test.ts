import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateCapabilityEvidence } from "../src/routing/capability";
import { applyCatalogModelMetadata } from "../src/codex/catalog/effort";
import { applyCatalogMetadata, ensureStrictCatalogFields } from "../src/codex/catalog/parsing";
import type { CatalogModel, RawEntry } from "../src/codex/catalog/parsing";
import { parseAntigravityAvailableModels } from "../src/providers/antigravity-models";
import type { OcxConfig } from "../src/types";

/**
 * Regression coverage for #1796.
 *
 * The catalog branch of `candidateCapabilityEvidence` was dead code: the reader
 * filtered on `id`/`provider` while the writer emits `slug`/`context_window`/
 * `input_modalities`, so every row was discarded. The repair reads an explicit
 * `opencodex_capability_provenance` block instead of the compatibility-shaped
 * fields, because `ensureStrictCatalogFields` synthesizes those for Codex's
 * strict parser and they therefore cannot distinguish an assertion from a
 * placeholder.
 *
 * These are writer-through-reader tests on purpose: hand-written catalog rows
 * would pass while the real writer emitted nothing.
 */

let codexHome = "";
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-capability-catalog-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
});

function serialize(model: CatalogModel): RawEntry {
  // Mirrors the real write order in src/codex/catalog/sync.ts:321-322 —
  // generated metadata first, then the model own fields, then strict
  // normalization fills the compatibility defaults Codex requires.
  const entry: RawEntry = { slug: `${model.provider}/${model.id}` } as RawEntry;
  applyCatalogMetadata(entry, model.provider, model.id, model.contextCap);
  applyCatalogModelMetadata(entry, model);
  return ensureStrictCatalogFields(entry, { isRouted: true });
}

function writeCatalog(models: CatalogModel[]): void {
  const entries = models.map(serialize);
  writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: entries }));
}

function configFor(providers: string[]): OcxConfig {
  // Providers declare NO modelContextWindows / modelInputModalities, so the
  // catalog is the only possible evidence source for those dimensions.
  const entries = providers.map(name => [name, {
    adapter: "openai-chat" as const,
    baseUrl: `https://${name}.example/v1`,
  }]);
  return { providers: Object.fromEntries(entries) } as unknown as OcxConfig;
}

describe("catalog-sourced capability evidence (#1796)", () => {
  test("carries asserted context window and image modality from a catalog-only model", () => {
    writeCatalog([{
      provider: "lidge",
      id: "qwen3.8-27b-nvfp4",
      contextWindow: 262144,
      inputModalities: ["text", "image"],
    } as CatalogModel]);

    const evidence = candidateCapabilityEvidence(configFor(["lidge"]), "lidge", "qwen3.8-27b-nvfp4");
    expect(evidence.contextWindow).toBe(262144);
    expect(evidence.image).toBe(true);
  });

  test("a synthesized strict-parser default stays unknown, never false", () => {
    // The model asserts nothing, so ensureStrictCatalogFields writes
    // context_window 128000 and input_modalities ["text"] for Codex. Neither is
    // evidence, and reading them back would make unknown look like a decision.
    writeCatalog([{ provider: "demo", id: "unknown-model" } as CatalogModel]);

    const evidence = candidateCapabilityEvidence(configFor(["demo"]), "demo", "unknown-model");
    expect(evidence.contextWindow).toBeUndefined();
    expect(evidence.image).toBeUndefined();
  });

  test("matching a catalog row does not revoke adapter tool support", () => {
    // The adapter fallback used to be gated on `catalogRow === undefined`, which
    // was only safe while the lookup never matched anything.
    writeCatalog([{
      provider: "lidge",
      id: "qwen3.8-27b-nvfp4",
      contextWindow: 262144,
      inputModalities: ["text", "image"],
    } as CatalogModel]);

    const evidence = candidateCapabilityEvidence(configFor(["lidge"]), "lidge", "qwen3.8-27b-nvfp4");
    expect(evidence.tools).toBe(true);
  });

  test("exact identity is not confused by a slug collision", () => {
    // Native ids "a/b" and "a-b" both encode to the Codex-facing slug "p/a-b".
    writeCatalog([
      { provider: "p", id: "a/b", contextWindow: 111000 } as CatalogModel,
      { provider: "p", id: "a-b", contextWindow: 222000 } as CatalogModel,
    ]);

    const config = configFor(["p"]);
    expect(candidateCapabilityEvidence(config, "p", "a/b").contextWindow).toBe(111000);
    expect(candidateCapabilityEvidence(config, "p", "a-b").contextWindow).toBe(222000);
  });

  test("synthesized combo rows are not stamped with capability provenance", () => {
    // Combo members fall back to a generic 128k/text synthesis, so those values
    // are placeholders rather than assertions.
    const entry = serialize({
      provider: "combo",
      id: "synthetic",
      contextWindow: 128000,
      inputModalities: ["text"],
    } as CatalogModel);

    expect(entry.opencodex_capability_provenance).toBeUndefined();
    // The synthesized value still ships to Codex, which is what makes it parse.
    expect(entry.context_window).toBe(128000);
  });
});

describe("provenance sources beyond the CatalogModel (#1796)", () => {
  test("captures generated metadata for an identity-only model", () => {
    // `applyCatalogMetadata` writes real values from the generated table without
    // ever touching a CatalogModel, so a stamp reading `model.*` alone would
    // drop every provider that depends on it.
    const entry = serialize({ provider: "opencode-go", id: "grok-4.6" } as CatalogModel);
    const provenance = entry.opencodex_capability_provenance as Record<string, unknown> | undefined;

    expect(provenance).toBeDefined();
    expect(provenance?.context_window).toBe(entry.context_window);
    expect(provenance?.input_modalities).toEqual(entry.input_modalities as string[]);
  });

  test("applies the provider context cap to generated metadata", () => {
    // The entry is capped before serialization; provenance must carry the same
    // value or routing would advertise a window the cap already refused.
    const entry = serialize({ provider: "opencode-go", id: "grok-4.6", contextCap: 350000 } as CatalogModel);
    const provenance = entry.opencodex_capability_provenance as Record<string, unknown> | undefined;

    expect(entry.context_window).toBe(350000);
    expect(provenance?.context_window).toBe(350000);
  });
});

describe("Antigravity supportsImages tri-state (#1796)", () => {
  function ccaPayload(info: Record<string, unknown>): unknown {
    return {
      models: { "wire-model": info },
      agentModelSorts: [{ groups: [{ modelIds: ["wire-model"] }] }],
    };
  }

  test("an absent supportsImages leaves modality unknown", () => {
    // Absent must not collapse into ["text"]: routing would read that as a
    // confident image:false for a model nobody made a claim about.
    const rows = parseAntigravityAvailableModels(ccaPayload({ maxTokens: 333333 }));
    expect(rows?.[0]?.inputModalities).toBeUndefined();
    expect(rows?.[0]?.contextWindow).toBe(333333);
  });

  test("an explicit supportsImages:false still asserts text-only", () => {
    const rows = parseAntigravityAvailableModels(ccaPayload({ maxTokens: 333333, supportsImages: false }));
    expect(rows?.[0]?.inputModalities).toEqual(["text"]);
  });

  test("an explicit supportsImages:true asserts image support", () => {
    const rows = parseAntigravityAvailableModels(ccaPayload({ maxTokens: 333333, supportsImages: true }));
    expect(rows?.[0]?.inputModalities).toEqual(["text", "image"]);
  });
});
