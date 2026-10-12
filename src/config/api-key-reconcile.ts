type KeyRecord = Record<string, unknown> & { id: string };

function index(value: unknown): Map<string, KeyRecord> | null {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) return null;
  const rows = new Map<string, KeyRecord>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id || rows.has(row.id)) return null;
    rows.set(row.id, row);
  }
  return rows;
}

/** Stable-ID three-way merge: either side's revocation defeats stale edits to that ID. */
export function reconcileApiKeys(
  baseline: unknown, live: unknown, persisted: unknown,
  mergeRecord: (live: Record<string, unknown>, baseline: Record<string, unknown>, persisted: Record<string, unknown>) => void,
): unknown[] | null {
  if (baseline === undefined && live === undefined && persisted === undefined) return null;
  const before = index(baseline), pending = index(live), disk = index(persisted);
  if (!before || !pending || !disk) return null;
  const merged: KeyRecord[] = [];
  const liveOrder = [...pending.keys()], diskOrder = [...disk.keys()];
  const order = JSON.stringify(liveOrder) === JSON.stringify([...before.keys()])
    ? [...diskOrder, ...liveOrder] : [...liveOrder, ...diskOrder];
  for (const id of new Set(order)) {
    const local = pending.get(id), saved = disk.get(id);
    if (before.has(id) && (!local || !saved)) continue;
    const row = structuredClone(local ?? saved!);
    if (local && saved) mergeRecord(row, before.get(id) ?? {}, saved);
    merged.push(row);
  }
  return merged;
}
