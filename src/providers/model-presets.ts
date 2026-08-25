/**
 * Shipped per-provider "latest/core" model presets (#2465).
 *
 * Adding a high-volume provider exposes its entire catalog to the Codex picker on day one:
 * openrouter ships 400+ rows, an Anthropic provider ships every historical snapshot. The useful
 * set is a handful of current flagships, so a newly added provider seeds from a curated preset
 * and "everything" stays one click away.
 *
 * Rules are ID PATTERNS rather than literal id lists so a vendor snapshot suffix does not stale
 * the preset between releases: `claude-opus-5-20260814` and `claude-opus-5` both match one rule.
 *
 * The preset is a SEED, not a lock. Materialization evaluates these rules against the provider's
 * current catalog and stores CONCRETE ids in `selectedModels`, so the visibility hot path
 * (`filterCatalogVisibleModels`) never learns about patterns and an older binary still sees a
 * plain allowlist. Design: devlog/_plan/260824_model_ux_aliases_and_defaults/030_default_preset.md
 */

import type { OcxProviderConfig } from "../types";

export interface ModelPresetRule {
  readonly pattern: RegExp;
}

export interface ModelPreset {
  /** Bumped whenever this provider's rules change; drives upgrade reconciliation. */
  readonly version: number;
  readonly rules: readonly ModelPresetRule[];
}

/**
 * Curated on the same release train as the provider registry. A provider WITHOUT an entry has no
 * preset and behaves exactly as today (mode "all").
 *
 * Deliberately limited to high-volume catalogs. A provider that already ships a short curated
 * list gains nothing from a preset and would only add a marker to reconcile.
 */
export const MODEL_PRESETS: Readonly<Record<string, ModelPreset>> = Object.freeze({
  openrouter: {
    version: 1,
    rules: [
      { pattern: /^anthropic\/claude-(opus|sonnet|haiku)-[45]/ },
      { pattern: /^google\/gemini-3(\.\d+)?-(pro|flash)/ },
      { pattern: /^openai\/gpt-5(\.\d+)?/ },
      { pattern: /^deepseek\/deepseek-(v4|r2)/ },
      { pattern: /^x-ai\/grok-4(\.\d+)?/ },
      { pattern: /^moonshotai\/kimi-k[23]/ },
      { pattern: /^z-ai\/glm-[45]/ },
    ],
  },
  anthropic: {
    version: 1,
    rules: [
      { pattern: /^claude-opus-[45]/ },
      { pattern: /^claude-sonnet-[45]/ },
      { pattern: /^claude-haiku-[45]/ },
      { pattern: /^claude-fable-5/ },
    ],
  },
  "anthropic-apikey": {
    version: 1,
    rules: [
      { pattern: /^claude-opus-[45]/ },
      { pattern: /^claude-sonnet-[45]/ },
      { pattern: /^claude-haiku-[45]/ },
      { pattern: /^claude-fable-5/ },
    ],
  },
});

/** The preset for a provider, or undefined when none is shipped. */
export function modelPresetFor(providerName: string): ModelPreset | undefined {
  return MODEL_PRESETS[providerName];
}

/** True when a provider has a shipped preset at all. */
export function hasModelPreset(providerName: string): boolean {
  return modelPresetFor(providerName) !== undefined;
}

/**
 * Evaluate a provider's rules against concrete catalog ids.
 *
 * Input order is preserved so a caller can show the preset in the same order the picker does.
 * Duplicates are collapsed; a model matching several rules is selected once.
 */
export function materializeModelPreset(
  providerName: string,
  catalogModelIds: Iterable<string>,
): string[] {
  const preset = modelPresetFor(providerName);
  if (!preset) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of catalogModelIds) {
    if (seen.has(id)) continue;
    // `RegExp.test` on a shared literal is safe here because no rule uses the `g` flag; a
    // sticky/global pattern would carry lastIndex between calls and skip rows.
    if (preset.rules.some(rule => rule.pattern.test(id))) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}


/**
 * Flip a provider out of preset mode when the user edits its selection (#2465).
 *
 * No-op unless the provider is currently in preset mode: "all" has no marker to keep, and
 * "custom" is already terminal. The applied version is retained so the GUI can still offer
 * "a newer preset is available" without losing what the user chose.
 */
export function markModelPresetDiverged(provider: OcxProviderConfig): void {
  const marker = provider.modelPreset;
  if (marker?.mode !== "preset") return;
  provider.modelPreset = { ...marker, mode: "custom" };
}

