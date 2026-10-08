import { CODEX_INTERNAL_OPENAI_MODELS, isCodexControlPlaneModel } from "../control-plane-models";
import { pinnedNativeModelRows } from "./pinned-models";
import type { RawEntry } from "./parsing";

/** Keep internal reviewer metadata separate from native synthesis, picker ordering and account clones. */
export function withCodexControlPlaneRows(
  entries: RawEntry[],
  sourceRows: readonly RawEntry[],
  includeNativeOpenAi: boolean,
  wsEnabled: boolean,
): RawEntry[] {
  const models = entries.filter(entry => !isCodexControlPlaneModel(entry.slug));
  if (!includeNativeOpenAi) return models;
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
