/**
 * The saved-config half of the OpenCode Go DeepSeek reclassification.
 *
 * `enrichProviderFromRegistry` is fill-only and asymmetric: `noVisionModels` is filled
 * all-or-nothing and `modelInputModalities` is filled per-key BENEATH the saved value. A config
 * saved while the registry called `deepseek-v4.1-flash` text-only therefore keeps BOTH halves of
 * that claim forever, and images are stripped for a route that reads them (probed 2026-09-19).
 * Correcting the registry alone fixes new installs only.
 */
import { describe, expect, test } from "bun:test";
import {
  projectStaleVisionClassifications,
  STALE_VISION_CLASSIFICATIONS,
} from "../../src/providers/stale-vision-classification-migration";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import type { OcxConfig } from "../../src/types";

const MODEL = "deepseek-v4.1-flash";
const SIBLING = "deepseek-v4-flash";

/** A config saved while the stale seed was current. */
function staleConfig(
  modalities: Record<string, string[]> = { [MODEL]: ["text"], [SIBLING]: ["text"] },
  noVisionModels: string[] = [MODEL, SIBLING],
  adapter = "openai-chat",
  baseUrl = "https://opencode.ai/zen/go/v1",
): OcxConfig {
  return {
    providers: {
      "opencode-go": { adapter, baseUrl, modelInputModalities: { ...modalities }, noVisionModels: [...noVisionModels] },
    },
  } as unknown as OcxConfig;
}

describe("stale vision classification migration", () => {
  test("repairs both halves of the stale claim", () => {
    // Modalities alone would not be enough: the sidecar predicate checks noVisionModels FIRST and
    // short-circuits, so a row left in that list stays text-only however it is declared.
    const config = staleConfig();
    const projection = projectStaleVisionClassifications(config);
    expect(projection.changed).toBe(true);
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![MODEL]).toEqual(["text", "image"]);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).not.toContain(MODEL);
    expect(projection.warnings.join(" ")).toContain(MODEL);
  });

  test("leaves the sibling route classified text-only", () => {
    // deepseek-v4-flash still answers HTTP 400 "Model only supports text input" on this gateway.
    // A migration that widened the whole list would strip a real protection.
    const projection = projectStaleVisionClassifications(staleConfig());
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![SIBLING]).toEqual(["text"]);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).toContain(SIBLING);
  });

  test("leaves a modality value the operator chose alone", () => {
    // The guard is an exact match on the stale declaration. Anything else is a deliberate
    // override and outranks this migration.
    const projection = projectStaleVisionClassifications(
      staleConfig({ [MODEL]: ["text", "audio"], [SIBLING]: ["text"] }),
    );
    expect(projection.changed).toBe(false);
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![MODEL]).toEqual(["text", "audio"]);
  });

  test("finishes a half-repaired row whose name is still listed", () => {
    // The sidecar predicate reads noVisionModels BEFORE the modality list, so a row whose
    // modalities were already corrected but whose name is still listed keeps stripping images.
    // Leaving it alone was the gap the maintainer review found on #5164.
    const projection = projectStaleVisionClassifications(
      staleConfig({ [MODEL]: ["text", "image"], [SIBLING]: ["text"] }),
    );
    expect(projection.changed).toBe(true);
    expect(projection.config.providers!["opencode-go"]!.modelInputModalities![MODEL]).toEqual(["text", "image"]);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).not.toContain(MODEL);
    // The sibling keeps both halves: its modalities are not the migrated value, so nothing fires.
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).toContain(SIBLING);
    expect(projection.warnings.join(" ")).toContain("dropped from noVisionModels");
  });

  test("leaves a listed name without a readable modality declaration alone", () => {
    // Ambiguous on purpose: a half-finished repair and an entry the operator added by hand look
    // identical without the paired value, so the projection does not guess. Flagged to the
    // maintainer as an open question rather than decided here.
    const config = staleConfig({ [SIBLING]: ["text"] });
    const projection = projectStaleVisionClassifications(config);
    expect(projection.changed).toBe(false);
    expect(projection.config.providers!["opencode-go"]!.noVisionModels).toContain(MODEL);
  });

  test("never writes the dedicated modelCapabilities axis", () => {
    // `modelCapabilities` outranks every source this projection touches, so it is where a
    // deliberate text-only override survives a restart. A repair that also rewrote it would make
    // the operator's own `--text-only` decision unrecoverable.
    const config = staleConfig();
    config.providers!["opencode-go"]!.modelCapabilities = { [MODEL]: { inputModalities: ["text"] } };
    const projection = projectStaleVisionClassifications(config);
    expect(projection.config.providers!["opencode-go"]!.modelCapabilities![MODEL]!.inputModalities).toEqual(["text"]);
    // The axis only matters because it is read FIRST on the request path: the repair rewrites the
    // modality list and drops the name from `noVisionModels` around it, and the operator's
    // declaration still routes the image through the vision sidecar rather than to the model.
    const row = projection.config.providers!["opencode-go"]!;
    expect(row.modelInputModalities![MODEL]).toEqual(["text", "image"]);
    expect(row.noVisionModels ?? []).not.toContain(MODEL);
    expect(requiresVisionPreprocessing({ providers: { "opencode-go": row } }, row, MODEL, "opencode-go")).toBe(true);
  });

  test("skips a row that no longer carries the registry adapter", () => {
    const projection = projectStaleVisionClassifications(staleConfig(undefined, undefined, "anthropic"));
    expect(projection.changed).toBe(false);
  });

  test("follows the registry's destination rule where a preset opts into it", () => {
    // baseten is a key preset with preserveCustomDestination, so the registry owns a same-named row
    // only while it still points at the registry destination — the rule enrichProviderFromRegistry
    // applies before it writes registry metadata. Claiming such a row by name alone would rewrite
    // capability for an endpoint the registry does not describe.
    const entry = { provider: "baseten", model: MODEL, fromModalities: ["text"], toModalities: ["text", "image"] };
    const atRegistry = {
      adapter: "openai-chat",
      baseUrl: "https://inference.baseten.co/v1",
      modelInputModalities: { [MODEL]: ["text"] },
      noVisionModels: [MODEL],
    };
    const atOwnHost = { ...atRegistry, baseUrl: "https://operator-gateway.example/v1" };
    const config = (row: typeof atRegistry): OcxConfig => ({ providers: { baseten: row } } as unknown as OcxConfig);
    expect(projectStaleVisionClassifications(config(atRegistry), [entry]).changed).toBe(true);
    expect(projectStaleVisionClassifications(config(atOwnHost), [entry]).changed).toBe(false);
  });

  test("still repairs a pinned preset row at any destination", () => {
    // opencode-go is an existing key preset without preserveCustomDestination: the registry claims
    // that id itself, and enrichment fills its seed into such a row for the same reason. The
    // projection follows that policy instead of inventing a narrower one of its own.
    const projection = projectStaleVisionClassifications(
      staleConfig(undefined, undefined, "openai-chat", "https://operator-gateway.example/v1"),
    );
    expect(projection.changed).toBe(true);
  });

  test("is a no-op on a config without the provider", () => {
    const projection = projectStaleVisionClassifications({ providers: {} } as unknown as OcxConfig);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
  });

  test("every entry names a real correction the registry now carries", () => {
    // Guards against an entry that repairs a value the registry never claimed, or one whose
    // target the registry does not declare — either would be a silent no-op forever.
    for (const entry of STALE_VISION_CLASSIFICATIONS) {
      const registry = PROVIDER_REGISTRY.find(row => row.id === entry.provider);
      expect(registry, entry.provider).toBeDefined();
      expect(registry?.modelInputModalities?.[entry.model], entry.model).toEqual(entry.toModalities);
      expect(registry?.noVisionModels ?? [], entry.model).not.toContain(entry.model);
      expect(entry.fromModalities).not.toEqual(entry.toModalities);
    }
  });
});
