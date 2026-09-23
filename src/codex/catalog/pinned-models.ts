import upstreamModelsSnapshot from "../data/upstream-models.json";
import rosterPinnedModels from "../data/roster-pinned-models.json";

/**
 * Every native row this build pins, in one list: the codex-rs bundled snapshot first, then the
 * rows captured from a live authenticated `/models` roster that the snapshot does not carry.
 *
 * Two files rather than one on purpose. `upstream-models.json` is re-pinned wholesale from the
 * codex-rs bundled catalog, and a hand-merged row inside it would be erased (or conflict) on the
 * next refresh. `roster-pinned-models.json` holds rows upstream serves but codex-rs has not
 * bundled yet — `gpt-6-sol` and `gpt-6-luna`, captured from
 * `chatgpt.com/backend-api/codex/models?client_version=0.155.0` on 2026-09-23, the day after
 * https://openai.com/index/introducing-gpt-6-sol-and-luna/.
 *
 * The snapshot always wins: a roster row is appended only when its slug is absent from the
 * snapshot. Once a codex-rs refresh bundles Sol or Luna, that row takes over automatically and
 * the roster copy goes inert instead of shadowing newer upstream metadata. The roster file can
 * then be emptied at leisure; nothing breaks while it still holds the stale copy.
 */
type PinnedRow = Record<string, unknown> & { slug?: unknown };

function rowsOf(source: unknown): PinnedRow[] {
  const models = (source as { models?: unknown }).models;
  return Array.isArray(models) ? models as PinnedRow[] : [];
}

const PINNED_NATIVE_MODEL_ROWS: ReadonlyArray<PinnedRow> = (() => {
  const snapshot = rowsOf(upstreamModelsSnapshot);
  const snapshotSlugs = new Set(snapshot.flatMap(row => typeof row.slug === "string" ? [row.slug] : []));
  const roster = rowsOf(rosterPinnedModels)
    .filter(row => typeof row.slug === "string" && !snapshotSlugs.has(row.slug));
  return Object.freeze([...snapshot, ...roster]);
})();

export function pinnedNativeModelRows(): ReadonlyArray<PinnedRow> {
  return PINNED_NATIVE_MODEL_ROWS;
}
