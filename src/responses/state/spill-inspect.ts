import { readFileSync, statSync } from "node:fs";
import type { ResponseSpillRef } from "../spill-store";
import type { StoredResponseState } from "../state";

/**
 * File names still owned by the in-memory store: live "spill" stubs plus
 * superseded generations queued for unlink only after a durable snapshot
 * (pendingSpillUnlinks — see replaceSpillEntryAtomically in state.ts).
 */
export function collectReferencedSpillFileNames(
  states: Iterable<StoredResponseState>,
  pendingUnlinks: Iterable<ResponseSpillRef>,
): Set<string> {
  const referenced = new Set<string>();
  for (const state of states) {
    if (state.kind === "spill") referenced.add(state.spill.fileName);
  }
  for (const ref of pendingUnlinks) referenced.add(ref.fileName);
  return referenced;
}

/**
 * File names a restart would re-own: "spill" stubs inside the persisted
 * snapshot. This is the only ownership evidence a separate process (ocx
 * doctor) can see, and it stays authoritative in-process too — a restart
 * reloads the snapshot before the store drops anything from it.
 */
export function snapshotReferencedSpillFileNames(path: string, maxBytes: number): Set<string> {
  const referenced = new Set<string>();
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return referenced;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.states)) return referenced;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const value = entry[1] as { kind?: unknown; spill?: { fileName?: unknown } };
      if (value?.kind === "spill" && typeof value.spill?.fileName === "string") {
        referenced.add(value.spill.fileName);
      }
    }
  } catch {
    /* missing or corrupt snapshot: nothing is referenced */
  }
  return referenced;
}
