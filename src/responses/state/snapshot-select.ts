import type { StoredResponseState } from "../state";

/**
 * Pick the snapshot entries that fit the byte budgets, in `states` order.
 *
 * Bounded stubs and tombstones are selected before residents: they are the
 * only durable references a spill file has, and demotion is oldest-first, so a
 * single newest-first pass would let resident payloads consume the whole
 * budget ahead of them. Residents then fill what remains, newest-first so the
 * most recent chains survive both legacy snapshot caps.
 */
export function selectSnapshotEntries(
  states: ReadonlyMap<string, StoredResponseState>,
  totalMaxBytes: number,
  residentEntryMaxBytes: number,
): Array<[string, unknown]> {
  const ordered = [...states].reverse();
  const persisted = new Map<string, [string, unknown]>();
  let total = 0;
  // UTF-8 bytes, not UTF-16 code units: multibyte items otherwise slip past
  // both snapshot caps at up to 2x the intended size.
  const sizeOf = (entry: [string, unknown]): number => Buffer.byteLength(JSON.stringify(entry), "utf8");
  for (const [id, state] of ordered) {
    if (state.kind === "resident") continue;
    const { sizeBytes: _sizeBytes, ...smallState } = state;
    const entry: [string, unknown] = [id, smallState];
    const size = sizeOf(entry);
    if (total + size > totalMaxBytes) continue;
    total += size;
    persisted.set(id, entry);
  }
  for (const [id, state] of ordered) {
    if (state.kind !== "resident") continue;
    const { sizeBytes: _sizeBytes, kind: _kind, ...resident } = state;
    const entry: [string, unknown] = [id, resident];
    const size = sizeOf(entry);
    if (size > residentEntryMaxBytes) continue;
    if (total + size > totalMaxBytes) break;
    total += size;
    persisted.set(id, entry);
  }
  // Emit in map order so reload and count eviction keep the same relative order as `states`.
  const entries: Array<[string, unknown]> = [];
  for (const [id] of states) {
    const kept = persisted.get(id);
    if (kept) entries.push(kept);
  }
  return entries;
}
