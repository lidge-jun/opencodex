// Registry model renames do not reach a saved provider config on their own.
//
// `reconcileOAuthProviders` refuses to touch a row whose `authMode` is not
// `oauth` (src/oauth/index.ts), and `enrichProviderFromRegistry` is fill-only by
// design: it backfills a MISSING field and never rewrites a present one, so a
// user's hand-edited model list survives an upgrade. Both postures are correct.
// Their gap is the case where the registry did not ADD a model but RENAMED one:
// the saved row keeps a retired id forever, the supported id never appears, and
// the capability metadata stays keyed to an id the vendor is taking offline
// (issue #1610 — `qwen3.8-max-preview` persisted through the `qwen3.8-max`
// rename in six separate fields, including a reasoning ladder that had since
// diverged from the registry's).
//
// This migration is deliberately NOT general reconciliation. It rewrites exactly
// one thing: an id this file declares retired, on a provider that still carries
// the registry's transport, and only when the registry currently seeds the
// replacement — and it skips a field where the retired entry is registry residue
// with nothing left to carry forward (see `isRegistryResidue`, issue #5066).
// Everything else in the row is left alone.

import { PROVIDER_REGISTRY } from "./registry";
import { providerConfigSeed } from "./derive";
import type { OcxConfig, OcxProviderConfig } from "../types";

export interface ModelRename {
  /** Registry provider id whose saved rows may carry the retired model id. */
  provider: string;
  from: string;
  to: string;
  /** Why the vendor retired it, for the startup warning and future readers. */
  reason: string;
  /**
   * Drop the retired key from `modelReasoningEffortMap` instead of renaming it.
   *
   * Renaming preserves the VALUE, which is right for records whose values describe the
   * model — a context window or an effort ladder survives a rename — and wrong for the
   * one record whose values are themselves wire ids. An effort map saved as
   * `high -> gemini-3.6-flash-high` would keep naming a dead wire id under the new key,
   * and the adapter maps effort BEFORE resolving CCA routing, so that value arrives as
   * an unrecognised effort and silently degrades to the default tier.
   *
   * Only that one record is dropped. Emptying the others would be worse than the bug:
   * catalog enrichment treats an existing `{}` as "already populated" and will not
   * restore the registry's records, so the migrated user would keep routing correctly
   * but lose the reasoning picker entirely.
   */
  dropReasoningEffortMap?: boolean;
  /**
   * Remove both the retired id and its replacement from `noReasoningModels`.
   *
   * Use this only when the rename also marks a capability change: carrying the old
   * no-reasoning classification onto a newly adjustable alias would keep the picker
   * disabled after the model id itself was repaired.
   */
  dropNoReasoningModels?: boolean;
  /** Refresh exact registry defaults already saved under the replacement id. */
  targetSeedRefresh?: {
    contextWindow?: { from: number; to: number };
    reasoning?: {
      fromEfforts: readonly string[];
      toEfforts: readonly string[];
      defaultEffort: string;
      effortMap: Readonly<Record<string, string>>;
    };
  };
}

const KIMI_K28_ALIAS = "kimi-for-coding";
const KIMI_RETIRED_CODING_IDS = [
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
] as const;
const KIMI_K28_TARGET_SEED_REFRESH: NonNullable<ModelRename["targetSeedRefresh"]> = {
  contextWindow: { from: 262_144, to: 1_048_576 },
  reasoning: {
    fromEfforts: [],
    toEfforts: ["low", "high", "max"],
    defaultEffort: "max",
    effortMap: { none: "none", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
  },
};

function kimiCodingRenames(provider: "kimi" | "kimi-code", endpoint: string): ModelRename[] {
  return KIMI_RETIRED_CODING_IDS.map(from => ({
    provider,
    from,
    to: KIMI_K28_ALIAS,
    reason: `Moonshot retired the k2.x coding ids from the ${endpoint}; kimi-for-coding is the stable alias the endpoint still serves`,
    dropNoReasoningModels: true,
    targetSeedRefresh: KIMI_K28_TARGET_SEED_REFRESH,
  }));
}

/**
 * Renames already applied to `PROVIDER_REGISTRY`. An entry stays here after the
 * registry moves on: it is what repairs configs saved before that move. Removing
 * one strands every config that has not started since the rename shipped.
 */
export const MODEL_RENAMES: readonly ModelRename[] = [
  {
    provider: "alibaba-token-plan",
    from: "qwen3.8-max-preview",
    to: "qwen3.8-max",
    reason: "Alibaba shipped Qwen3.8-Max as stable and documents the preview endpoint as liable to be taken offline once preview concludes",
  },
  {
    provider: "alibaba-token-plan-intl",
    from: "qwen3.8-max-preview",
    to: "qwen3.8-max",
    reason: "Alibaba shipped Qwen3.8-Max as stable and documents the preview endpoint as liable to be taken offline once preview concludes",
  },
  // Kimi coding renames. Moonshot retired the k2.x ids from the subscription/coding
  // endpoint when K2.8 Preview shipped (live /coding/v1/models lists only
  // kimi-for-coding[-highspeed], k3, k3-256k); kimi-for-coding is the stable alias the
  // endpoint still serves and currently routes to K2.8 Preview. The registry picker no
  // longer seeds the retired ids, so a saved defaultModel naming one is a dead selection
  // rather than a merely outdated one.
  ...kimiCodingRenames("kimi", "subscription endpoint after K2.8 Preview shipped"),
  ...kimiCodingRenames("kimi-code", "coding endpoint after K2.8 Preview shipped"),
  // Antigravity Flash generations. Google takes the previous Flash model off Cloud Code
  // Assist almost immediately when the next ships, so a saved 3.6 (or older 3.5) id is a
  // dead selection rather than a merely outdated one. Routing already redirects these ids
  // at request time; this migration repairs the saved config so the picker, the allowlist
  // and the capability maps stop naming a model the backend no longer serves.
  ...(["gemini-3.6-flash", "gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high",
    "gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3.5-flash-mid", "gemini-3.5-flash-high",
    "gemini-3-flash-agent"] as const).map(from => ({
    provider: "google-antigravity",
    from,
    to: "gemini-3.7-flash",
    reason: "Google retires the previous Antigravity Flash generation from Cloud Code Assist when its successor ships, so the saved id no longer resolves to a live model",
    // The retired Flash tiers were wire ids, so any saved per-model record keyed by one
    // may also hold one as a value. 3.7 expresses tiers as thinkingLevel names instead.
    dropReasoningEffortMap: true,
  })),
];

/** Provider fields that key metadata by model id. */
const MODEL_KEYED_RECORDS = [
  "modelContextWindows",
  "modelMaxOutputTokens",
  "modelInputModalities",
  "modelReasoningEfforts",
  "modelSuppressSyntheticMax",
  "modelDefaultReasoningEfforts",
  "modelReasoningEffortMap",
] as const;

/** Provider fields that are flat lists of model ids. */
const MODEL_ID_LISTS = [
  "models",
  // A retired id left here is worse than a stale label: `filterCatalogModels` treats
  // `selectedModels` as an exact-match allowlist, so a user who allowlisted only the
  // retired model gets NO replacement row at all — the model silently vanishes from
  // their catalog instead of being renamed. OAuth reconciliation does not cover this
  // field, so the rename has to.
  "selectedModels",
  // Same reasoning as `selectedModels`: a retired id pinned here would be resurrected as a
  // ghost row on every discovery instead of following the rename (#1690).
  "retainModels",
  "noVisionModels",
  "noReasoningModels",
  "noTemperatureModels",
  "noTopPModels",
  "noPenaltyModels",
  "autoToolChoiceOnlyModels",
  "preserveReasoningContentModels",
  "thinkingBudgetModels",
  "directReasoningEffortModels",
] as const;

function renameInList(value: unknown, from: string, to: string): string[] | null {
  if (!Array.isArray(value) || !value.includes(from)) return null;
  const seen = new Set<string>();
  const next: string[] = [];
  // Rename in place to preserve ordering, and collapse a duplicate if the target
  // id was already present alongside the retired one.
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const mapped = entry === from ? to : entry;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

function dropRenamedIdsFromList(
  value: unknown,
  from: string,
  to: string,
  dropStaleTarget: boolean,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const hasRetired = value.includes(from);
  if (!hasRetired && !(dropStaleTarget && value.includes(to))) return null;
  return value.filter(entry => typeof entry === "string" && entry !== from && entry !== to);
}

function renameInRecord(value: unknown, from: string, to: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(from in record)) return null;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const mapped = key === from ? to : key;
    if (mapped in next) continue;
    // An explicit entry already saved under the new id is the newer intent.
    next[mapped] = key === from && to in record ? record[to] : entry;
  }
  return next;
}

/** Drop the retired key entirely, leaving any entry already saved under the new id. */
function dropFromRecord(value: unknown, from: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(from in record)) return null;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === from) continue;
    next[key] = entry;
  }
  return next;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function targetReasoningMatchesStaleSeed(row: Record<string, unknown>, rename: ModelRename): boolean {
  const reasoning = rename.targetSeedRefresh?.reasoning;
  const efforts = row.modelReasoningEfforts as Record<string, unknown> | undefined;
  return !!reasoning && !!efforts && sameStringArray(efforts[rename.to], reasoning.fromEfforts);
}

/** Refresh only exact defaults emitted by the previous registry; preserve user overrides. */
function refreshTargetSeed(row: Record<string, unknown>, rename: ModelRename): boolean {
  const refresh = rename.targetSeedRefresh;
  if (!refresh) return false;
  let changed = false;

  const windows = row.modelContextWindows as Record<string, unknown> | undefined;
  if (windows && refresh.contextWindow && windows[rename.to] === refresh.contextWindow.from) {
    windows[rename.to] = refresh.contextWindow.to;
    changed = true;
  }

  const reasoning = refresh.reasoning;
  const efforts = row.modelReasoningEfforts as Record<string, unknown> | undefined;
  if (!reasoning || !efforts || !sameStringArray(efforts[rename.to], reasoning.fromEfforts)) return changed;
  efforts[rename.to] = [...reasoning.toEfforts];

  const defaults = (row.modelDefaultReasoningEfforts ??= {}) as Record<string, unknown>;
  if (!(rename.to in defaults)) defaults[rename.to] = reasoning.defaultEffort;
  const maps = (row.modelReasoningEffortMap ??= {}) as Record<string, unknown>;
  if (!(rename.to in maps)) maps[rename.to] = { ...reasoning.effortMap };
  return true;
}

/**
 * `provider/model` rows in the top-level `disabledModels` list.
 *
 * The retired row is DROPPED rather than renamed: carrying its disabled state to
 * the new id would hide the supported model behind a toggle the user set for a
 * different model. An existing row for the new id is left untouched.
 */
function renameDisabledModels(config: OcxConfig, rename: ModelRename): boolean {
  const list = config.disabledModels;
  if (!Array.isArray(list)) return false;
  const retired = `${rename.provider}/${rename.from}`;
  if (!list.includes(retired)) return false;
  config.disabledModels = list.filter(entry => entry !== retired);
  return true;
}

/**
 * Only migrate a row that still points at the registry's own endpoint. A user who
 * repointed `baseUrl` at a different vendor owns their model ids.
 */
function providerStillMatchesRegistry(name: string, prov: OcxProviderConfig): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === name);
  if (!entry) return false;
  if (!prov.baseUrl || !entry.baseUrl) return true;
  const choices = entry.baseUrlChoices?.map(choice => choice.baseUrl) ?? [];
  const known = [entry.baseUrl, ...choices]
    .filter((url): url is string => typeof url === "string")
    .map(url => url.replace(/\/+$/, ""));
  return known.includes(prov.baseUrl.replace(/\/+$/, ""));
}

/** Guard against a stale rename: only apply when the registry actually seeds `to`. */
function registrySeedsTarget(rename: ModelRename): boolean {
  const entry = PROVIDER_REGISTRY.find(row => row.id === rename.provider);
  return !!entry?.models?.includes(rename.to);
}

/** The row the registry contributes to a saved config, or `undefined` when it dropped the id. */
function registrySeed(provider: string): Record<string, unknown> | undefined {
  const entry = PROVIDER_REGISTRY.find(row => row.id === provider);
  return entry ? (providerConfigSeed(entry) as unknown as Record<string, unknown>) : undefined;
}

/** Whether a saved list or model-keyed record names this id at all. */
function publishes(container: unknown, id: string): boolean {
  if (Array.isArray(container)) return container.includes(id);
  if (!container || typeof container !== "object") return false;
  return id in (container as Record<string, unknown>);
}

/**
 * Whether this field’s retired entry is registry residue rather than something to repair.
 *
 * Two things have to be true. The registry’s own seed — `providerConfigSeed`, the row both the
 * OAuth preset (`deriveOAuthProviderConfig`) and `enrichProviderFromRegistry` contribute — must
 * still publish the retired id in this field, so the entry arrives in the config on its own. And
 * the saved field must already carry the supported id, so the rename would only DELETE a key,
 * with nothing to carry forward.
 *
 * Under those two conditions the rewrite is worse than a no-op, because it never converges.
 * `startServer` runs this migration and then `reconcileOAuthProviders`, and
 * `applyOAuthPresetCatalog` copies the preset’s record over the saved one whenever the two
 * differ. The deletion is undone inside the same boot, the config is written twice, and the user
 * is told about a rename that never sticks on every single start. Issue #5066 is exactly that:
 * `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` derives a window for every compatibility alias, so
 * `modelContextWindows` holds a key for all nine retired Flash ids beside the live ones — the
 * nine `[model-rename-migration]` lines the reporter saw at every `ocx start`, none of which
 * required them to have selected any of those nine models.
 *
 * Those registry entries are deliberate and stay: a request that still names `gemini-3.6-flash`
 * routes to 3.7 and needs a context window under the id it asked for. The second condition is
 * what keeps this narrow. A row that saved `{ "gemini-3.6-flash": 1048576 }` and nothing else
 * still gets the value carried onto the supported id, because dropping it there would blank the
 * record instead of moving it (`tests/adapters/google/gemini-37-flash-migration.test.ts`).
 */
function isRegistryResidue(
  seed: Record<string, unknown> | undefined,
  field: string,
  saved: unknown,
  rename: ModelRename,
): boolean {
  if (!seed) return false;
  return publishes(seed[field], rename.from) && publishes(saved, rename.to);
}

export interface ModelRenameProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

/**
 * Pure projection: apply every applicable rename and report what changed. The
 * caller decides whether to persist.
 */
export function projectModelRenames(
  config: OcxConfig,
  renames: readonly ModelRename[] = MODEL_RENAMES,
): ModelRenameProjection {
  const warnings: string[] = [];
  let changed = false;

  for (const rename of renames) {
    const prov = config.providers?.[rename.provider];
    if (!prov) continue;
    if (!registrySeedsTarget(rename)) {
      warnings.push(
        `registry no longer seeds "${rename.to}" for "${rename.provider}"; skipping the `
        + `"${rename.from}" rename rather than writing an id the registry does not know.`,
      );
      continue;
    }
    if (!providerStillMatchesRegistry(rename.provider, prov)) continue;

    // Provider config is a closed interface, so index through one unknown-cast
    // view rather than casting at each assignment.
    const row = prov as unknown as Record<string, unknown>;
    const seed = registrySeed(rename.provider);
    let touched = false;
    for (const field of MODEL_ID_LISTS) {
      if (isRegistryResidue(seed, field, row[field], rename)) continue;
      const next = rename.dropNoReasoningModels && field === "noReasoningModels"
        ? dropRenamedIdsFromList(
          row[field],
          rename.from,
          rename.to,
          targetReasoningMatchesStaleSeed(row, rename),
        )
        : renameInList(row[field], rename.from, rename.to);
      if (!next) continue;
      row[field] = next;
      touched = true;
    }
    for (const field of MODEL_KEYED_RECORDS) {
      if (isRegistryResidue(seed, field, row[field], rename)) continue;
      const next = rename.dropReasoningEffortMap && field === "modelReasoningEffortMap"
        ? dropFromRecord(row[field], rename.from)
        : renameInRecord(row[field], rename.from, rename.to);
      if (!next) continue;
      row[field] = next;
      touched = true;
    }
    if (prov.defaultModel === rename.from) {
      prov.defaultModel = rename.to;
      touched = true;
    }
    if (renameDisabledModels(config, rename)) touched = true;
    if (touched && refreshTargetSeed(row, rename)) touched = true;

    if (touched) {
      changed = true;
      warnings.push(
        `renamed "${rename.provider}/${rename.from}" to "${rename.to}" in the saved config: ${rename.reason}.`,
      );
    }
  }

  return { config, changed, warnings };
}
