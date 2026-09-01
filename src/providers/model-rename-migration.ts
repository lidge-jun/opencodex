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
// replacement. Everything else in the row is left alone.

import { PROVIDER_REGISTRY } from "./registry";
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
    let touched = false;
    for (const field of MODEL_ID_LISTS) {
      const next = renameInList(row[field], rename.from, rename.to);
      if (!next) continue;
      row[field] = next;
      touched = true;
    }
    for (const field of MODEL_KEYED_RECORDS) {
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

    if (touched) {
      changed = true;
      warnings.push(
        `renamed "${rename.provider}/${rename.from}" to "${rename.to}" in the saved config: ${rename.reason}.`,
      );
    }
  }

  return { config, changed, warnings };
}
