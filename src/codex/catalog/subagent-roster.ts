// Holds INV-AGENT-01 from structure/overview.md; keep the id here if this file is split or renamed.
import { slugsEquivalent } from "../../providers/slug-codec";
import { readCatalog, readCodexCatalogPath } from "./parsing";
import type { RawEntry } from "./parsing";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "./metadata";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { catalogEntryEfforts } from "./effort";

export const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5;

// Base for config.modelPickerOrder display priorities (#1649). modelPickerOrder is a DISPLAY-ONLY
// reordering of the Codex model picker: it rewrites a row's Codex-visible `priority` but not
// OpenCodex's natural-priority guidance window. Native Codex advertisements still follow the
// visible priority and can differ from that guidance window.
export const PICKER_ORDER_PRIORITY_BASE = 1_000;

// OpenCodex-private catalog field: the guidance candidate priority a row would have WITHOUT
// modelPickerOrder. Codex ignores unknown catalog fields (same as opencodex_catalog_kind), so this
// is invisible to Codex; effectiveSubagentRoster reads it to keep OpenCodex guidance candidates
// independent of display order. It does not freeze native advertisements. Absent on unmoved rows.
export const SPAWN_PRIORITY_FIELD = "opencodex_spawn_priority";

// OpenCodex-private catalog field: this row is listed but currently unable to serve (#1711).
// Codex ignores unknown catalog fields (same as opencodex_catalog_kind and the spawn priority
// above) and ensureStrictCatalogFields does not strip extras, so this is invisible to the native
// picker and cannot change what Codex offers. It never touches `visibility`.
export const CATALOG_INACTIVE_REASON_FIELD = "opencodex_inactive_reason";

export type SpawnAgentSurface = "v1" | "v2";

export type SubagentRosterExclusionReason =
  | "missing_catalog_entry"
  | "picker_hidden"
  | "surface_incompatible"
  | "outside_display_limit";

/**
 * Whether a catalog entry may be offered as a V2 subagent model.
 *
 * Upstream changed this rule in codex-rs `6d4d9442c` ("Support leaf models in
 * multi-agent v2"). `model_supports_multi_agent_backend`
 * (core/src/tools/handlers/multi_agents_common.rs:36-42) now admits EVERY model
 * except one explicitly marked `disabled`; the older `== Some(V2)` equality that
 * `92938d880` introduced is gone.
 *
 * The field no longer answers "may I be a delegation target". It answers "does the
 * CHILD get collaboration tools": `collab_tools_enabled`
 * (core/src/tools/spec_plan.rs:599-610) grants a child recursive tools only when its
 * own catalog value is exactly `Some(V2)`. The three-way distinction survives, but it
 * now means eligible-recursive / eligible-LEAF / excluded:
 *
 * - `"v2"`       -> eligible, and the child may itself delegate.
 * - `"v1"`       -> eligible LEAF worker. This is upstream's pin for `gpt-5.6-luna`
 *                   (models-manager/models.json); excluding it here is exactly what
 *                   kept Luna out of opencodex's roster.
 * - absent/null  -> eligible LEAF worker (routed or unpinned-native model).
 * - `"disabled"` -> the sole capability-based exclusion.
 *
 * This is the roster filter only. Catalog STAMPING is a separate concern owned by
 * `applyMultiAgentMode`, including the `keepNativeChatGptOnV1` policy (#1728) that
 * keeps ChatGPT-native rows on `v1` so a native parent can still spawn a routed child
 * despite backend-encrypted NEW_TASK bodies (#92). Recognizing those `v1` rows as
 * eligible leaves here is what makes that policy usable, not a contradiction of it.
 *
 * Devlog: 260816_codexrs_multiagent_v2_and_history_perf/011 (C1), superseding the
 * option-B decision in 260730_codex_rs_upstream_v2_live_handoff/060.
 */
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  return entry.multi_agent_version !== "disabled";
}

export interface EffectiveSubagentModel {
  model: string;
  efforts: string[];
}

export interface SubagentRosterExclusion {
  configured: string;
  reason: SubagentRosterExclusionReason;
  catalogModel?: string;
}

export interface EffectiveSubagentRoster {
  /** OpenCodex's natural-priority guidance projection, not captured native tool text. */
  candidates: EffectiveSubagentModel[];
  /** Configured models within that projection; exact-name eligibility is a separate check. */
  advertised: EffectiveSubagentModel[];
  excluded: SubagentRosterExclusion[];
}

export function configuredCatalogEntry(entries: readonly RawEntry[], configured: string): RawEntry | undefined {
  return entries.find(entry => entry.slug === configured)
    ?? entries.find(entry => typeof entry.slug === "string" && slugsEquivalent(configured, entry.slug));
}

function configuredSubagentModelMatchesEntry(configured: string, entry: RawEntry): boolean {
  if (typeof entry.slug !== "string") return false;
  if (slugsEquivalent(configured, entry.slug)) return true;
  const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
  return !configured.includes("/")
    && nativeSlug !== undefined
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)
    && slugsEquivalent(configured, nativeSlug);
}

export function effectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
  catalogEntries?: readonly RawEntry[],
): EffectiveSubagentRoster {
  const configured = configuredModels
    .filter(model => model.trim().length > 0)
    .filter((model, index, all) =>
      !all.slice(0, index).some(previous => slugsEquivalent(previous, model))
    );
  const entries = catalogEntries ?? readCatalog(readCodexCatalogPath())?.models ?? [];
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.slug === "string")
    .filter(({ entry }) => entry.visibility === "list")
    .filter(({ entry }) => surface !== "v2" || isEligibleV2SubagentEntry(entry))
    .sort((left, right) => {
      // OpenCodex guidance candidates rank by natural priority (SPAWN_PRIORITY_FIELD when present),
      // so modelPickerOrder does not change this projection. Native tool advertisements differ. Rows the
      // override did not move fall back to their Codex-visible `priority`.
      const spawnPriorityOf = (entry: RawEntry): number => {
        const spawn = entry[SPAWN_PRIORITY_FIELD];
        if (typeof spawn === "number" && Number.isFinite(spawn)) return spawn;
        return typeof entry.priority === "number" && Number.isFinite(entry.priority)
          ? entry.priority : Number.MAX_SAFE_INTEGER;
      };
      const leftPriority = spawnPriorityOf(left.entry);
      const rightPriority = spawnPriorityOf(right.entry);
      return leftPriority - rightPriority || left.index - right.index;
    })
    .slice(0, MAX_SPAWN_AGENT_MODEL_OVERRIDES);
  const orderedEntries = new Set(ordered.map(({ entry }) => entry));

  const candidates = ordered.map(({ entry }) => ({
    model: entry.slug as string,
    efforts: catalogEntryEfforts(entry),
  }));
  const advertised = ordered
    .filter(({ entry }) => configured.some(model => configuredSubagentModelMatchesEntry(model, entry)))
    .map(({ entry }) => ({
      model: entry.slug as string,
      efforts: catalogEntryEfforts(entry),
    }));
  const excluded = configured.flatMap((model): SubagentRosterExclusion[] => {
    const matchingEntries = entries.filter(entry => configuredSubagentModelMatchesEntry(model, entry));
    if (matchingEntries.some(entry => orderedEntries.has(entry))) return [];
    if (matchingEntries.length === 0) return [{ configured: model, reason: "missing_catalog_entry" }];
    const visibleCompatible = matchingEntries.find(entry =>
      entry.visibility === "list"
      && (surface !== "v2" || isEligibleV2SubagentEntry(entry))
    );
    if (visibleCompatible) {
      return [{
        configured: model,
        catalogModel: visibleCompatible.slug as string,
        reason: "outside_display_limit",
      }];
    }
    const visible = matchingEntries.find(entry => entry.visibility === "list");
    if (visible) {
      return [{
        configured: model,
        catalogModel: visible.slug as string,
        reason: "surface_incompatible",
      }];
    }
    const hidden = configuredCatalogEntry(entries, model) ?? matchingEntries[0]!;
    return [{ configured: model, catalogModel: hidden.slug as string, reason: "picker_hidden" }];
  });
  return { candidates, advertised, excluded };
}
