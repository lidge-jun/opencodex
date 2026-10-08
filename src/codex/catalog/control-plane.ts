import { CODEX_INTERNAL_OPENAI_MODELS, isCodexControlPlaneModel } from "../control-plane-models";
import { COMBO_NAMESPACE } from "../../combos";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";
import { NATIVE_RESERVE_MODEL, SUPPORTED_NATIVE_OPENAI_SLUGS } from "./native-models";
import { isReserveCatalogProjection } from "./reserve";
import { pinnedNativeModelRows } from "./pinned-models";
import type { RawEntry } from "./parsing";

/** Hidden ordinary natives qualify; Reserve, account choices and routed aliases do not. */
export function hasOrdinaryNativeOpenAiRow(entries: readonly RawEntry[]): boolean {
  return entries.some(entry => typeof entry.slug === "string"
    && !entry.slug.includes("/")
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(entry.slug)
    && entry.slug !== NATIVE_RESERVE_MODEL
    && !isReserveCatalogProjection(entry)
    && entry.opencodex_catalog_kind !== CODEX_NATIVE_ALIAS_CATALOG_KIND
    && entry.owned_by !== COMBO_NAMESPACE);
}

/** Keep internal reviewer metadata separate from native synthesis, picker ordering and account clones. */
export function withCodexControlPlaneRows(
  entries: RawEntry[],
  sourceRows: readonly RawEntry[],
  includeNativeOpenAi: boolean,
  wsEnabled: boolean,
): RawEntry[] {
  const models = entries.filter(entry => !isCodexControlPlaneModel(entry.slug));
  if (!includeNativeOpenAi || !hasOrdinaryNativeOpenAiRow(models)) return models;
  for (const slug of CODEX_INTERNAL_OPENAI_MODELS) {
    const source = sourceRows.find(entry => entry.slug === slug)
      ?? pinnedNativeModelRows().find(entry => entry.slug === slug);
    // A pin without the row degrades to Codex's own task-model fallback rather than failing the
    // whole catalog write.
    if (!source) continue;
    const row: RawEntry = structuredClone(source);
    row.visibility = "hide";
    if (wsEnabled) row.supports_websockets = true;
    else {
      delete row.supports_websockets;
      delete row.prefer_websockets;
    }
    models.push(row);
  }
  return models;
}
