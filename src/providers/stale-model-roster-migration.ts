/**
 * Add registry models to a saved roster that is still the previous registry seed.
 *
 * `enrichProviderFromRegistry` copies the registry's `models` only when a row has none, so
 * every config saved while an older roster was current keeps that roster forever. That is
 * the right posture for a hand-edited list and the wrong one for an untouched seed: a model
 * the vendor added never reaches the install, and when the vendor's live `/models` roster
 * does not list it either, nothing else can surface it.
 *
 * This rewrites one thing: a saved `models` list that is still byte-for-byte the roster
 * this file names as `from`, on a provider that still carries the registry adapter, and
 * only while the registry currently seeds `to`. A list the user changed does not match and
 * is left alone. For each added id it also fills a per-model context window and default
 * effort, but only inside a container the row already has: enrichment fills those records
 * all-or-nothing, so creating one here would hide the rest of the registry seed.
 * Same shape and restraint as `stale-context-window-migration`.
 */
import { PROVIDER_REGISTRY } from "./registry";
import {
  MINIMAX_M31_DEFAULT_REASONING_EFFORT,
  MINIMAX_M31_FLASH_PREVIEW,
  MINIMAX_MODELS,
  MINIMAX_MODELS_BEFORE_M31,
  MINIMAX_MODEL_CONTEXT_WINDOWS,
} from "./registry/model-seeds";
import type { OcxConfig } from "../types";

export interface StaleModelRoster {
  /** Registry provider id whose saved rows may carry the old roster. */
  provider: string;
  /** The exact saved roster this migration may replace, and nothing else. */
  from: readonly string[];
  to: readonly string[];
  /** Per-model seed values for the added ids, written only into containers that exist. */
  contextWindows?: Readonly<Record<string, number>>;
  defaultReasoningEfforts?: Readonly<Record<string, string>>;
}

export interface StaleModelRosterProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

/**
 * MiniMax-M3.1-Flash-Preview (2026-09-30). MiniMax's /v1/models roster does not list the
 * preview, so live discovery cannot add it; the catalog keeps it only when it is configured.
 */
export const STALE_MODEL_ROSTERS: readonly StaleModelRoster[] = ["minimax", "minimax-cn"].map(provider => ({
  provider,
  from: MINIMAX_MODELS_BEFORE_M31,
  to: MINIMAX_MODELS,
  contextWindows: { [MINIMAX_M31_FLASH_PREVIEW]: MINIMAX_MODEL_CONTEXT_WINDOWS[MINIMAX_M31_FLASH_PREVIEW]! },
  defaultReasoningEfforts: { [MINIMAX_M31_FLASH_PREVIEW]: MINIMAX_M31_DEFAULT_REASONING_EFFORT },
}));

function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function registrySeeds(provider: string, adapter: unknown, roster: readonly string[]): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === provider);
  return entry !== undefined && entry.adapter === adapter && sameList(entry.models, roster);
}

function fillExisting<T>(container: Record<string, T> | undefined, values: Readonly<Record<string, T>> | undefined, ids: readonly string[]): void {
  if (!container || !values) return;
  for (const id of ids) {
    const value = values[id];
    if (value !== undefined && !Object.prototype.hasOwnProperty.call(container, id)) container[id] = value;
  }
}

/** Pure projection. The caller decides whether to persist. */
export function projectStaleModelRosters(
  config: OcxConfig,
  entries: readonly StaleModelRoster[] = STALE_MODEL_ROSTERS,
): StaleModelRosterProjection {
  const warnings: string[] = [];
  let changed = false;

  for (const entry of entries) {
    const prov = config.providers?.[entry.provider];
    if (!prov) continue;
    if (!registrySeeds(entry.provider, prov.adapter, entry.to)) continue;
    if (!sameList(prov.models, entry.from)) continue;
    const added = entry.to.filter(id => !entry.from.includes(id));
    prov.models = [...entry.to];
    fillExisting(prov.modelContextWindows, entry.contextWindows, added);
    fillExisting(prov.modelDefaultReasoningEfforts, entry.defaultReasoningEfforts, added);
    changed = true;
    warnings.push(
      `added ${added.join(", ")} to the saved "${entry.provider}" model list, which was still `
      + "the previous registry seed.",
    );
  }

  return { config, changed, warnings };
}
